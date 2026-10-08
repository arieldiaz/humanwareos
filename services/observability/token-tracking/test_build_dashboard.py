#!/usr/bin/env python3
"""Synthetic Slack fixtures verify canonical storage preserves stats and exclusions."""
import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("dashboard", Path(__file__).with_name("build-dashboard.py"))
dashboard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dashboard)


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        self.patches = [
            patch.object(dashboard, "OPENCLAW_STATE_ROOT", self.state),
            patch.object(dashboard, "OPENCLAW_AGENTS", str(self.state / "agents")),
            patch.object(dashboard, "SLACK_AGENTS", ("alpha",)),
            patch.object(dashboard, "OWNER_KEY", "human"),
            patch.object(dashboard, "OWNER_NAME", "human"),
            patch.object(dashboard, "EXCLUDED_SLACK_CHANNELS", {"C_EXCLUDED"}),
            patch.object(dashboard, "codex_usage_index", return_value={}),
            patch.object(dashboard, "lifecycle_statuses", return_value=({}, {})),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def entry(self, session_id, channel="C_TEST", provider="claude-cli"):
        return {"sessionId": session_id, "groupId": channel, "lastThreadId": "1788950000.000001", "groupChannel": "#test", "createdAt": 1788950000000, "updatedAt": 1788950000000, "modelProvider": provider, "model": "fixture-model"}

    def records(self, suffix=""):
        return [
            {"type": "message", "timestamp": "2026-09-09T12:00:00Z", "message": {"role": "user", "sourceChannel": "slack", "senderName": "Human", "idempotencyKey": "input" + suffix, "content": "Synthetic request"}},
            {"type": "message", "timestamp": "2026-09-09T12:01:00Z", "message": {"role": "assistant", "stopReason": "stop", "model": "fixture-model", "content": "Synthetic response", "usage": {"input": 5, "output": 3, "cacheRead": 2, "totalTokens": 10}}},
        ]

    def canonical(self, windows):
        path = self.state / "agents/alpha/agent/openclaw-agent.sqlite"
        path.parent.mkdir(parents=True)
        db = sqlite3.connect(path)
        try:
            db.executescript("""
CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, updated_at INTEGER);
CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER, updated_at INTEGER, model_provider TEXT, model TEXT, started_at INTEGER, ended_at INTEGER, status TEXT, chat_type TEXT, channel TEXT, account_id TEXT, agent_harness_id TEXT, parent_session_key TEXT, spawned_by TEXT, display_name TEXT);
CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER);
""")
            for key, entry, records, current in windows:
                if current:
                    db.execute("INSERT INTO session_nodes VALUES (?,?,?,?)", (key, entry["sessionId"], json.dumps(entry), entry["updatedAt"]))
                db.execute("INSERT INTO session_windows (session_id,session_key,created_at,updated_at,model_provider,model) VALUES (?,?,?,?,?,?)", (entry["sessionId"], key, entry["createdAt"], entry["updatedAt"], entry["modelProvider"], entry["model"]))
                for seq, record in enumerate(records):
                    db.execute("INSERT INTO transcript_events VALUES (?,?,?,?)", (entry["sessionId"], seq, json.dumps(record), 1788950000000))
            db.commit()
        finally:
            db.close()

    def test_canonical_history_counted_without_stale_files_or_private_channel(self):
        key = "agent:alpha:slack:channel:C_TEST"
        self.canonical([
            (key, self.entry("new"), self.records("new"), True),
            (key, self.entry("old"), self.records("old"), False),
            ("agent:alpha:slack:channel:excluded", self.entry("excluded", next(iter(dashboard.EXCLUDED_SLACK_CHANNELS))), self.records("excluded"), True),
        ])
        legacy = self.state / "agents/alpha/sessions/sessions.json"
        legacy.parent.mkdir()
        legacy.write_text(json.dumps({"agent:alpha:slack:stale": {**self.entry("stale"), "sessionFile": "/does/not/exist"}}))
        result = dashboard.slack_activity()
        self.assertEqual(len(result["sessions"]), 1)
        day = result["days"]["2026-09-09"]
        self.assertEqual(day["messages"]["human"], 2)
        self.assertEqual(day["messages"]["alpha"], 2)
        self.assertEqual(day["tokens"]["alpha"], 20)
        self.assertEqual(day["inputTokens"]["alpha"], 14)
        self.assertEqual(day["outputTokens"]["alpha"], 6)
        self.assertNotIn("excluded", json.dumps(result))

    def test_legacy_jsonl_still_contributes(self):
        sessions = self.state / "agents/alpha/sessions"
        sessions.mkdir(parents=True)
        transcript = sessions / "old.jsonl"
        transcript.write_text("\n".join(json.dumps(row) for row in self.records()) + "\n")
        entry = {**self.entry("old"), "sessionFile": str(transcript)}
        (sessions / "sessions.json").write_text(json.dumps({"agent:alpha:slack:legacy": entry}))
        result = dashboard.slack_activity()
        self.assertEqual(result["days"]["2026-09-09"]["messages"]["alpha"], 1)

    def test_legacy_registry_with_existing_auth_only_database(self):
        self.test_legacy_jsonl_still_contributes()
        path = self.state / "agents/alpha/agent/openclaw-agent.sqlite"
        path.parent.mkdir()
        db = sqlite3.connect(path)
        try:
            db.executescript("CREATE TABLE schema_meta (meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','agent',1,'alpha'); PRAGMA user_version=1;")
            for table in ("cache_entries", "auth_profile_store", "auth_profile_state", "memory_index_meta", "memory_index_sources", "memory_index_chunks", "memory_embedding_cache", "memory_index_state"):
                db.execute(f"CREATE TABLE {table} (fixture TEXT)")
            db.commit()
        finally:
            db.close()
        result = dashboard.slack_activity()
        self.assertEqual(result["days"]["2026-09-09"]["messages"]["alpha"], 1)

    def test_native_usage_not_duplicated_across_historical_windows(self):
        key = "agent:alpha:slack:channel:C_TEST"
        self.canonical([(key, self.entry("new", provider="openai"), self.records("new"), True), (key, self.entry("old", provider="openai"), self.records("old"), False)])
        usage = {"input": 100, "output": 10, "days": {"2026-09-09": {"input": 100, "output": 10}}}
        with patch.object(dashboard, "codex_usage_index", return_value={"1788950000.000001": usage}):
            result = dashboard.slack_activity()
        self.assertEqual(result["sessions"][0]["tokens"], 110)
        self.assertEqual(result["days"]["2026-09-09"]["tokens"]["alpha"], 110)

    def test_copied_generation_events_do_not_double_count_usage_or_replies(self):
        key = "agent:alpha:slack:channel:C_TEST"
        records = self.records()
        for number, record in enumerate(records):
            record["id"] = "shared-event-" + str(number)
        self.canonical([(key, self.entry("new"), records, True), (key, self.entry("old"), records, False)])
        result = dashboard.slack_activity()
        day = result["days"]["2026-09-09"]
        self.assertEqual(day["tokens"]["alpha"], 10)
        self.assertEqual(day["messages"]["alpha"], 1)
        self.assertEqual(day["messages"]["human"], 1)

    def test_owner_and_agents_shape_daily_columns(self):
        key = "agent:alpha:slack:channel:C_TEST"
        self.canonical([(key, self.entry("new"), self.records("new"), True)])
        with patch.object(dashboard, "SLACK_WORKSPACE_DOMAIN", "example.slack.com"), \
                patch.object(dashboard, "SLACK_TEAM_ID", "T_TEST"):
            result = dashboard.slack_activity()
        day = result["days"]["2026-09-09"]
        self.assertEqual(list(day["messages"]), ["human", "alpha"])
        self.assertEqual(list(day["sessions"]), ["total", "alpha", "shared"])
        session = result["sessions"][0]
        self.assertEqual(session["url"], "https://example.slack.com/archives/C_TEST/p1788950000000001")
        self.assertIn("team=T_TEST", session["appUrl"])

    def test_missing_owner_config_fails_clearly(self):
        with patch.object(dashboard, "OWNER_KEY", None):
            with self.assertRaisesRegex(RuntimeError, "owner.key"):
                dashboard.slack_activity()

    def test_missing_reader_fails_instead_of_empty_stats(self):
        with patch.dict(os.environ, {"HUMANWARE_FRAMEWORK_ROOT": str(self.state / "missing")}):
            with self.assertRaises(RuntimeError):
                dashboard.slack_activity()


if __name__ == "__main__":
    unittest.main()
