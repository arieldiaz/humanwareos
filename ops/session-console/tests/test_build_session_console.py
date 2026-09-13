import importlib.util
import json
import pathlib
import tempfile
import unittest
from datetime import datetime, timezone


SCRIPT = pathlib.Path(__file__).parents[1] / "build-session-console.py"
SPEC = importlib.util.spec_from_file_location("session_console", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SessionConsoleTest(unittest.TestCase):
    def test_uses_stable_slack_root_title(self):
        self.assertEqual(
            MODULE.root_title({"displayName": "Slack thread #humanware-os: New issue - fix menu links"}),
            "New issue - fix menu links",
        )
        self.assertIsNone(MODULE.root_title({"displayName": "Slack channel #humanware-os"}))
        self.assertIsNone(MODULE.root_title({
            "displayName": "Slack thread #humanware-os: Parent thread: C0BKFAFGJ72 1787340997.744889 <@U0BG50JV77D>"
        }))
        self.assertIsNone(MODULE.usable_cached_title(
            "Parent thread: C0BKFAFGJ72 1787340997.744889 <@U0BG50JV77D>"
        ))

    def test_session_bound_never_drops_open_threads(self):
        sessions = [
            {"id": "new-completed", "status": "completed"},
            {"id": "older-open", "status": "needs_you"},
            {"id": "scheduled", "status": "idle", "workflow": {"state": "scheduled"}},
            {"id": "stale-error", "status": "error"},
            {"id": "old-completed", "status": "completed"},
        ]
        self.assertEqual(
            [item["id"] for item in MODULE.bounded_sessions(sessions, limit=1)],
            ["older-open", "scheduled"],
        )

    def test_builds_redacted_append_only_ledger_and_shared_session(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            data = root / "data"
            agents = root / "agents"
            for agent in ("liv", "max"):
                sessions = agents / agent / "sessions"
                sessions.mkdir(parents=True)
                runtime_id = f"runtime-{agent}"
                transcript = sessions / f"{runtime_id}.jsonl"
                transcript.write_text(json.dumps({"type": "message", "message": {
                    "role": "user", "content": "Fix the gateway with token=super-secret-value"
                }}) + "\n")
                registry = {f"agent:{agent}:slack:channel:c1:thread:123.45": {
                    "sessionId": runtime_id, "sessionFile": str(transcript),
                    "groupId": "C1", "groupChannel": "#ops", "lastThreadId": "123.45",
                    "displayName": "Slack thread #ops: Stable root request",
                    "status": "running" if agent == "liv" else "done", "model": "test-model",
                    "modelProvider": "openai", "updatedAt": 1787300000000,
                }}
                (sessions / "sessions.json").write_text(json.dumps(registry))
                records = [
                    {"type": "session.started", "ts": "2026-08-21T12:00:00Z", "traceId": runtime_id,
                     "seq": 1, "sessionId": runtime_id, "provider": "openai", "modelId": "test-model", "data": {}},
                    {"type": "tool.call", "ts": "2026-08-21T12:00:01Z", "traceId": runtime_id,
                     "seq": 2, "sessionId": runtime_id, "data": {"name": "exec", "arguments": {
                         "command": "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test?q=secret"}}},
                    {"type": "tool.result", "ts": "2026-08-21T12:00:02Z", "traceId": runtime_id,
                     "seq": 3, "sessionId": runtime_id, "data": {"name": "exec", "success": True,
                      "output": "ok xoxb-1234567890abcdef sk-proj-1234567890abcdef"}},
                ]
                (sessions / f"{runtime_id}.trajectory.jsonl").write_text(
                    "".join(json.dumps(record) + "\n" for record in records)
                )

            result, additions = MODULE.build(str(data), str(agents))
            self.assertEqual(additions, 6)
            self.assertEqual(result["summary"]["total"], 1)
            self.assertEqual(result["summary"]["active"], 1)
            session = result["sessions"][0]
            self.assertEqual(session["agents"], ["liv", "max"])
            self.assertEqual(session["title"], "Stable root request")
            ledger = "".join(path.read_text() for path in (data / "evidence" / "sessions" / "events").glob("*.jsonl"))
            self.assertNotIn("abcdefghijklmnop", ledger)
            self.assertNotIn("xoxb-1234567890abcdef", ledger)
            self.assertNotIn("sk-proj-1234567890abcdef", ledger)

            _, second_additions = MODULE.build(str(data), str(agents))
            self.assertEqual(second_additions, 0)

    def test_status_set_event_classifies_needs_you_not_idle(self):
        events = [
            {
                "kind": "status.set",
                "ts": "2026-08-24T15:00:00Z",
                "details": {"threadId": "123.45", "status": "answer", "emoji": "question"},
            }
        ]
        workflow = MODULE.workflow_states(events)["123.45"]
        self.assertEqual(workflow["state"], "needs_you")
        self.assertEqual(workflow["emoji"], "question")
        self.assertEqual(workflow["outbound"], "answer")
        self.assertEqual(
            MODULE.classify({"runStatuses": ["done"], "updatedAt": "2026-08-01T00:00:00Z"}, workflow, datetime.now(timezone.utc)),
            "needs_you",
        )

    def test_legacy_no_action_is_inert(self):
        events = [
            {"kind": "status.set", "ts": "2026-08-24T15:00:00Z", "details": {"threadId": "123.45", "status": "working"}},
            {"kind": "status.set", "ts": "2026-08-24T15:01:00Z", "details": {"threadId": "123.45", "status": "no_action"}},
        ]
        self.assertEqual(MODULE.workflow_states(events)["123.45"]["state"], "active")

    def test_legacy_reaction_does_not_create_outbound_status(self):
        events = [{
            "kind": "tool.call",
            "ts": "2026-08-24T15:00:00Z",
            "details": {"tool": "message", "arguments": {
                "action": "react", "emoji": "raised_hand", "messageId": "123.45"
            }},
        }]
        self.assertEqual(MODULE.workflow_states(events), {})

    def test_working_expires_when_no_run_is_running(self):
        workflow = {"state": "active", "outbound": "working"}
        self.assertIsNone(MODULE.effective_workflow(workflow, ["done"]))
        self.assertEqual(MODULE.effective_workflow(workflow, ["running"]), workflow)
        answer = {"state": "needs_you", "outbound": "answer"}
        self.assertEqual(MODULE.effective_workflow(answer, ["done"]), answer)


class CanonicalSessionReaderTest(unittest.TestCase):
    def setUp(self):
        import sqlite3
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.path = self.root / 'agents' / 'liv' / 'agent' / 'openclaw-agent.sqlite'
        self.path.parent.mkdir(parents=True)
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, updated_at INTEGER);
            CREATE TABLE session_windows (
                session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER, updated_at INTEGER,
                started_at INTEGER, ended_at INTEGER, status TEXT, chat_type TEXT, channel TEXT,
                account_id TEXT, model_provider TEXT, model TEXT, agent_harness_id TEXT,
                parent_session_key TEXT, spawned_by TEXT, display_name TEXT);
            CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER, PRIMARY KEY(session_id, seq));
        ''')
        self.key = 'agent:liv:slack:channel:c1:thread:123.45'
        self.entry = {'sessionId': 'current', 'updatedAt': 2000, 'status': 'done',
                      'inputTokens': 13, 'outputTokens': 5, 'estimatedCostUsd': 0.02,
                      'archivedAt': 2500, 'groupId': 'C1', 'lastThreadId': '123.45',
                      'origin': {'provider': 'slack', 'label': '#ops'}, 'model': 'current-model'}
        self.db.execute('INSERT INTO session_nodes VALUES (?, ?, ?, ?)', (self.key, 'current', json.dumps(self.entry), 2000))
        for sid, status, updated in [('current', 'done', 2000), ('historical', 'done', 1000)]:
            self.db.execute('INSERT INTO session_windows (session_id,session_key,created_at,updated_at,status,model,model_provider) VALUES (?,?,?,?,?,?,?)', (sid, self.key, updated-500, updated, status, sid+'-model', 'openai'))
        self.db.commit()

    def test_current_and_archived_windows_preserve_identity_without_duplicate_usage(self):
        entries = list(MODULE.iter_sessions(self.root, 'liv', include_history=True))
        self.assertEqual([entry['sessionId'] for _, entry in entries], ['current', 'historical'])
        self.assertEqual([key for key, _ in entries], [self.key, self.key])
        current, history = [entry for _, entry in entries]
        self.assertEqual(current['inputTokens'], 13)
        self.assertEqual(current['archivedAt'], 2500)
        self.assertEqual(history['status'], 'done')
        self.assertEqual(history['updatedAt'], 1000)
        self.assertEqual(history['model'], 'historical-model')
        self.assertEqual(history['groupId'], 'C1')
        self.assertNotIn('inputTokens', history)
        self.assertTrue(history['sessionFile'].startswith('sqlite:liv:historical:'))
        self.assertEqual(len(list(MODULE.iter_sessions(self.root, 'liv'))), 1)

    def test_canonical_window_and_session_key_restore_slack_projection_fields(self):
        self.entry.pop('lastThreadId')
        self.entry.pop('status')
        self.entry['groupId'] = 'c1'
        self.db.execute(
            'UPDATE session_nodes SET entry_json = ? WHERE session_key = ?',
            (json.dumps(self.entry), self.key),
        )
        self.db.execute(
            "UPDATE session_windows SET status = 'running', channel = 'slack', chat_type = 'channel' WHERE session_id = 'current'",
        )
        self.db.commit()

        key, current = next(iter(MODULE.iter_sessions(self.root, 'liv')))
        self.assertEqual(key, self.key)
        self.assertEqual(current['groupId'], 'c1')
        self.assertEqual(current['lastThreadId'], '123.45')
        self.assertEqual(current['lastChannel'], 'slack')
        self.assertEqual(current['channel'], 'slack')
        self.assertEqual(current['chatType'], 'channel')
        self.assertEqual(current['status'], 'running')

        result, _ = MODULE.build(str(self.root/'data'), str(self.root/'agents'), dry_run=True)
        projected = result['sessions'][0]
        self.assertEqual(projected['channelId'], 'C1')
        self.assertEqual(projected['threadId'], '123.45')
        self.assertEqual(projected['status'], 'active')

    def test_transcript_event_shape_order_usage_and_wal_visibility(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        records = [
            {'type': 'message', 'timestamp': '2026-09-09T12:00:00Z', 'message': {'role': 'user', 'content': 'A synthetic title'}},
            {'type': 'message', 'timestamp': '2026-09-09T12:00:01Z', 'message': {'role': 'assistant', 'usage': {'input': 7, 'output': 3}, 'content': []}},
        ]
        for seq in (2, 1):
            self.db.execute('INSERT INTO transcript_events VALUES (?, ?, ?, ?)', ('current', seq, json.dumps(records[seq-1]), seq))
        self.db.commit()
        before = self.path.read_bytes()
        self.assertEqual(list(MODULE.iter_transcript_records(self.root, 'liv', self.entry)), records)
        self.assertEqual(self.path.read_bytes(), before)
        result, additions = MODULE.build(str(self.root/'data'), str(self.root/'agents'), dry_run=True)
        self.assertEqual(additions, 0)
        self.assertEqual(result['summary']['total'], 1)
        self.assertEqual(result['sessions'][0]['title'], 'A synthetic title')
        self.assertEqual(result['sessions'][0]['inputTokens'], 13)
        self.assertEqual(result['sessions'][0]['status'], 'completed')
        self.assertFalse((self.root/'data').exists())

    def test_db_error_never_falls_back_to_stale_registry_or_transcript(self):
        import sqlite3
        sessions = self.root/'agents'/'liv'/'sessions'
        sessions.mkdir()
        (sessions/'sessions.json').write_text(json.dumps({'stale': {'sessionId': 'stale'}}))
        self.db.execute('DROP TABLE session_nodes')
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            list(MODULE.iter_sessions(self.root, 'liv'))
        self.db.execute('DROP TABLE transcript_events')
        self.db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            list(MODULE.iter_transcript_records(self.root, 'liv', self.entry))

    def test_invalid_canonical_json_fails_closed(self):
        self.db.execute("UPDATE session_nodes SET entry_json = '{broken'")
        self.db.commit()
        with self.assertRaises(ValueError):
            list(MODULE.iter_sessions(self.root, 'liv'))

    def test_canonical_identity_mismatch_fails_closed(self):
        self.db.execute("UPDATE session_nodes SET current_session_id = 'other'")
        self.db.commit()
        with self.assertRaises(ValueError):
            list(MODULE.iter_sessions(self.root, 'liv'))

    def test_transcript_only_node_retains_history(self):
        self.db.execute("UPDATE session_nodes SET entry_json = '{}'")
        self.db.commit()
        self.assertEqual(list(MODULE.iter_sessions(self.root, 'liv')), [])
        self.assertEqual({entry['sessionId'] for _, entry in MODULE.iter_sessions(self.root, 'liv', include_history=True)}, {'current', 'historical'})

    def test_legacy_fallback_when_canonical_database_absent(self):
        legacy = self.root/'agents'/'max'/'sessions'
        legacy.mkdir(parents=True)
        entry = {'sessionId': 'legacy', 'sessionFile': 'legacy.jsonl', 'inputTokens': 4}
        (legacy/'sessions.json').write_text(json.dumps({'legacy-key': entry}))
        record = {'type': 'message', 'message': {'role': 'user', 'content': 'legacy'}}
        (legacy/'legacy.jsonl').write_text('incomplete json\n'+json.dumps(record)+'\n')
        self.assertEqual(list(MODULE.iter_sessions(self.root, 'max')), [('legacy-key', entry)])
        self.assertEqual(list(MODULE.iter_transcript_records(self.root, 'max', entry)), [record])
        self.assertEqual(list(MODULE.iter_agent_ids(self.root)), ['liv', 'max'])
        self.assertFalse((self.root/'agents'/'max'/'agent').exists())


    def test_known_71_auth_schema_allows_legacy_but_partial_canonical_does_not(self):
        import sqlite3
        old = self.root/'agents'/'max'/'agent'/'openclaw-agent.sqlite'
        old.parent.mkdir(parents=True)
        sessions = old.parent.parent/'sessions'
        sessions.mkdir()
        entry = {'sessionId': 'legacy', 'sessionFile': 'legacy.jsonl'}
        (sessions/'sessions.json').write_text(json.dumps({'legacy': entry}))
        record = {'type': 'message', 'message': {'role': 'user', 'content': 'legacy'}}
        (sessions/'legacy.jsonl').write_text(json.dumps(record)+'\n')
        db = sqlite3.connect(old)
        self.addCleanup(db.close)
        db.executescript("""
            PRAGMA user_version=1;
            CREATE TABLE schema_meta(meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT);
            INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'max');
        """)
        for table in ('cache_entries', 'auth_profile_store', 'auth_profile_state', 'memory_index_meta', 'memory_index_sources', 'memory_index_chunks', 'memory_embedding_cache', 'memory_index_state'):
            db.execute(f'CREATE TABLE {table}(synthetic TEXT)')
        db.commit()
        self.assertEqual(list(MODULE.iter_sessions(self.root, 'max')), [('legacy', entry)])
        self.assertEqual(list(MODULE.iter_transcript_records(self.root, 'max', entry)), [record])
        db.execute('CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(text)')
        db.execute('CREATE TABLE memory_index_chunks_vec(synthetic TEXT)')
        db.execute('CREATE TABLE memory_index_chunks_vec_chunks(synthetic TEXT)')
        db.commit()
        self.assertEqual(list(MODULE.iter_sessions(self.root, 'max')), [('legacy', entry)])
        db.execute('CREATE TABLE session_windows(session_id TEXT)')
        db.commit()
        with self.assertRaises(sqlite3.DatabaseError):
            list(MODULE.iter_sessions(self.root, 'max'))


if __name__ == "__main__":
    unittest.main()
