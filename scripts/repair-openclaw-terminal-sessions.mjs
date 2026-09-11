#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const apply = process.argv.includes("--apply");
const stateRoot = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
const agentsRoot = path.join(stateRoot, "agents");

function terminalStatus(event) {
  if (event?.type !== "session.ended") return;
  if (event.data?.timedOut === true || event.data?.status === "timeout") return "timeout";
  if (["cancelled", "canceled", "killed"].includes(event.data?.status)) return "killed";
  if (["success", "succeeded", "completed", "ok"].includes(event.data?.status)) return "done";
  return "failed";
}

function repairDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  const repairs = [];
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has("session_nodes") || !tables.has("trajectory_runtime_events")) return repairs;
    const rows = database.prepare("SELECT session_key, current_session_id, entry_json FROM session_nodes WHERE status = 'running' AND entry_valid = 1").all();
    const latestEvent = database.prepare("SELECT event_json FROM trajectory_runtime_events WHERE session_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1");
    const update = database.prepare("UPDATE session_nodes SET entry_json = ?, status = ?, updated_at = ? WHERE session_key = ? AND current_session_id = ? AND status = 'running'");
    if (apply) database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        let entry;
        try {
          entry = JSON.parse(row.entry_json);
        } catch {
          continue;
        }
        const runId = typeof entry.activeWriterRunId === "string" && entry.activeWriterRunId === entry.lifecycleRunId ? entry.activeWriterRunId : undefined;
        if (!runId || !row.current_session_id) continue;
        const result = latestEvent.get(row.current_session_id, runId);
        if (!result) continue;
        let event;
        try {
          event = JSON.parse(result.event_json);
        } catch {
          continue;
        }
        const status = terminalStatus(event);
        const endedAt = Date.parse(event.ts);
        if (!status || !Number.isFinite(endedAt)) continue;
        const repaired = { ...entry, status, endedAt, runtimeMs: Number.isFinite(entry.startedAt) ? Math.max(0, endedAt - entry.startedAt) : undefined, lastRunId: runId };
        delete repaired.lifecycleRunId;
        delete repaired.activeWriterRunId;
        delete repaired.activeWriterLeaseUntil;
        delete repaired.mainRestartRecovery;
        delete repaired.restartRecoveryRuns;
        repaired.abortedLastRun = status !== "done";
        repairs.push({ database: databasePath, sessionKey: row.session_key, runId, status, endedAt });
        if (apply) update.run(JSON.stringify(repaired), status, endedAt, row.session_key, row.current_session_id);
      }
      if (apply) database.exec("COMMIT");
    } catch (error) {
      if (apply) database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
  return repairs;
}

const databases = fs.existsSync(agentsRoot) ? fs.readdirSync(agentsRoot).map((agent) => path.join(agentsRoot, agent, "agent", "openclaw-agent.sqlite")).filter((candidate) => fs.existsSync(candidate)) : [];
const repairs = databases.flatMap(repairDatabase);
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", inspectedDatabases: databases.length, repairs }, null, 2));

