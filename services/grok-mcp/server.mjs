import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toNodeHandler, hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { GrokBridge, validateConfig } from "./bridge.mjs";

const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CONFIG = resolve(RUNTIME_ROOT, "config/services/grok-mcp.json");
const MAX_REQUEST_BYTES = 1_048_576;
const IDENTIFIER = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const CONVERSATION = z.string().min(1).max(512);
const TIMESTAMP = z.string().max(64).refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp").optional();

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function tool(handler) {
  return async (input) => {
    try {
      return result(await handler(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "bridge operation failed";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

export function buildMcpServer(bridge) {
  const server = new McpServer(
    { name: "humanware-grok-bridge", version: "0.1.0" },
    { instructions: "Use only the smallest context needed. Writes are append-only or staged, idempotent by operationId, and never edit current memory or publish artifacts." },
  );

  server.registerTool(
    "get_context",
    {
      description: "Read the configured Tier 2 Humanware strategy and current-context projections. Request only the sections needed for the task.",
      inputSchema: z.object({ sections: z.array(z.string().min(1).max(64)).max(8).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.getContext(input)),
  );

  server.registerTool(
    "record_turn",
    {
      description: "Append one substantive Grok exchange to raw Humanware evidence. Call after a durable decision or meaningful work result, not pleasantries. Reuse operationId on retry.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        userText: z.string().min(1).max(100_000),
        assistantText: z.string().min(1).max(100_000),
        occurredAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.recordTurn(input)),
  );

  server.registerTool(
    "save_work",
    {
      description: "Save a durable draft or result in the Grok integration workspace. This does not promote it to memory or publish it.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(250_000),
        createdAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.saveWork(input)),
  );

  server.registerTool(
    "propose_memory",
    {
      description: "Append a memory proposal as evidence for later human/agent curation. This never edits the current memory projection.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        subject: z.string().min(1).max(300),
        facts: z.array(z.string().min(1).max(10_000)).min(1).max(20),
        sources: z.array(z.string().min(1).max(2_000)).max(20).optional(),
        observedAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.proposeMemory(input)),
  );

  server.registerTool(
    "stage_artifact",
    {
      description: "Stage a safe text artifact candidate for Humanware review. This does not promote or publish the artifact.",
      inputSchema: z.object({
        operationId: IDENTIFIER,
        conversationId: CONVERSATION,
        project: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(500_000),
        createdAt: TIMESTAMP,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool((input) => bridge.stageArtifact(input)),
  );
  return server;
}

function secureEqual(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signedToken(claims, signingKey) {
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySignedToken(value, signingKey, type) {
  if (typeof value !== "string") return false;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return false;
  const expected = createHmac("sha256", signingKey).update(payload).digest("base64url");
  if (!secureEqual(signature, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims.typ === type && claims.aud === "humanware-grok-mcp" && Number.isInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) ? claims : false;
  } catch {
    return false;
  }
}

function authorized(req, staticToken) {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const value = header.slice(7);
  return secureEqual(value, staticToken) || Boolean(verifySignedToken(value, staticToken, "access"));
}

function html(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formPage(params, error = "") {
  const hidden = [...params.entries()].map(([key, value]) => `<input type="hidden" name="${html(key)}" value="${html(value)}">`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Humanware</title><style>body{font:16px/1.5 system-ui;background:#f5f5f3;color:#171715;margin:0}.card{max-width:440px;margin:10vh auto;padding:32px;background:white;border-radius:18px;box-shadow:0 12px 42px #0002}h1{margin-top:0}label{display:block;font-weight:650;margin:22px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aaa;border-radius:9px;font:inherit}button{margin-top:20px;padding:12px 18px;border:0;border-radius:9px;background:#171715;color:white;font-weight:650}.error{color:#a21b1b}</style></head><body><main class="card"><h1>Authorize Grok</h1><p>Allow Grok to use the bounded Humanware MCP tools.</p>${error ? `<p class="error">${html(error)}</p>` : ""}<form method="post">${hidden}<label for="password">Owner password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Authorize</button></form></main></body></html>`;
}

function text(res, status, body, headers = {}) {
  const content = Buffer.from(body);
  res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Content-Length": String(content.length), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(content);
}

async function readForm(req, maxBytes = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function redirectAllowed(raw, allowedHosts) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    return allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function validateAuthorization(params, oauth) {
  const scope = (params.get("scope") || oauth.scopes.join(" ")).split(/\s+/).filter(Boolean);
  if (params.get("response_type") !== "code" || params.get("client_id") !== oauth.clientId) throw new Error("unsupported OAuth client or response type");
  if (!redirectAllowed(params.get("redirect_uri"), oauth.allowedRedirectHosts)) throw new Error("redirect_uri is not allowed");
  if (!params.get("state")) throw new Error("state is required");
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(params.get("code_challenge") ?? "")) throw new Error("PKCE S256 is required");
  if (scope.some((item) => !oauth.scopes.includes(item))) throw new Error("unsupported scope");
  return scope;
}

function json(res, status, body, headers = {}) {
  const content = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(content.length),
    ...headers,
  });
  res.end(content);
}

export function createBridgeHttpServer({ config, dataRoot, token, ownerPassword }) {
  validateConfig(config);
  if (!dataRoot || !resolve(dataRoot).startsWith("/")) throw new Error("HUMANWARE_DATA_ROOT must be absolute");
  if (!token || token.length < 32) throw new Error("GROK_MCP_TOKEN must contain at least 32 characters");
  if (config.oauth && (!ownerPassword || ownerPassword.length < 16)) throw new Error("GROK_MCP_OWNER_PASSWORD must contain at least 16 characters");
  const bridge = new GrokBridge({ config, dataRoot });
  const handler = createMcpHandler(() => buildMcpServer(bridge));
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MAX_REQUEST_BYTES });
  const publicHost = new URL(config.publicOrigin).hostname;
  const validateHost = hostHeaderValidation([publicHost, "localhost", "127.0.0.1", "[::1]"]);
  const validateOrigin = originValidation([publicHost, "localhost", "127.0.0.1", "[::1]"]);
  const codes = new Map();
  const oauth = config.oauth;
  const issuer = config.publicOrigin.replace(/\/$/, "");
  const authorizationEndpoint = oauth ? `${issuer}${oauth.authorizePath}` : null;
  const tokenEndpoint = oauth ? `${issuer}${oauth.tokenPath}` : null;
  const protectedMetadataPath = `/.well-known/oauth-protected-resource${config.mountPath}`;

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health" && req.method === "GET") {
      try {
        json(res, 200, await bridge.health());
      } catch {
        json(res, 503, { status: "unavailable" });
      }
      return;
    }
    if (!validateHost(req, res)) return;
    if (oauth && path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      json(res, 200, { issuer, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: oauth.scopes });
      return;
    }
    if (oauth && path === protectedMetadataPath && req.method === "GET") {
      json(res, 200, { resource: `${issuer}${config.mountPath}`, authorization_servers: [issuer], scopes_supported: oauth.scopes, bearer_methods_supported: ["header"] });
      return;
    }
    if (oauth && path === oauth.authorizePath && req.method === "GET") {
      const params = new URL(req.url ?? oauth.authorizePath, "http://localhost").searchParams;
      try {
        validateAuthorization(params, oauth);
        text(res, 200, formPage(params));
      } catch (error) {
        text(res, 400, formPage(params, error instanceof Error ? error.message : "invalid authorization request"));
      }
      return;
    }
    if (oauth && path === oauth.authorizePath && req.method === "POST") {
      try {
        const params = await readForm(req);
        const scope = validateAuthorization(params, oauth);
        if (!secureEqual(params.get("password") ?? "", ownerPassword)) {
          params.delete("password");
          text(res, 401, formPage(params, "Incorrect owner password"));
          return;
        }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { clientId: oauth.clientId, redirectUri: params.get("redirect_uri"), codeChallenge: params.get("code_challenge"), scope, expires: Date.now() + 300_000 });
        const callback = new URL(params.get("redirect_uri"));
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", params.get("state"));
        res.writeHead(302, { "Cache-Control": "no-store", Location: callback.toString() });
        res.end();
      } catch (error) {
        text(res, 400, formPage(new URLSearchParams(), error instanceof Error ? error.message : "authorization failed"));
      }
      return;
    }
    if (oauth && path === oauth.tokenPath && req.method === "POST") {
      try {
        const params = await readForm(req);
        if (params.get("client_id") !== oauth.clientId) throw new Error("invalid_client");
        const now = Math.floor(Date.now() / 1000);
        let scope;
        if (params.get("grant_type") === "authorization_code") {
          const codeValue = params.get("code");
          const entry = codes.get(codeValue);
          codes.delete(codeValue);
          if (!entry || entry.expires < Date.now() || entry.redirectUri !== params.get("redirect_uri")) throw new Error("invalid_grant");
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!secureEqual(challenge, entry.codeChallenge)) throw new Error("invalid_grant");
          scope = entry.scope;
        } else if (params.get("grant_type") === "refresh_token") {
          const claims = verifySignedToken(params.get("refresh_token"), token, "refresh");
          if (!claims) throw new Error("invalid_grant");
          scope = claims.scope;
        } else {
          throw new Error("unsupported_grant_type");
        }
        const accessToken = signedToken({ typ: "access", aud: "humanware-grok-mcp", scope, exp: now + 3600 }, token);
        const refreshToken = signedToken({ typ: "refresh", aud: "humanware-grok-mcp", scope, exp: now + 15_552_000 }, token);
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope: scope.join(" ") });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
      }
      return;
    }
    if (path !== config.mountPath) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (!validateOrigin(req, res)) return;
    if (!authorized(req, token)) {
      const metadata = oauth ? `, resource_metadata="${issuer}${protectedMetadataPath}"` : "";
      json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": `Bearer realm="humanware-grok-mcp"${metadata}` });
      return;
    }
    try {
      await nodeHandler(req, res);
    } catch (error) {
      console.error(`grok-mcp request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (!res.headersSent) json(res, 500, { error: "request failed" });
      else res.end();
    }
  });
  server.on("close", () => void handler.close());
  return server;
}

export async function loadRuntime() {
  const configPath = process.env.GROK_MCP_CONFIG_PATH || DEFAULT_CONFIG;
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  const dataRoot = process.env.HUMANWARE_DATA_ROOT;
  const token = process.env.GROK_MCP_TOKEN;
  const ownerPassword = process.env.GROK_MCP_OWNER_PASSWORD;
  return { config, dataRoot, token, ownerPassword };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = await loadRuntime();
  const [host, rawPort] = runtime.config.listen.split(":");
  const server = createBridgeHttpServer(runtime);
  server.listen(Number(rawPort), host, () => console.error(`grok-mcp listening on ${runtime.config.listen}`));
}
