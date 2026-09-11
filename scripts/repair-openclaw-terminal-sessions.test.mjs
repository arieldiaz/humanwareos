import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./repair-openclaw-terminal-sessions.mjs", import.meta.url));

function fixture() {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-session-repair-"));
  const agent = path.join(state, "agents", "max", "agent");
  fs.mkdirSync(agent, { recursive: true });
  const databasePath = path.join(agent, "openclaw-agent.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, entry_valid INTEGER, updated_at INTEGER, status TEXT); CREATE TABLE trajectory_runtime_events(session_id TEXT, seq INTEGER, run_id TEXT, event_json TEXT, created_at INTEGER, PRIMARY KEY(session_id, seq));");
  const entry = { status: "running", startedAt: 1_000, activeWriterRunId: "run-current", lifecycleRunId: "run-current", restartRecoveryRuns: [{ runId: "run-old" }], mainRestartRecovery: { revision: 7 } };
  database.prepare("INSERT INTO session_nodes VALUES (?, ?, ?, 1, 1000, 'running')").run("agent:max:slack:channel:C1:thread:1.1", "session-1", JSON.stringify(entry));
  database.prepare("INSERT INTO trajectory_runtime_events VALUES (?, ?, ?, ?, ?)").run("session-1", 1, "run-current", JSON.stringify({ type: "session.ended", ts: "1970-01-01T00:00:02.500Z", data: { status: "success" } }), 2_500);
  database.close();
  return { state, databasePath };
}

function run(state, args = []) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], { env: { ...process.env, OPENCLAW_STATE_DIR: state }, encoding: "utf8" }));
}

test("preview identifies but does not mutate a terminal running row", () => {
  const { state, databasePath } = fixture();
  assert.equal(run(state).repairs.length, 1);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare("SELECT status FROM session_nodes").get().status, "running");
  database.close();
});

test("apply closes a terminal running row and clears stale ownership", () => {
  const { state, databasePath } = fixture();
  assert.equal(run(state, ["--apply", "--session-key", "agent:max:slack:channel:C1:thread:1.1"]).repairs.length, 1);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database.prepare("SELECT status, entry_json FROM session_nodes").get();
  const entry = JSON.parse(row.entry_json);
  assert.equal(row.status, "done");
  assert.equal(entry.endedAt, 2_500);
  assert.equal(entry.runtimeMs, 1_500);
  assert.equal(entry.lastRunId, "run-current");
  assert.equal(entry.lifecycleRunId, undefined);
  assert.equal(entry.activeWriterRunId, undefined);
  assert.equal(entry.mainRestartRecovery, undefined);
  database.close();
});

test("apply refuses an unscoped database mutation", () => {
  const { state } = fixture();
  assert.throws(() => run(state, ["--apply"]), /--apply requires at least one explicit --session-key/);
});
