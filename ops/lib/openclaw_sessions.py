"""Read-only OpenClaw 2026.9.1 stores and legacy 2026.7.1 files.

State root contains agents/. Canonical errors propagate; legacy fallback is
allowed only when canonical sessions are absent (including the known 7.1 auth schema). No migration or repair is performed.
"""
from __future__ import annotations
import json
import re
from contextlib import contextmanager
from pathlib import Path
import sqlite3


class SessionStoreError(ValueError):
    """Canonical state requires repair or is unsupported."""


def database_path(state_root, agent_id):
    if not agent_id or Path(agent_id).name != agent_id or agent_id in {".", ".."}:
        raise ValueError("agent_id must be one directory name")
    return Path(state_root) / "agents" / agent_id / "agent" / "openclaw-agent.sqlite"


def _present(path):
    try:
        path.stat()
    except FileNotFoundError:
        return False
    return True


def iter_agent_ids(state_root):
    agents = Path(state_root) / "agents"
    if not _present(agents):
        return
    for agent in sorted(agents.iterdir()):
        if agent.is_dir() and (_present(database_path(state_root, agent.name)) or _present(agent / "sessions" / "sessions.json")):
            yield agent.name


@contextmanager
def _database(path):
    # immutable=1 would miss live committed WAL records.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        yield connection
    finally:
        connection.close()



_LEGACY_TABLES = {
    "schema_meta", "cache_entries", "auth_profile_store", "auth_profile_state",
    "memory_index_meta", "memory_index_sources", "memory_index_chunks",
    "memory_embedding_cache", "memory_index_state",
}


def _canonical_sessions_present(path, agent_id):
    if not _present(path):
        return False
    with _database(path) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        # 7.1 already owns this filename for auth/memory. Recognize only its exact
        # schema, never a partially migrated, unrelated or damaged session store.
        extensions = tables - _LEGACY_TABLES
        known_legacy_tables = _LEGACY_TABLES <= tables and all(re.match(r"^memory_index_chunks_(fts|vec)(_|$)", table) for table in extensions)
        if known_legacy_tables and connection.execute("PRAGMA user_version").fetchone()[0] == 1:
            row = connection.execute("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'").fetchone()
            if row and tuple(row) == ("agent", 1, agent_id):
                return False
        return True


def _object(raw, label):
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as error:
        raise SessionStoreError(f"Invalid canonical {label} JSON") from error
    if not isinstance(value, dict):
        raise SessionStoreError(f"Canonical {label} must be an object")
    return value


def _marker(path, agent_id, session_id):
    return f"sqlite:{agent_id}:{session_id}:{path.resolve()}"


_HISTORY_FIELDS = (
    "origin", "route", "deliveryContext", "groupId", "groupChannel", "lastThreadId",
    "lastChannel", "lastTo", "lastAccountId", "label", "displayName", "archivedAt",
)
_WINDOW_FIELDS = {
    "created_at": "createdAt", "updated_at": "updatedAt", "started_at": "startedAt",
    "ended_at": "endedAt", "status": "status", "chat_type": "chatType",
    "channel": "channel", "account_id": "accountId", "model_provider": "modelProvider",
    "model": "model", "agent_harness_id": "agentHarnessId",
    "parent_session_key": "parentSessionKey", "spawned_by": "spawnedBy", "display_name": "displayName",
}


_SLACK_SESSION_KEY = re.compile(
    r"^agent:[^:]+:slack:channel:([^:]+):thread:(\d+(?:\.\d+)?)$",
    re.IGNORECASE,
)


def _session_key_fields(session_key):
    """Recover stable Slack identity from the canonical logical key."""
    match = _SLACK_SESSION_KEY.match(str(session_key or ""))
    if not match:
        return {}
    return {
        "channel": "slack",
        "lastChannel": "slack",
        "groupId": match.group(1).upper(),
        "lastThreadId": match.group(2),
    }


def _window_fields(window):
    return {target: window[source] for source, target in _WINDOW_FIELDS.items() if window[source] is not None}


def iter_sessions(state_root, agent_id, *, include_history=False):
    """Yield (key, entry), preserving archives and current-entry fields.

    include_history adds distinct historical sessionIds under the same key; do
    not convert that iterator to a dict. Historical usage comes from transcripts,
    never inherited current counters. sessionFile uses upstream SQLite markers.
    """
    path = database_path(state_root, agent_id)
    if not _canonical_sessions_present(path, agent_id):
        registry = Path(state_root) / "agents" / agent_id / "sessions" / "sessions.json"
        if not _present(registry):
            return
        with registry.open(encoding="utf-8") as handle:
            entries = json.load(handle)
        if not isinstance(entries, dict):
            raise SessionStoreError("Legacy session registry must be an object")
        for key, entry in entries.items():
            if isinstance(entry, dict) and entry.get("sessionId"):
                yield key, entry
        return
    with _database(path) as connection:
        for row in connection.execute("SELECT session_key, current_session_id, entry_json, updated_at FROM session_nodes ORDER BY session_key"):
            entry = _object(row["entry_json"], "session entry")
            # Upstream retains empty logical nodes for transcript-only history.
            if entry:
                if entry.get("sessionId") != row["current_session_id"] or entry.get("updatedAt") != row["updated_at"]:
                    raise SessionStoreError("Canonical session identity or timestamp requires repair")
                current_window = connection.execute("SELECT * FROM session_windows WHERE session_id = ?", (row["current_session_id"],)).fetchone()
                if current_window:
                    entry.update(_window_fields(current_window))
                for key, value in _session_key_fields(row["session_key"]).items():
                    entry.setdefault(key, value)
                entry["sessionFile"] = _marker(path, agent_id, entry["sessionId"])
                yield row["session_key"], entry
            if not include_history:
                continue
            for window in connection.execute("SELECT * FROM session_windows WHERE session_key = ? ORDER BY created_at, session_id", (row["session_key"],)):
                if entry and window["session_id"] == row["current_session_id"]:
                    continue
                historical = {key: entry[key] for key in _HISTORY_FIELDS if key in entry}
                historical.update(_window_fields(window))
                for key, value in _session_key_fields(row["session_key"]).items():
                    historical.setdefault(key, value)
                historical["sessionId"] = window["session_id"]
                historical["sessionFile"] = _marker(path, agent_id, window["session_id"])
                yield row["session_key"], historical


def iter_transcript_records(state_root, agent_id, entry):
    """Yield original event objects in persisted seq order, including compaction history.

    Trajectory JSONL sidecars are separate evidence, not transcript_events rows.
    """
    path = database_path(state_root, agent_id)
    if _canonical_sessions_present(path, agent_id):
        with _database(path) as connection:
            for row in connection.execute("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq", (entry["sessionId"],)):
                yield _object(row["event_json"], "transcript event")
        return
    session_file = entry.get("sessionFile")
    if session_file and str(session_file).startswith("sqlite:"):
        raise SessionStoreError("SQLite session marker has no canonical database")
    sessions = path.parent.parent / "sessions"
    transcript = Path(session_file) if session_file else Path(entry["sessionId"] + ".jsonl")
    if not transcript.is_absolute():
        transcript = sessions / transcript
    if not _present(transcript):
        return
    with transcript.open(encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            try:
                record = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record
