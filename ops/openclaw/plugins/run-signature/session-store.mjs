import {stat, readFile} from "node:fs/promises";
import {join} from "node:path";
import {homedir} from "node:os";

export function defaultAgentsRoot() {
  return join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "agents");
}

const legacyTables = new Set([
  "schema_meta", "cache_entries", "auth_profile_store", "auth_profile_state",
  "memory_index_meta", "memory_index_sources", "memory_index_chunks",
  "memory_embedding_cache", "memory_index_state",
]);

function isLegacyAuthDatabase(database, agent) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (![...legacyTables].every(name => tables.has(name))) return false;
  if ([...tables].some(name => !legacyTables.has(name) && !/^memory_index_chunks_(fts|vec)(_|$)/.test(name))) return false;
  if (database.prepare("PRAGMA user_version").get().user_version !== 1) return false;
  const metadata = database.prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'").get();
  return metadata?.role === "agent" && metadata.schema_version === 1 && metadata.agent_id === agent;
}

export async function withCanonicalSessionDatabase({agent, agentsRoot = defaultAgentsRoot()}, read) {
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new Error("Invalid session agent id");
  const path = join(agentsRoot, agent, "agent", "openclaw-agent.sqlite");
  try {
    await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return {found: false};
    throw error;
  }
  const {DatabaseSync} = await import("node:sqlite");
  const database = new DatabaseSync(path, {readOnly: true});
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN");
    if (isLegacyAuthDatabase(database, agent)) return {found: false};
    return {found: true, result: read(database)};
  } finally {
    database.close();
  }
}

export async function loadSessionEntry(sessionKey, {agentsRoot = defaultAgentsRoot()} = {}) {
  const agent = String(sessionKey ?? "").match(/^agent:([a-z][a-z0-9-]*):/)?.[1];
  if (!agent) return;
  const canonical = await withCanonicalSessionDatabase({agent, agentsRoot}, (database) => {
    const row = database.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey);
    return row ? JSON.parse(row.entry_json) : undefined;
  });
  if (canonical.found) return canonical.result;
  try {
    const sessions = JSON.parse(await readFile(join(agentsRoot, agent, "sessions", "sessions.json"), "utf8"));
    return sessions[sessionKey];
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
