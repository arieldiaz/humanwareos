import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createBridgeHttpServer } from "./server.mjs";

const TOKEN = "test-token-with-at-least-thirty-two-characters";
const OWNER_PASSWORD = "test-owner-password-with-enough-entropy";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "humanware-grok-mcp-"));
  await mkdir(join(root, "current/strategy"), { recursive: true });
  await mkdir(join(root, "current/memory"), { recursive: true });
  await writeFile(join(root, "current/strategy/current.md"), "# Strategy\n\nShip the bridge.\n");
  await writeFile(join(root, "current/memory/index.md"), "# Memory\n\nCurrent facts.\n");
  const config = {
    schemaVersion: 1,
    id: "grok-mcp",
    label: "com.example.grok-mcp",
    enabled: true,
    listen: "127.0.0.1:0",
    publicOrigin: "https://grok-mcp.example.com",
    mountPath: "/grok",
    oauth: {
      clientId: "grok-humanware",
      authorizePath: "/oauth/authorize",
      tokenPath: "/oauth/token",
      allowedRedirectHosts: ["grok.com", "x.ai"],
      scopes: ["humanware"],
    },
    contextFiles: [
      { id: "strategy", label: "Strategy", path: "current/strategy/current.md", maxBytes: 1000 },
      { id: "memory", label: "Memory", path: "current/memory/index.md", maxBytes: 1000 },
    ],
    turnRoot: "evidence/sessions/raw/grok-bot",
    workRoot: "working/integrations/grok-bot",
    memoryProposalRoot: "evidence/memory/proposals/grok-bot",
    artifactStageRoot: "working/integrations/grok-bot/artifacts",
  };
  const server = createBridgeHttpServer({ config, dataRoot: root, token: TOKEN, ownerPassword: OWNER_PASSWORD });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = new URL(`http://127.0.0.1:${address.port}${config.mountPath}`);
  return { root, server, url };
}

async function connected(url, token = TOKEN) {
  const client = new Client({ name: "humanware-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

test("supports OAuth authorization code with PKCE for Grok", async (t) => {
  const { server, url } = await fixture();
  t.after(() => server.close());
  const origin = new URL(url).origin;
  const verifier = "oauth-test-verifier-with-at-least-forty-three-characters-123456";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: "grok-humanware", redirect_uri: "https://grok.com/oauth/callback", state: "test-state", code_challenge: challenge, code_challenge_method: "S256", scope: "humanware" });

  const authorize = await fetch(`${origin}/oauth/authorize?${params}`);
  assert.equal(authorize.status, 200);
  assert.match(await authorize.text(), /Authorize Grok/);

  params.set("password", OWNER_PASSWORD);
  const approved = await fetch(`${origin}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "test-state");

  const exchanged = await fetch(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "grok-humanware", redirect_uri: "https://grok.com/oauth/callback", code: callback.searchParams.get("code"), code_verifier: verifier }) });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.refresh_token);

  const client = await connected(url, tokens.access_token);
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 5);
});

test("publishes OAuth metadata and rejects untrusted redirects", async (t) => {
  const { server, url } = await fixture();
  t.after(() => server.close());
  const origin = new URL(url).origin;
  const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then((response) => response.json());
  assert.equal(metadata.token_endpoint, "https://grok-mcp.example.com/oauth/token");
  const rejected = await fetch(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "grok-humanware", redirect_uri: "https://evil.example/callback", state: "state", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
  assert.equal(rejected.status, 400);
});

test("requires bearer auth and exposes five bounded tools", async (t) => {
  const { server, url } = await fixture();
  t.after(() => server.close());
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  assert.equal(response.status, 401);
  const client = await connected(url);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name).sort(), ["get_context", "propose_memory", "record_turn", "save_work", "stage_artifact"]);
});

test("serves MCP only at the configured mount path", async (t) => {
  const { server, url } = await fixture();
  t.after(() => server.close());
  const response = await fetch(new URL("/mcp", url), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  assert.equal(response.status, 404);
});

test("reads only configured context and makes write tools idempotent", async (t) => {
  const { root, server, url } = await fixture();
  t.after(() => server.close());
  const client = await connected(url);
  t.after(() => client.close());

  const context = await client.callTool({ name: "get_context", arguments: { sections: ["strategy"] } });
  assert.equal(context.structuredContent.context.length, 1);
  assert.match(context.structuredContent.context[0].content, /Ship the bridge/);

  const turn = {
    operationId: "turn-1",
    conversationId: "conversation-1",
    userText: "Please build it.",
    assistantText: "Built and verified.",
    occurredAt: "2026-10-19T14:00:00Z",
  };
  const first = await client.callTool({ name: "record_turn", arguments: turn });
  const second = await client.callTool({ name: "record_turn", arguments: turn });
  assert.equal(first.structuredContent.replay, false);
  assert.equal(second.structuredContent.replay, true);
  const stored = JSON.parse(await readFile(join(root, first.structuredContent.location.slice(5)), "utf8"));
  assert.equal(stored.userText, turn.userText);

  const conflict = await client.callTool({ name: "record_turn", arguments: { ...turn, assistantText: "Different" } });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /different input/);
});

test("proposals do not mutate current memory and staged artifacts escape supplied HTML", async (t) => {
  const { root, server, url } = await fixture();
  t.after(() => server.close());
  const client = await connected(url);
  t.after(() => client.close());
  const before = await readFile(join(root, "current/memory/index.md"), "utf8");

  const proposal = await client.callTool({
    name: "propose_memory",
    arguments: { operationId: "memory-1", conversationId: "conversation-1", subject: "Bridge ready", facts: ["The bridge passed tests."], sources: ["https://example.com/pr/1"] },
  });
  assert.equal(proposal.structuredContent.currentMemoryChanged, false);
  assert.equal(await readFile(join(root, "current/memory/index.md"), "utf8"), before);

  const staged = await client.callTool({
    name: "stage_artifact",
    arguments: { operationId: "artifact-1", conversationId: "conversation-1", project: "humanware-os", title: "Bridge <review>", content: "<script>alert(1)</script>" },
  });
  assert.equal(staged.structuredContent.promoted, false);
  const html = await readFile(join(root, staged.structuredContent.location.slice(5), "index.html"), "utf8");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
