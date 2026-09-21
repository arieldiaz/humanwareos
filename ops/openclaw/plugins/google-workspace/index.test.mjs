import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import test from "node:test";
import plugin, {GOOGLE_SCOPES, GoogleWorkspaceClient, runTokenCommand} from "./index.js";

function fakeSpawn({stdout = "", stderr = "", code = 0, inspectInput} = {}) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = "";
    child.stdin = {end(value) { input += value || ""; inspectInput?.({args, input}); queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    }); }};
    return child;
  };
}

test("registers authorization, status, and survey tools", () => {
  const tools = [];
  plugin.register({pluginConfig: {}, registerTool: (tool) => tools.push(tool)});
  assert.deepEqual(tools.map(({name}) => name), ["google_workspace_authorize", "google_workspace_auth_status", "google_workspace_create_survey"]);
});

test("uses only scopes required by the Apps Script implementation", () => {
  assert.deepEqual(GOOGLE_SCOPES, ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/forms", "https://www.googleapis.com/auth/spreadsheets"]);
});

test("passes refresh tokens to protected storage on stdin", async () => {
  let observed;
  const output = await runTokenCommand(["secret-bridge", "google-workspace"], "put", "refresh-token", fakeSpawn({stdout: "ok\n", inspectInput: (value) => { observed = value; }}));
  assert.equal(output, "ok");
  assert.deepEqual(observed, {args: ["google-workspace", "put"], input: "refresh-token"});
});

test("refreshes access and invokes configured Apps Script deployment", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({url, options});
    if (url.includes("oauth2.googleapis.com")) return {ok: true, json: async () => ({access_token: "access-token"})};
    return {ok: true, json: async () => ({response: {result: {formId: "form", spreadsheetId: "sheet"}}})};
  };
  const client = new GoogleWorkspaceClient({clientIdEnv: "CLIENT_ID", clientSecretEnv: "CLIENT_SECRET", tokenCommand: ["secret-bridge"], scriptDeploymentId: "deployment"}, {env: {CLIENT_ID: "client", CLIENT_SECRET: "secret"}, fetchImpl, spawnImpl: fakeSpawn({stdout: "refresh-token\n"})});
  assert.deepEqual(await client.createSurvey({title: "Parent survey", questions: [{type: "text", title: "Name"}]}), {formId: "form", spreadsheetId: "sheet"});
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://script.googleapis.com/v1/scripts/deployment:run");
  assert.equal(requests[1].options.headers.authorization, "Bearer access-token");
});

test("fails closed when protected credentials are absent", async () => {
  const client = new GoogleWorkspaceClient({clientIdEnv: "CLIENT_ID", clientSecretEnv: "CLIENT_SECRET", tokenCommand: ["secret-bridge"], scriptDeploymentId: "deployment"}, {env: {}, spawnImpl: fakeSpawn({stdout: "refresh-token\n"})});
  await assert.rejects(client.accessToken(), /CLIENT_ID is not available/);
});
