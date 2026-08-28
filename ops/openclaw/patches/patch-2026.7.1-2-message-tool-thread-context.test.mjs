import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-2-message-tool-thread-context.mjs", import.meta.url));

const unpatchedFixture = `function stringifyRouteThreadId(value) {
\treturn String(value);
}
function createMessageTool(options) {
\tconst effectiveCurrentChannel = { currentThreadTs: options?.effectiveCurrentThreadTs };
\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs);
\treturn currentThreadTs;
}`;

const gatewayFixture = `function callMessageGateway(params) {
\treturn params;
}
function sendMessage(params) {
\treturn callMessageGateway({
\t\tgateway: params.gateway,
\t\tmethod: "send",
\t\tparams: {
\t\t\tthreadId: params.threadId != null ? String(params.threadId) : params.topLevel === true ? "" : void 0,
\t\t}
\t});
}`;

const messageActionFixture = `async function sendMessage(params) {
\treturn params;
}
async function sendCoreMessage(params) {
\treturn await sendMessage({
\t\treplyToId: params.replyToId,
\t\tthreadId: params.threadId,
\t\tgifPlayback: params.gifPlayback,
\t});
}
async function runMessageAction(params, resolvedReplyToId, resolvedThreadId) {
\treturn await sendCoreMessage({
\t\treplyToId: resolvedReplyToId ?? void 0,
\t\tthreadId: resolvedThreadId ?? void 0
\t});
}`;

const sendFixture = `function normalizeOptionalString(value) {
\treturn typeof value === "string" && value.trim() ? value.trim() : undefined;
}
async function routeAndDeliver(request, providedSessionKey, derivedRoute) {
\t\tconst threadId = normalizeOptionalString(request.threadId);
\tconst routeInput = {
\t\t\t\t\t\tcurrentSessionKey: providedSessionKey,
\t};
\tconst delivery = {
\t\t\t\t\t\tthreadId: outboundRoute?.threadId ?? threadId ?? null,
\t};
\t\t\t\t\tconst outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
\treturn { routeInput, delivery, outboundSessionKey };
}`;

const schemaFixture = `const Type = {
\tOptional: (value) => value,
\tString: () => "string",
\tBoolean: () => "boolean",
};
const SendParamsSchema = Type.Object({
\t/** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
\tthreadId: Type.Optional(Type.String()),
});`;

function runPatch(source) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-message-thread-patch-"));
  const bundle = path.join(distDir, "openclaw-tools-fixture.js");
  fs.writeFileSync(bundle, source);
  execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_DIST_DIR: distDir },
    stdio: "pipe",
  });
  return fs.readFileSync(bundle, "utf8");
}

function runBundlePatch(filename, source) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-message-thread-patch-"));
  fs.writeFileSync(path.join(distDir, "openclaw-tools-fixture.js"), unpatchedFixture);
  const bundle = path.join(distDir, filename);
  fs.writeFileSync(bundle, source);
  execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_DIST_DIR: distDir },
    stdio: "pipe",
  });
  return fs.readFileSync(bundle, "utf8");
}

function loadCreateMessageTool(source) {
  return Function(`${source}\nreturn createMessageTool;`)();
}

test("Slack thread session keys supply the missing message-tool thread context", () => {
  const patched = runPatch(unpatchedFixture);
  const createMessageTool = loadCreateMessageTool(patched);
  assert.equal(
    createMessageTool({ agentSessionKey: "agent:max:slack:channel:C0BJPDTAGEP:thread:1787655535.470449" }),
    "1787655535.470449",
  );
  assert.equal(
    createMessageTool({ agentSessionKey: "agent:liv:slack:group:G123:thread:1787656000.000001" }),
    "1787656000.000001",
  );
});

test("explicit thread context keeps precedence over the session-key fallback", () => {
  const createMessageTool = loadCreateMessageTool(runPatch(unpatchedFixture));
  const session = "agent:max:slack:channel:C123:thread:111.222";
  assert.equal(createMessageTool({ agentSessionKey: session, currentThreadTs: "333.444" }), "333.444");
  assert.equal(createMessageTool({ agentSessionKey: session, agentThreadId: "555.666" }), "555.666");
  assert.equal(createMessageTool({ agentSessionKey: session, effectiveCurrentThreadTs: "777.888" }), "777.888");
});

test("non-Slack and non-thread session keys do not invent thread context", () => {
  const createMessageTool = loadCreateMessageTool(runPatch(unpatchedFixture));
  assert.equal(createMessageTool({ agentSessionKey: "agent:max:discord:channel:C123:thread:111.222" }), undefined);
  assert.equal(createMessageTool({ agentSessionKey: "agent:max:slack:channel:C123" }), undefined);
});

test("patch is idempotent", () => {
  const once = runPatch(unpatchedFixture);
  const twice = runPatch(once);
  assert.equal(twice, once);
});

test("topLevel crosses the message-to-gateway boundary as typed state", () => {
  const patched = runBundlePatch("message-fixture.js", gatewayFixture);
  const sendMessage = Function(`${patched}\nreturn sendMessage;`)();
  assert.equal(sendMessage({ topLevel: true }).params.topLevel, true);
  assert.equal(sendMessage({ topLevel: true }).params.threadId, undefined);
});

test("topLevel crosses the message action's final send hop", async () => {
  const patched = runBundlePatch("message-action-runner-fixture.js", messageActionFixture);
  const runMessageAction = Function(`${patched}\nreturn runMessageAction;`)();
  assert.equal((await runMessageAction({ topLevel: true })).topLevel, true);
});

test("gateway topLevel suppresses session-derived routing and delivery threads", () => {
  const patched = runBundlePatch("send-fixture.js", sendFixture);
  assert.match(patched, /const topLevel = request\.topLevel === true;/);
  assert.match(patched, /currentSessionKey: topLevel \? void 0 : providedSessionKey/);
  assert.match(patched, /threadId: topLevel \? null : outboundRoute\?\.threadId \?\? threadId \?\? null/);
  assert.match(patched, /const outboundSessionKey = topLevel \? outboundRoute\?\.sessionKey : outboundRoute\?\.sessionKey \?\? providedSessionKey/);
});

test("gateway send schema accepts topLevel", () => {
  const patched = runBundlePatch("schema-fixture.js", schemaFixture);
  assert.match(patched, /topLevel: Type\.Optional\(Type\.Boolean\(\)\)/);
});
