import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-slack-response-reliability.mjs", import.meta.url));

function fixtureDist(version = "2026.9.8") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-response-reliability-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "main-session-recovery-lifecycle-fixture.mjs"), `//#region src/agents/main-session-recovery/main-session-recovery-lifecycle.ts\nfunction project(params) {\n\tconst runId = params.event.runId?.trim();\n\tconst lifecycleGeneration = params.event.lifecycleGeneration?.trim();\n\tconst runs = params.entry?.restartRecoveryRuns;\n\tconst matchesFence = Boolean(runId && lifecycleGeneration && runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration));\n\tconst remaining = matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;\n\treturn {matchesFence, remaining};\n}`);
  fs.writeFileSync(path.join(dist, "ingress-drain-fixture.mjs"), `//#region src/channels/message/ingress-retry-policy.ts\nfunction shouldDeadLetterRetryableIngressEvent(event, attempt, config, now) {\n\treturn attempt >= 8 && now - event.receivedAt >= 864e5;\n}\nfunction policy(params) {\n\tconst now = params.now;\n\tconst maxAttempts = 8;\n\tconst attempt = params.event.attempts + 1;\n\tconst errorCodes = new Set(params.codes);\n\tif (attempt >= maxAttempts && errorCodes.has("SESSION_WORK_START_CHANGED")) return {\n\t\tkind: "fail",\n\t\treason: "session-start-conflict-retry-limit",\n\t\tattempt\n\t};\n\treturn { kind: "release" };\n}`);
  fs.writeFileSync(path.join(dist, "ingress-queue-fixture.mjs"), `//#region src/channels/message/ingress-queue.ts\nfunction save(payload) { return {\n\t\t\t\tpayloadJson: JSON.stringify(payload),\n}; }`);
  fs.writeFileSync(path.join(dist, "ingress-queue-client-fixture.mjs"), `export const unrelated = true;`);
  fs.writeFileSync(path.join(dist, "dead-letters-fixture.mjs"), `//#region src/commands/channels/dead-letters.ts\nasync function list(queue, options) {\n\tconst deadLetters = await queue.listFailed({ limit: parseLimit(options.limit) });\n\treturn deadLetters;\n}\nasync function resubmit(queue, options, runtime) {\n\tconst channelId = "slack";\n\tconst accountId = "max";\n\tconst eventId = "event-1";\n\tconst result = await queue.resubmit(eventId);\n\tif (result.kind === "resubmitted") {\n\t\tif (options.json) writeRuntimeJson(runtime, {\n\t\t\tchannelId,\n\t\t\taccountId,\n\t\t\teventId,\n\t\t\tresult\n\t\t});\n\t\treturn;\n\t}\n}`);
  return dist;
}

function apply(dist) {
  return execFileSync(process.execPath, [patchPath], { env: { ...process.env, OPENCLAW_CORE_DIST: dist }, stdio: "pipe" });
}
const load = (dist, file, name, ...deps) => Function(...deps.map(([n]) => n), `${fs.readFileSync(path.join(dist, file), "utf8")}; return ${name};`)(...deps.map(([, v]) => v));

test("current-writer terminal evidence overrides stale restart recovery bookkeeping", () => {
  const dist = fixtureDist();
  apply(dist);
  const project = load(dist, "main-session-recovery-lifecycle-fixture.mjs", "project");
  const result = project({ event: { runId: "current", lifecycleGeneration: "g1" }, currentLifecycleGeneration: "g1", entry: { activeWriterRunId: "current", lifecycleRunId: "current", restartRecoveryRuns: [{ runId: "old", lifecycleGeneration: "g1" }] } });
  assert.equal(result.matchesFence, true);
  assert.deepEqual(result.remaining, []);
  const other = project({ event: { runId: "other", lifecycleGeneration: "g1" }, currentLifecycleGeneration: "g1", entry: { activeWriterRunId: "current", lifecycleRunId: "current", restartRecoveryRuns: [{ runId: "old", lifecycleGeneration: "g1" }] } });
  assert.equal(other.matchesFence, false);
});

test("session-start conflicts keep retrying until the dead-letter age floor", () => {
  const dist = fixtureDist();
  apply(dist);
  const policy = load(dist, "ingress-drain-fixture.mjs", "policy");
  const now = 10 * 864e5;
  const base = { now, codes: ["SESSION_WORK_START_CHANGED"] };
  assert.equal(policy({ ...base, event: { attempts: 7, receivedAt: now - 1000 } }).kind, "release");
  assert.equal(policy({ ...base, event: { attempts: 7, receivedAt: now - 864e5 } }).reason, "session-start-conflict-retry-limit");
});

test("persisted ingress payloads redact credential-shaped fields", () => {
  const dist = fixtureDist();
  apply(dist);
  const save = load(dist, "ingress-queue-fixture.mjs", "save");
  const stored = JSON.parse(save({ body: { token: "secret", text: "hello", nested: [{ Authorization: "x" }] } }).payloadJson);
  assert.equal(stored.body.token, "[REDACTED]");
  assert.equal(stored.body.text, "hello");
  assert.equal(stored.body.nested[0].Authorization, "[REDACTED]");
});

test("dead-letter list and resubmit output redact secrets", async () => {
  const dist = fixtureDist();
  apply(dist);
  const list = load(dist, "dead-letters-fixture.mjs", "list", ["parseLimit", (v) => v], ["writeRuntimeJson", () => {}]);
  const listed = await list({ listFailed: async () => [{ payload: { body: { token: "secret", text: "hello" } } }] }, { limit: 5 });
  assert.equal(listed[0].payload.body.token, "[REDACTED]");
  assert.equal(listed[0].payload.body.text, "hello");
  const outputs = [];
  const resubmit = load(dist, "dead-letters-fixture.mjs", "resubmit", ["parseLimit", (v) => v], ["writeRuntimeJson", (_r, v) => outputs.push(v)]);
  await resubmit({ resubmit: async () => ({ kind: "resubmitted", record: { payload: { body: { token: "a" } } }, previous: { payload: { body: { token: "b" } } } }) }, { json: true }, {});
  assert.equal(outputs[0].result.record.payload.body.token, "[REDACTED]");
  assert.equal(outputs[0].result.previous.payload.body.token, "[REDACTED]");
});

test("patch is idempotent", () => {
  const dist = fixtureDist();
  apply(dist);
  const snap = () => fs.readdirSync(dist).map((name) => fs.readFileSync(path.join(dist, name), "utf8"));
  const before = snap();
  apply(dist);
  assert.deepEqual(snap(), before);
});

test("fails closed on other versions and on missing anchors", () => {
  assert.throws(() => apply(fixtureDist("2026.9.1")));
  const dist = fixtureDist();
  fs.writeFileSync(path.join(dist, "ingress-drain-fixture.mjs"), `//#region src/channels/message/ingress-retry-policy.ts\nfunction policy() {}`);
  assert.throws(() => apply(dist));
});
