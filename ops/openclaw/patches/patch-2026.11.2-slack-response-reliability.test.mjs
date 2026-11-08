import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.11.2-slack-response-reliability.mjs", import.meta.url));

function fixtureDist(version = "2026.11.2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-response-reliability-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version}));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "main-session-recovery-lifecycle-fixture.mjs"), `//#region src/agents/main-session-recovery/main-session-recovery-lifecycle.ts
function inspectMainSessionRecoveryLifecycleEvent(params) {
	const runId = params.event.runId?.trim();
	const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
	const terminal = true;
	const matchesFence = Boolean(runId && lifecycleGeneration && params.entry?.restartRecoveryRuns?.some((run) => run.runId === runId && (run.lifecycleGeneration === lifecycleGeneration || terminal && lifecycleGeneration === params.currentLifecycleGeneration && params.entry?.lifecycleRunId === runId)));
	return {
		runId,
		lifecycleGeneration,
		terminal,
		matchesFence,
		suppress: false,
		interrupted: false
	};
}
function project(params) {
	const { runId, lifecycleGeneration, terminal, matchesFence, suppress, interrupted } = inspectMainSessionRecoveryLifecycleEvent(params);
	const runs = params.entry?.restartRecoveryRuns;
	const remaining = matchesFence ? runs?.filter((run) => run.runId !== runId || lifecycleGeneration !== params.currentLifecycleGeneration && run.lifecycleGeneration !== lifecycleGeneration) : runs;
	return {matchesFence, remaining, terminal, suppress, interrupted};
}`);
  fs.writeFileSync(path.join(dist, "ingress-queue-fixture.mjs"), `//#region src/channels/message/ingress-queue.ts
function save(payload) { return {
			payloadJson: JSON.stringify(payload),
}; }`);
  fs.writeFileSync(path.join(dist, "ingress-queue-client-fixture.mjs"), "export const unrelated = true;");
  fs.writeFileSync(path.join(dist, "dead-letters-fixture.mjs"), `//#region src/commands/channels/dead-letters.ts
async function list(queue, options) {
	const deadLetters = await queue.listFailed({ limit: parseLogsPositiveInt(options.limit ?? void 0, 100, "--limit") });
	return deadLetters;
}
async function resubmit(queue, options, runtime) {
	const channelId = "slack";
	const accountId = "max";
	const eventId = "event-1";
	const result = await queue.resubmit(eventId);
	if (result.kind === "resubmitted") {
		if (options.json) writeRuntimeJson(runtime, {
			channelId,
			accountId,
			eventId,
			result
		});
		return;
	}
}`);
  return dist;
}

function apply(dist) {
  return execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_CORE_DIST: dist}, stdio: "pipe"});
}

const load = (dist, file, name, ...deps) => Function(...deps.map(([dependency]) => dependency), `${fs.readFileSync(path.join(dist, file), "utf8")}; return ${name};`)(...deps.map(([, value]) => value));

test("current-writer terminal evidence overrides stale restart recovery bookkeeping", () => {
  const dist = fixtureDist();
  apply(dist);
  const project = load(dist, "main-session-recovery-lifecycle-fixture.mjs", "project");
  const result = project({event: {runId: "current", lifecycleGeneration: "g1"}, currentLifecycleGeneration: "g1", entry: {activeWriterRunId: "current", lifecycleRunId: "current", restartRecoveryRuns: [{runId: "old", lifecycleGeneration: "g1"}]}});
  assert.equal(result.matchesFence, true);
  assert.deepEqual(result.remaining, []);
  const other = project({event: {runId: "other", lifecycleGeneration: "g1"}, currentLifecycleGeneration: "g1", entry: {activeWriterRunId: "current", lifecycleRunId: "current", restartRecoveryRuns: [{runId: "old", lifecycleGeneration: "g1"}]}});
  assert.equal(other.matchesFence, false);
});

test("persisted ingress payloads redact credential-shaped fields", () => {
  const dist = fixtureDist();
  apply(dist);
  const save = load(dist, "ingress-queue-fixture.mjs", "save");
  const stored = JSON.parse(save({body: {token: "secret", text: "hello", nested: [{Authorization: "x"}]}}).payloadJson);
  assert.equal(stored.body.token, "[REDACTED]");
  assert.equal(stored.body.text, "hello");
  assert.equal(stored.body.nested[0].Authorization, "[REDACTED]");
});

test("dead-letter list and resubmit output redact secrets", async () => {
  const dist = fixtureDist();
  apply(dist);
  const parseLogsPositiveInt = (value) => value;
  const list = load(dist, "dead-letters-fixture.mjs", "list", ["parseLogsPositiveInt", parseLogsPositiveInt], ["writeRuntimeJson", () => {}]);
  const listed = await list({listFailed: async () => [{payload: {body: {token: "secret", text: "hello"}}}]}, {limit: 5});
  assert.equal(listed[0].payload.body.token, "[REDACTED]");
  assert.equal(listed[0].payload.body.text, "hello");
  const outputs = [];
  const resubmit = load(dist, "dead-letters-fixture.mjs", "resubmit", ["parseLogsPositiveInt", parseLogsPositiveInt], ["writeRuntimeJson", (_runtime, value) => outputs.push(value)]);
  await resubmit({resubmit: async () => ({kind: "resubmitted", record: {payload: {body: {token: "a"}}}, previous: {payload: {body: {token: "b"}}}})}, {json: true}, {});
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
  fs.writeFileSync(path.join(dist, "ingress-queue-fixture.mjs"), "//#region src/channels/message/ingress-queue.ts\nfunction save() {}");
  assert.throws(() => apply(dist));
});
