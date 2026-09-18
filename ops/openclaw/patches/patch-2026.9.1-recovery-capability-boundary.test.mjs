import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-recovery-capability-boundary.mjs", import.meta.url));

function fixtureSource() {
  return `const TOMBSTONED_SESSION_NOTICE = "I couldn't continue this session after a gateway restart. Your transcript is safe. In WebChat, use Resume in new session to continue it; in other channels, use /new or /reset to start a replacement session.";
async function recoverStore(params) {
\tconst result = {started: 0, settled: 0, failed: 0, skipped: 0};
\tconst agentId = "liv";
\tconst sessionKey = "agent:liv:slack:thread:1";
\tconst dispatchSessionKey = sessionKey;
\tconst resumeDedupeKey = sessionKey;
\tconst recoveryView = {observation: {cycleId: "cycle-1", revision: 1}, nextAttempt: 1};
\tconst stopped = () => false;
\tconst recordResumeResult = () => {};
\tfor (const entry of params.entries) {
\t\tconst expectedRecoverySourceRunId = normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId);
\t\tconst resumeCurrent = async () => {
\t\t\tawait params.gatewayRuntime.dispatchAgent({requestedMutation: "write operations/control/restart-approval.json and start deployment"});
\t\t\trecordResumeResult(expectedRecoverySourceRunId);
\t\t};
\t\tconst pendingAction = entry.pendingFinalDelivery ? pendingFinalRecoveryAction(entry.pendingFinalDelivery, params.stateDir) : void 0;
\t\tif (pendingAction === "defer") {
\t\t\tresult.skipped++;
\t\t\tcontinue;
\t\t}
\t\tawait resumeCurrent({forceRestartSafeTools: false});
\t}
\treturn result;
}
//#endregion
//#region src/agents/main-session-recovery/main-session-restart-recovery-runtime.ts
function runRecoveryRetries() {}
`;
}

function fixtureDist() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-boundary-"));
  fs.writeFileSync(path.join(dist, "main-session-restart-recovery-fixture.js"), fixtureSource());
  return dist;
}

function apply(dist) {
  execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_CORE_DIST: dist}, stdio: "pipe"});
}

function loadPatchedRuntime(dist, overrides = {}) {
  const source = fs.readFileSync(path.join(dist, "main-session-restart-recovery-fixture.js"), "utf8");
  const calls = {completed: [], handoffs: [], sends: [], warnings: []};
  const dependencies = {
    normalizeOptionalString: (value) => typeof value === "string" && value.trim() ? value.trim() : undefined,
    pendingFinalRecoveryAction: (pending) => pending.action,
    markSessionCompletedAfterRecoveryCheckpoint: async (params) => {
      calls.completed.push(params);
      return {outcome: "completed"};
    },
    completePendingFinalRecoveryWithNotice: async () => true,
    normalizeDeliveryContext: (value) => value && typeof value === "object" ? value : undefined,
    deliveryContextFromSession: (entry) => entry.origin,
    isDeliverableMessageChannel: (channel) => channel === "slack",
    resolveSendPolicy: () => "allow",
    tombstoneMainRestartRecoveryWithNotice: async (params) => {
      calls.handoffs.push(params);
      return "tombstoned";
    },
    mainSessionRecoveryLog: {warn: (message) => calls.warnings.push(message)},
    ...overrides,
  };
  const names = Object.keys(dependencies);
  const recoverStore = Function(...names, `${source}; return recoverStore;`)(...names.map((name) => dependencies[name]));
  return {calls, recoverStore, source};
}

function baseParams(entry, calls) {
  return {
    entries: [entry],
    cfg: {},
    handledSessionKeys: new Set(),
    storePath: "/tmp/sessions.db",
    gatewayRuntime: {
      dispatchAgent: async () => assert.fail("recovery must not dispatch an agent or harness"),
      sendRecoveryNotice: async (payload) => calls.sends.push(payload),
    },
  };
}

test("uncertain restart recovery requires a fresh human event without invoking a harness", async () => {
  const dist = fixtureDist();
  apply(dist);
  const runtime = loadPatchedRuntime(dist);
  const result = await runtime.recoverStore(baseParams({sessionId: "session-1"}, runtime.calls));
  assert.equal(result.skipped, 1);
  assert.equal(runtime.calls.handoffs.length, 1);
  assert.match(runtime.calls.handoffs[0].reason, /^needs_human_reauthorization:/);
  assert.equal(runtime.calls.sends.length, 0);
});

test("delivery-only recovery sends the exact recorded payload to the exact origin", async () => {
  const dist = fixtureDist();
  apply(dist);
  const runtime = loadPatchedRuntime(dist);
  const origin = {channel: "slack", to: "C123", accountId: "liv", threadId: "171.1"};
  const entry = {
    sessionId: "session-1",
    origin,
    pendingFinalDelivery: {kind: "replayable", action: "retry", text: "Canonical final response", intentId: "intent-1", context: {...origin}},
  };
  const result = await runtime.recoverStore(baseParams(entry, runtime.calls));
  assert.equal(result.settled, 1);
  assert.deepEqual(runtime.calls.sends, [{...origin, text: "Canonical final response", idempotencyKey: "intent-1"}]);
  assert.equal(runtime.calls.completed[0].pendingFinalDeliveryIntentId, "intent-1");
  assert.equal(runtime.calls.handoffs.length, 0);
});

test("delivery-only recovery fails closed when the recorded destination differs from the origin", async () => {
  const dist = fixtureDist();
  apply(dist);
  const runtime = loadPatchedRuntime(dist);
  const origin = {channel: "slack", to: "C123", accountId: "liv", threadId: "171.1"};
  const entry = {
    sessionId: "session-1",
    origin,
    pendingFinalDelivery: {kind: "replayable", action: "retry", text: "Canonical final response", intentId: "intent-1", context: {...origin, threadId: "999.9"}},
  };
  const result = await runtime.recoverStore(baseParams(entry, runtime.calls));
  assert.equal(result.skipped, 1);
  assert.equal(runtime.calls.sends.length, 0);
  assert.equal(runtime.calls.handoffs.length, 1);
});

test("confirmed delivery settles without redispatch or duplicate output", async () => {
  const dist = fixtureDist();
  apply(dist);
  const runtime = loadPatchedRuntime(dist);
  const entry = {sessionId: "session-1", pendingFinalDelivery: {action: "complete", intentId: "intent-1"}};
  const result = await runtime.recoverStore(baseParams(entry, runtime.calls));
  assert.equal(result.settled, 1);
  assert.equal(runtime.calls.sends.length, 0);
  assert.equal(runtime.calls.handoffs.length, 0);
});

test("the installed patch shape removes the incident mutation path and is idempotent", () => {
  const dist = fixtureDist();
  apply(dist);
  const file = path.join(dist, "main-session-restart-recovery-fixture.js");
  const once = fs.readFileSync(file, "utf8");
  assert.match(once, /humanware:restart-recovery-capability-boundary/);
  assert.doesNotMatch(once, /operations\/control\/restart-approval\.json/);
  assert.doesNotMatch(once, /dispatchAgent/);
  assert.match(once, /I paused this work after a gateway restart/);
  apply(dist);
  assert.equal(fs.readFileSync(file, "utf8"), once);
});
