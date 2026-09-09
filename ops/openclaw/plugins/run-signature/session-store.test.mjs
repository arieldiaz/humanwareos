import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile, readFile} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import {loadSessionEntry} from "./session-store.mjs";
import {loadThreadUsage} from "./session-close.mjs";

const key = "agent:liv:slack:channel:c1:thread:100.000000";
async function fixture(t) {
  const agentsRoot = await mkdtemp(join(tmpdir(), "canonical-sessions-"));
  t.after(() => rm(agentsRoot, {recursive: true, force: true}));
  await mkdir(join(agentsRoot, "liv", "agent"), {recursive: true});
  await mkdir(join(agentsRoot, "liv", "sessions"), {recursive: true});
  await writeFile(join(agentsRoot, "liv", "sessions", "sessions.json"), JSON.stringify({[key]: {sessionId: "stale", thinkingLevel: "low"}}));
  const path = join(agentsRoot, "liv", "agent", "openclaw-agent.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT);
    CREATE TABLE session_windows(session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER);
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT);`);
  return {agentsRoot, path, db};
}

test("canonical state wins over stale legacy files without creating writes", async (t) => {
  const {agentsRoot, path, db} = await fixture(t);
  const entry = {sessionId: "current", thinkingLevel: "high", model: "sol", modelProvider: "openai", deliveryContext: {threadId: "100.000000"}};
  db.prepare("INSERT INTO session_nodes VALUES(?, ?)").run(key, JSON.stringify(entry));
  db.close();
  const before = await readFile(path);
  assert.deepEqual(await loadSessionEntry(key, {agentsRoot}), entry);
  assert.equal(await loadSessionEntry("agent:liv:missing", {agentsRoot}), undefined);
  assert.deepEqual(await readFile(path), before);
});

test("thread usage includes prior windows and deduplicates replayed event IDs", async (t) => {
  const {agentsRoot, db} = await fixture(t);
  const event = (id, input) => JSON.stringify({id, type: "message", message: {role: "assistant", model: "sol", usage: {input, output: 2}}});
  db.prepare("INSERT INTO session_windows VALUES(?, ?, ?)").run("old", key, 1);
  db.prepare("INSERT INTO session_windows VALUES(?, ?, ?)").run("current", key, 2);
  db.prepare("INSERT INTO session_windows VALUES(?, ?, ?)").run("other", "other-key", 3);
  db.prepare("INSERT INTO transcript_events VALUES(?, ?, ?)").run("old", 1, event("e1", 10));
  db.prepare("INSERT INTO transcript_events VALUES(?, ?, ?)").run("current", 1, event("e1", 10));
  db.prepare("INSERT INTO transcript_events VALUES(?, ?, ?)").run("current", 2, event("e2", 20));
  db.prepare("INSERT INTO transcript_events VALUES(?, ?, ?)").run("other", 1, event("e3", 999));
  db.close();
  const usage = await loadThreadUsage({agent: "liv", channel: "C1", thread: "100.000000", agentsRoot});
  assert.equal(usage.turns, 2);
  assert.equal(usage.input, 30);
  assert.equal(usage.output, 4);
});

test("canonical schema errors surface instead of returning stale legacy provenance", async (t) => {
  const {agentsRoot, db} = await fixture(t);
  db.exec("DROP TABLE session_nodes");
  db.close();
  await assert.rejects(loadSessionEntry(key, {agentsRoot}), /no such table/);
});

test("legacy lookup remains available when the canonical database is absent", async (t) => {
  const {agentsRoot, path, db} = await fixture(t);
  db.close();
  await rm(path);
  assert.equal((await loadSessionEntry(key, {agentsRoot})).thinkingLevel, "low");
});


test("recognized 7.1 auth-only databases preserve legacy sessions with optional memory tables", async (t) => {
  const {agentsRoot, db} = await fixture(t);
  db.exec("DROP TABLE session_nodes; DROP TABLE session_windows; DROP TABLE transcript_events; PRAGMA user_version = 1");
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)");
  db.exec("INSERT INTO schema_meta VALUES('primary', 'agent', 1, 'liv')");
  for (const table of ["cache_entries", "auth_profile_store", "auth_profile_state", "memory_index_meta", "memory_index_sources", "memory_index_chunks", "memory_embedding_cache", "memory_index_state", "memory_index_chunks_fts_data", "memory_index_chunks_vec_chunks"]) {
    db.exec(`CREATE TABLE ${table}(id INTEGER)`);
  }
  db.close();
  assert.equal((await loadSessionEntry(key, {agentsRoot})).thinkingLevel, "low");
});
