import http from "node:http";
import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/forms", "https://www.googleapis.com/auth/spreadsheets"];
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCRIPT_ENDPOINT = "https://script.googleapis.com/v1/scripts";
const text = (value, isError = false) => ({content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value)}], ...(isError ? {isError: true} : {})});

function requiredEnv(name, env) {
  const value = env[name];
  if (!value) throw new Error(`Google Workspace credential ${name} is not available in the protected runtime environment`);
  return value;
}

export function runTokenCommand(command, operation, input, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command[0], [...command.slice(1), operation], {stdio: ["pipe", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Protected token command ${operation} failed (${code}): ${stderr.trim() || "no diagnostic"}`)));
    child.stdin.end(input ?? "");
  });
}

async function requestJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error?.message || `Google API returned HTTP ${response.status}`);
  return body;
}

export class GoogleWorkspaceClient {
  constructor(config, {env = process.env, fetchImpl = fetch, spawnImpl = spawn, createServer = http.createServer} = {}) {
    this.config = config;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.createServer = createServer;
    this.pending = null;
  }
  credentials() {
    return {clientId: requiredEnv(this.config.clientIdEnv, this.env), clientSecret: requiredEnv(this.config.clientSecretEnv, this.env)};
  }
  redirectUri() {
    return `http://127.0.0.1:${this.config.oauthPort ?? 53682}/oauth2/callback`;
  }
  async authorize() {
    if (this.pending && !this.pending.done) throw new Error("Google authorization is already waiting for consent");
    const {clientId} = this.credentials();
    const state = randomBytes(24).toString("base64url");
    const url = new URL(AUTH_ENDPOINT);
    Object.entries({client_id: clientId, redirect_uri: this.redirectUri(), response_type: "code", access_type: "offline", prompt: "consent", scope: GOOGLE_SCOPES.join(" "), state}).forEach(([key, value]) => url.searchParams.set(key, value));
    const server = this.createServer(async (request, response) => {
      const callback = new URL(request.url, this.redirectUri());
      if (callback.pathname !== "/oauth2/callback" || callback.searchParams.get("state") !== state) {
        response.writeHead(400, {"content-type": "text/plain"});
        response.end("Invalid OAuth callback.");
        return;
      }
      try {
        const code = callback.searchParams.get("code");
        if (!code) throw new Error(callback.searchParams.get("error") || "Google did not return an authorization code");
        await this.exchangeCode(code);
        response.writeHead(200, {"content-type": "text/plain"});
        response.end("Google Workspace authorization complete. You may close this tab.");
      } catch (error) {
        response.writeHead(500, {"content-type": "text/plain"});
        response.end("Google Workspace authorization failed. Return to OpenClaw for the diagnostic.");
        this.pending.error = error;
      } finally {
        server.close();
        this.pending.done = true;
      }
    });
    await new Promise((resolve, reject) => server.once("error", reject).listen(this.config.oauthPort ?? 53682, "127.0.0.1", resolve));
    this.pending = {server, done: false, error: null};
    return url.toString();
  }
  async exchangeCode(code) {
    const {clientId, clientSecret} = this.credentials();
    const body = new URLSearchParams({client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: this.redirectUri()});
    const token = await requestJson(TOKEN_ENDPOINT, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body}, this.fetchImpl);
    if (!token.refresh_token) throw new Error("Google did not issue a refresh token; revoke the prior grant and authorize again");
    await runTokenCommand(this.config.tokenCommand, "put", token.refresh_token, this.spawnImpl);
  }
  async accessToken() {
    const refreshToken = await runTokenCommand(this.config.tokenCommand, "get", undefined, this.spawnImpl);
    if (!refreshToken) throw new Error("Google Workspace is not authorized; run google_workspace_authorize first");
    const {clientId, clientSecret} = this.credentials();
    const body = new URLSearchParams({client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token"});
    const token = await requestJson(TOKEN_ENDPOINT, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body}, this.fetchImpl);
    return token.access_token;
  }
  async authStatus() {
    const pending = this.pending;
    if (pending && !pending.done) return {state: "waiting_for_google"};
    if (pending?.error) return {state: "failed", diagnostic: pending.error.message};
    const refreshToken = await runTokenCommand(this.config.tokenCommand, "get", undefined, this.spawnImpl);
    return {state: refreshToken ? "authorized" : "not_authorized"};
  }
  async createSurvey(survey) {
    const accessToken = await this.accessToken();
    const result = await requestJson(`${SCRIPT_ENDPOINT}/${encodeURIComponent(this.config.scriptDeploymentId)}:run`, {method: "POST", headers: {authorization: `Bearer ${accessToken}`, "content-type": "application/json"}, body: JSON.stringify({function: "createSurvey", parameters: [survey], devMode: false})}, this.fetchImpl);
    if (result.error) throw new Error(result.error.details?.[0]?.errorMessage || result.error.message || "Apps Script execution failed");
    return result.response?.result;
  }
}

export const surveySchema = {
  type: "object",
  required: ["title", "questions"],
  properties: {
    title: {type: "string", minLength: 1},
    description: {type: "string"},
    confirmationMessage: {type: "string"},
    spreadsheetTitle: {type: "string"},
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: {type: "string", enum: ["section", "text", "paragraph", "multipleChoice", "checkbox", "scale"]},
          id: {type: "string", minLength: 1},
          title: {type: "string", minLength: 1},
          helpText: {type: "string"},
          required: {type: "boolean"},
          choices: {
            type: "array",
            items: {
              oneOf: [
                {type: "string"},
                {
                  type: "object",
                  required: ["label", "goToSection"],
                  properties: {
                    label: {type: "string", minLength: 1},
                    goToSection: {type: "string", minLength: 1},
                  },
                  additionalProperties: false,
                },
              ],
            },
          },
          maxSelections: {type: "integer", minimum: 1},
          allowOther: {type: "boolean"},
          lower: {type: "integer", minimum: 0, maximum: 10},
          upper: {type: "integer", minimum: 1, maximum: 10},
          lowerLabel: {type: "string"},
          upperLabel: {type: "string"},
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export default {id: "google-workspace", register(api) {
  const client = new GoogleWorkspaceClient(api.pluginConfig);
  api.registerTool({name: "google_workspace_authorize", description: "Start Google Workspace authorization. Returns a Google consent URL; credentials and authorization codes never enter chat.", parameters: {type: "object", properties: {}, additionalProperties: false}, async execute() { try { return text({consentUrl: await client.authorize(), redirectUri: client.redirectUri()}); } catch (error) { return text(error.message, true); } }});
  api.registerTool({name: "google_workspace_auth_status", description: "Check whether Google Workspace authorization is available in protected storage or a consent flow is still pending.", parameters: {type: "object", properties: {}, additionalProperties: false}, async execute() { try { return text(await client.authStatus()); } catch (error) { return text(error.message, true); } }});
  api.registerTool({name: "google_workspace_create_survey", description: "Create a Google Form and atomically link a new Google Sheets response destination.", parameters: surveySchema, async execute(_id, survey) { try { return text(await client.createSurvey(survey)); } catch (error) { return text(error.message, true); } }});
}};
