import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-slack-response-reliability.mjs", import.meta.url));

function fixtureDist() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-response-reliability-"));
  fs.writeFileSync(path.join(dist, "main-session-recovery-lifecycle-fixture.js"), `function project(params) {\n\tconst runId = params.event.runId?.trim();\n\tconst lifecycleGeneration = params.event.lifecycleGeneration?.trim();\n\tconst runs = params.entry?.restartRecoveryRuns;\n\tconst matchesFence = Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));\n\tconst remaining = matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;\n\treturn {matchesFence, remaining};\n}`);
  fs.writeFileSync(path.join(dist, "ingress-retry-policy-fixture.js"), `function policy(params) {\n\tconst { maxAttempts } = resolveConfig(params.config);\n\tconst attempt = resolveIngressAttemptNumber(params.event);\n\tconst message = params.formatError(params.err);\n\tconst now = params.now ?? Date.now();\n\tif (attempt >= maxAttempts && isSessionStartConflictFailure(params.err)) return {\n\t\tkind: "fail",\n\t\treason: "session-start-conflict-retry-limit",\n\t\tmessage,\n\t\tattempt\n\t};\n}`);
  fs.writeFileSync(path.join(dist, "ingress-queue-fixture.js"), `//#region src/channels/message/ingress-queue.ts\nfunction save(payload) { return {\n\t\t\t\tpayload_json: JSON.stringify(payload),\n}; }`);
  fs.writeFileSync(path.join(dist, "dead-letters-fixture.js"), `//#region src/cli/channels-dead-letters.ts\nasync function list(queue, options) {\n\tconst deadLetters = await queue.listFailed({ limit: parseLimit(options.limit) });\n\treturn deadLetters;\n}\nasync function resubmit(queue, options, runtime) {\n\tconst channelId = "slack";\n\tconst accountId = "max";\n\tconst eventId = "event-1";\n\tconst result = await queue.resubmit(eventId);\n\tif (result.kind === "resubmitted") {\n\t\tif (options.json) writeRuntimeJson(runtime, {\n\t\t\tchannelId,\n\t\t\taccountId,\n\t\t\teventId,\n\t\t\tresult\n\t\t});\n\t\treturn;\n\t}\n}`);
  return dist;
}

function apply(dist) {
  execFileSync(process.execPath, [patchPath], { env: { ...process.env, OPENCLAW_CORE_DIST: dist }, stdio: "pipe" });
}

test("current-writer terminal evidence overrides stale restart recovery bookkeeping", () => {
  const dist = fixtureDist();
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "main-session-recovery-lifecycle-fixture.js"), "utf8");
  const project = Function(`${source}; return project;`)();
  const result = project({ event: { runId: "current", lifecycleGeneration: "g1" }, currentLifecycleGeneration: "g1", entry: { activeWriterRunId: "current", lifecycleRunId: "current", restartRecoveryRuns: [{ runId: "old", lifecycleGeneration: "g1" }] } });
  assert.equal(result.matchesFence, true);
  assert.deepEqual(result.remaining, []);
});

test("session conflicts are age-gated and ingress secrets are redacted", () => {
  const dist = fixtureDist();
  apply(dist);
  const retry = fs.readFileSync(path.join(dist, "ingress-retry-policy-fixture.js"), "utf8");
  assert.match(retry, /shouldDeadLetterRetryableIngressEvent/);
  const queue = fs.readFileSync(path.join(dist, "ingress-queue-fixture.js"), "utf8");
  const save = Function(`${queue}; return save;`)();
  assert.equal(JSON.parse(save({ body: { token: "secret", text: "hello" } }).payload_json).body.token, "[REDACTED]");
});

test("dead-letter inspection redacts nested secrets without an external helper", async () => {
  const dist = fixtureDist();
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "dead-letters-fixture.js"), "utf8");
  const list = Function("parseLimit", `${source}; return list;`)((value) => value);
  const result = await list({ listFailed: async () => [{ payload: { body: { token: "secret", text: "hello" } } }] }, { limit: 5 });
  assert.equal(result[0].payload.body.token, "[REDACTED]");
  assert.equal(result[0].payload.body.text, "hello");
});

test("dead-letter resubmission redacts both current and previous retained payloads", async () => {
  const dist = fixtureDist();
  apply(dist);
  const source = fs.readFileSync(path.join(dist, "dead-letters-fixture.js"), "utf8");
  const outputs = [];
  const resubmit = Function("writeRuntimeJson", `${source}; return resubmit;`)((_runtime, value) => outputs.push(value));
  await resubmit({ resubmit: async () => ({ kind: "resubmitted", record: { payload: { body: { token: "current-secret", text: "hello" } } }, previous: { payload: { body: { token: "previous-secret" } } } }) }, { json: true }, {});
  assert.equal(outputs[0].result.record.payload.body.token, "[REDACTED]");
  assert.equal(outputs[0].result.record.payload.body.text, "hello");
  assert.equal(outputs[0].result.previous.payload.body.token, "[REDACTED]");
});

test("patch is idempotent", () => {
  const dist = fixtureDist();
  apply(dist);
  const before = fs.readdirSync(dist).map((name) => fs.readFileSync(path.join(dist, name), "utf8"));
  apply(dist);
  const after = fs.readdirSync(dist).map((name) => fs.readFileSync(path.join(dist, name), "utf8"));
  assert.deepEqual(after, before);
});
