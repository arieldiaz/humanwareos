import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone


SCRIPT = pathlib.Path(__file__).parents[1] / "build-session-console.py"
SPEC = importlib.util.spec_from_file_location("session_console", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SessionConsoleTest(unittest.TestCase):
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
            self.assertEqual(session["title"], "#ops · liv, max")
            summary_path = data / "generated" / "sessions" / session["summaryMarkdown"]
            self.assertTrue(summary_path.exists())
            self.assertIn("# Session summary", summary_path.read_text())
            self.assertIn("**Agents:** liv, max", summary_path.read_text())
            self.assertNotIn("Stable root request", json.dumps(result))
            ledger = "".join(path.read_text() for path in (data / "evidence" / "sessions" / "events").glob("*.jsonl"))
            self.assertNotIn("abcdefghijklmnop", ledger)
            self.assertNotIn("xoxb-1234567890abcdef", ledger)
            self.assertNotIn("sk-proj-1234567890abcdef", ledger)

            _, second_additions = MODULE.build(str(data), str(agents))
            self.assertEqual(second_additions, 0)

    def test_status_set_event_classifies_on_human_not_idle(self):
        events = [
            {
                "kind": "status.set",
                "ts": "2026-08-24T15:00:00Z",
                "details": {"threadId": "123.45", "status": "act", "emoji": "raised_hand"},
            }
        ]
        workflow = MODULE.workflow_states(events)["123.45"]
        self.assertEqual(workflow["state"], "needs_you")
        self.assertEqual(workflow["emoji"], "raised_hand")
        self.assertEqual(workflow["outbound"], "act")
        self.assertEqual(
            MODULE.classify({"runStatuses": ["done"], "updatedAt": "2026-08-01T00:00:00Z"}, workflow, datetime.now(timezone.utc)),
            "needs_you",
        )

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
        act = {"state": "needs_you", "outbound": "act"}
        self.assertEqual(MODULE.effective_workflow(act, ["done"]), act)


class SubagentRunCaptureTest(unittest.TestCase):
    ROOT_KEY = 'agent:liv:slack:channel:c1:thread:123.45'
    # Synthetic list prices: one dollar per million input tokens, ten per million output.
    PRICES = {'basis': 'api-list-price-equivalent', 'currency': 'USD', 'unit': 'per-million-tokens', 'models': {'model-a': [
        {'effectiveFrom': '2026-01-01', 'input': 1, 'output': 10, 'cacheRead': 0, 'cacheWrite': 0, 'source': 'synthetic'}]}}

    def setUp(self):
        import sqlite3
        from unittest import mock
        patcher = mock.patch.object(MODULE.activity.pricing, 'TABLE', self.PRICES)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        agent_db = self.root / 'agents' / 'liv' / 'agent' / 'openclaw-agent.sqlite'
        agent_db.parent.mkdir(parents=True)
        (self.root / 'state').mkdir()
        self.agent = sqlite3.connect(agent_db)
        self.state = sqlite3.connect(self.root / 'state' / 'openclaw.sqlite')
        self.addCleanup(self.agent.close)
        self.addCleanup(self.state.close)
        self.agent.executescript('''
            CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT, updated_at INTEGER);
            CREATE TABLE session_windows (
                session_id TEXT PRIMARY KEY, session_key TEXT, created_at INTEGER, updated_at INTEGER,
                started_at INTEGER, ended_at INTEGER, status TEXT, chat_type TEXT, channel TEXT,
                account_id TEXT, model_provider TEXT, model TEXT, agent_harness_id TEXT,
                parent_session_key TEXT, spawned_by TEXT, display_name TEXT);
            CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER,
                event_zstd BLOB, message_role TEXT, PRIMARY KEY(session_id, seq));
            CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, session_key TEXT, reason TEXT,
                encoding TEXT, archive_blob BLOB, archive_name TEXT UNIQUE, created_at INTEGER);
        ''')
        self.state.execute('CREATE TABLE subagent_runs (run_id TEXT PRIMARY KEY, child_session_key TEXT, created_at INTEGER, payload_json TEXT)')
        self.node(self.ROOT_KEY, 'root', {'groupId': 'C1', 'lastThreadId': '123.45', 'status': 'done'})
        # Session counters describe the last call only; they are never a run total.
        self.node('agent:liv:subagent:a', 'child-a', {'lastRunId': 'run-a', 'thinkingLevel': 'high', 'model': 'm', 'modelProvider': 'p',
                                                  'inputTokens': 10, 'outputTokens': 5, 'totalTokens': 15,
                                                  'estimatedCostUsd': 0.25, 'endedAt': 1787300060000, 'status': 'done'})
        self.node('agent:liv:subagent:d', 'child-d', {'lastRunId': 'run-d', 'inputTokens': 3, 'status': 'running'})
        self.add_run('run-a', 'agent:liv:subagent:a', self.ROOT_KEY, ended=('ok', 60000))
        self.add_run('run-b', 'agent:liv:subagent:b', 'agent:liv:subagent:a', ended=('timeout', 30000))  # child session deleted
        self.add_run('run-c', 'agent:liv:subagent:c', self.ROOT_KEY)
        self.add_run('run-d', 'agent:liv:subagent:d', self.ROOT_KEY, ended=('error', 1000))
        self.say('root', 1, 'r1', {'input': 2_000_000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 2_000_000}, run_id='turn-1')
        self.say('root', 2, 'r2', {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 0})  # mirrored fragment
        self.say('root', 3, 'r3', None, role='user')
        self.say('child-a', 1, 'a1', {'input': 1_000_000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 1_000_000})
        self.say('child-a', 2, 'a2', {'input': 0, 'output': 100_000, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': 100_000})
        self.archive('child-b', 'agent:liv:subagent:b', [self.record('b1', {'input': 500_000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0})])

    def node(self, key, session_id, entry):
        entry = dict(entry, sessionId=session_id, updatedAt=1787300000000)
        self.agent.execute('INSERT OR REPLACE INTO session_nodes VALUES (?, ?, ?, ?)', (key, session_id, json.dumps(entry), entry['updatedAt']))
        self.agent.execute('INSERT OR IGNORE INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
                           (session_id, key, entry['updatedAt'], entry['updatedAt']))
        self.agent.commit()

    def record(self, record_id, usage, role='assistant', run_id=None):
        message = {'role': role, 'content': 'SYNTHETIC PRIVATE REPLY', 'provider': 'provider', 'model': 'model-a'}
        if usage is not None:
            message['usage'] = usage
        if run_id:
            message['__openclaw'] = {'runId': run_id}
        return {'type': 'message', 'id': record_id, 'timestamp': '2026-08-21T12:00:30.000Z', 'message': message}

    def say(self, session_id, seq, record_id, usage, role='assistant', run_id=None):
        self.agent.execute('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL, ?)',
                           (session_id, seq, json.dumps(self.record(record_id, usage, role, run_id)), seq, role))
        self.agent.commit()

    def archive(self, session_id, key, records, compress=False):
        blob = ''.join(json.dumps(record) + '\n' for record in records).encode()
        if compress:
            node = os.environ.get('NODE_BIN') or shutil.which('node')
            blob = subprocess.run([node, '-e', 'process.stdout.write(require("zlib").zstdCompressSync(require("fs").readFileSync(0)))'],
                                  input=blob, capture_output=True, check=True).stdout
        self.agent.execute('INSERT INTO session_transcript_archives VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                           (session_id, 'g1', key, 'deleted', 'zstd' if compress else 'identity', blob, f'{session_id}.jsonl.deleted', 1))
        self.agent.commit()

    def add_run(self, run_id, child, parent, ended=None):
        payload = {'childSessionKey': child, 'requesterSessionKey': parent, 'requesterAgentId': 'liv',
                   'createdAt': 1787300000000, 'task': 'SYNTHETIC PRIVATE BRIEF', 'execution': {'status': 'running'}}
        if ended:
            payload['execution'] = {'status': 'terminal', 'startedAt': 1787300000000, 'endedAt': 1787300000000 + ended[1],
                                    'outcome': {'status': ended[0], 'elapsedMs': ended[1]}}
        self.state.execute('INSERT INTO subagent_runs VALUES (?, ?, ?, ?)', (run_id, child, 1787300000000, json.dumps(payload)))
        self.state.commit()

    def build(self):
        return MODULE.build(str(self.root / 'data'), str(self.root / 'agents'))

    def ledger(self):
        return [json.loads(line) for path in sorted((self.root / 'data/evidence/sessions/events').glob('*.jsonl'))
                for line in path.read_text().splitlines()]

    def session(self, result):
        return next(item for item in result['sessions'] if item['id'] == 'slack:C1:123.45')

    def test_runs_and_transcript_usage_are_captured_once_and_priced_by_code(self):
        from jsonschema import Draft202012Validator, FormatChecker
        result, additions = self.build()
        self.assertEqual(additions, 11)  # four spawns, three ended runs, four records that report tokens
        validator = Draft202012Validator(json.loads((SCRIPT.parents[2] / 'schemas/session-event.schema.json').read_text()), format_checker=FormatChecker())
        for row in self.ledger():
            validator.validate(row)
        self.assertNotIn('SYNTHETIC PRIVATE', json.dumps(self.ledger()) + json.dumps(result))
        usage = {row['id']: row for row in self.ledger() if row['kind'] == 'usage.cost'}
        self.assertEqual(sorted(usage), [f'openclaw:usage:liv:{name}' for name in ('child-a:a1', 'child-a:a2', 'child-b:b1', 'root:r1')])
        # Evidence holds observed tokens and the model; the amount is computed when read.
        self.assertEqual({row['cost']['status'] for row in usage.values()}, {'unavailable'})
        root_call = usage['openclaw:usage:liv:root:r1']
        self.assertEqual((root_call['logicalSessionId'], root_call['runId'], root_call['cost']['model'], root_call['cost']['tokens']['input']),
                         ('slack:C1:123.45', 'turn-1', 'provider/model-a', 2_000_000))
        self.assertEqual(usage['openclaw:usage:liv:child-b:b1']['logicalSessionId'], 'agent:liv:subagent:b')
        completed = {row['runId']: row for row in self.ledger() if row['kind'] == 'run.completed'}
        self.assertEqual({(row['cost']['status'], json.dumps(row['cost']['tokens'])) for row in completed.values()}, {('unavailable', '{}')})
        self.assertEqual((completed['run-a']['outcome'], completed['run-d']['outcome']), ('succeeded', 'failed'))
        self.assertEqual((completed['run-b']['run']['parentSessionId'], completed['run-b']['run']['rootSessionId']), ('openclaw:liv:child-a', 'slack:C1:123.45'))

        session = self.session(result)
        self.assertEqual(session['workerRuns'], 4)
        self.assertEqual([run['runId'] for run in session['runs']], ['run-a', 'run-c', 'run-d'])
        worker = session['runs'][0]
        self.assertEqual((worker['model'], worker['reasoning'], worker['durationMs']), ('p/m', 'high', 60000))
        self.assertEqual((worker['tokens']['total'], worker['cost']), (1_100_000, {'amount': 2.0, 'reports': 2, 'unavailable': 0}))
        self.assertEqual([(run['runId'], run['cost']['amount']) for run in worker['children']], [('run-b', 0.5)])  # from the archive
        self.assertEqual([run['cost']['amount'] for run in session['runs'][1:]], [None, None])
        cost = session['cost']
        self.assertEqual((cost['basis'], cost['amount'], cost['root']['amount'], cost['workers']['amount']), ('api-list-price-equivalent', 4.5, 2.0, 2.5))
        self.assertEqual((cost['reports'], cost['unavailable']), (5, 1))  # run-d ended with no observable usage
        self.assertEqual([(row['runId'], row['amount']) for row in cost['byRun']], [('turn-1', 2.0)])
        self.assertEqual(sum(group['estimated'] for group in session['spend']), 4.5)
        self.assertNotIn('eventIds', session['spend'][0])
        summary = (self.root / 'data/generated/sessions' / session['summaryMarkdown']).read_text()
        self.assertIn('**Worker runs:** 4', summary)
        self.assertIn('**Cost:** $4.50 API list-price equivalent (root $2.00, workers $2.50); 1 of 5 usage reports unpriced', summary)
        self.assertEqual(self.build()[1], 0)
        # An unknown part of the total is named, never shown as zero.
        workers_only = dict(cost, root=dict(cost['root'], amount=None))
        self.assertIn('(root unavailable, workers $2.50)', MODULE.cost_text(workers_only))
        self.assertEqual(MODULE.cost_text(dict(cost, amount=None)), 'Unavailable')
        self.assertEqual(MODULE.cost_text(None), 'Unavailable')

    def test_plugin_started_root_thread_is_not_a_worker_run(self):
        thread = 'agent:liv:slack:channel:c1:thread:678.90'
        self.node(thread, 'thread', {'lastRunId': 'run-t', 'endedAt': 1787300060000, 'status': 'done'})
        self.add_run('run-t', thread, 'agent:liv:main', ended=('ok', 60000))
        self.add_run('run-e', 'agent:liv:subagent:e', thread, ended=('ok', 1000))
        entries, logical = {}, {}
        MODULE.registry_index(str(self.root / 'agents'), {}, entries, logical)
        rows = MODULE.run_events(list(MODULE.iter_subagent_runs(self.root)), entries, logical)
        self.assertNotIn('run-t', {row['runId'] for row in rows})
        spawned = next(row for row in rows if row['id'] == 'openclaw:run.spawned:run-e')
        self.assertEqual(spawned['run']['rootSessionId'], spawned['run']['parentSessionId'])
        self.assertTrue(MODULE.is_worker_session('agent:liv:dashboard:x', {'spawnDepth': 1, 'spawnedBy': thread}))
        self.assertFalse(MODULE.is_worker_session(thread, {}))

    def test_usage_survives_child_cleanup_state_loss_and_resumes_after_new_calls(self):
        before = self.session(self.build()[0])['cost']
        # The host deletes the finished child and archives its transcript.
        records = [json.loads(row[0]) for row in self.agent.execute("SELECT event_json FROM transcript_events WHERE session_id = 'child-a' ORDER BY seq")]
        for table, column in (('transcript_events', 'session_id'), ('session_windows', 'session_id'), ('session_nodes', 'current_session_id')):
            self.agent.execute(f'DELETE FROM {table} WHERE {column} = ?', ('child-a',))
        self.archive('child-a', 'agent:liv:subagent:a', records, compress=True)
        result, additions = self.build()
        self.assertEqual((additions, self.session(result)['cost']), (0, before))
        os.unlink(self.root / 'data/generated/sessions/state.json')
        self.assertEqual(self.build()[1], 0)
        self.say('root', 4, 'r4', {'input': 1_000_000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, run_id='turn-2')
        result, additions = self.build()
        self.assertEqual((additions, self.session(result)['cost']['root']['amount']), (1, 3.0))
        self.assertEqual(self.build()[1], 0)

    def test_a_run_first_seen_after_cleanup_still_gets_its_archived_usage(self):
        self.add_run('run-e', 'agent:liv:subagent:e', self.ROOT_KEY, ended=('ok', 5))
        self.archive('child-e', 'agent:liv:subagent:e', [self.record('e1', {'input': 3_000_000, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0})])
        late = next(run for run in self.session(self.build()[0])['runs'] if run['runId'] == 'run-e')
        self.assertEqual((late['sessionId'], late['cost']['amount']), ('agent:liv:subagent:e', 3.0))


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

    def test_zstd_transcript_payloads_decode_in_seq_order(self):
        records = [{'type': 'message', 'message': {'role': 'user', 'content': 'small'}},
                   {'type': 'message', 'message': {'role': 'assistant', 'content': 'x' * 2048}}]
        node = os.environ.get('NODE_BIN') or shutil.which('node')
        blob = subprocess.run([node, '-e', 'process.stdout.write(require("zlib").zstdCompressSync(require("fs").readFileSync(0)))'],
                              input=json.dumps(records[1]).encode(), capture_output=True, check=True).stdout
        self.db.execute('ALTER TABLE transcript_events ADD COLUMN event_zstd BLOB')
        self.db.execute('INSERT INTO transcript_events VALUES (?, ?, NULL, ?, ?)', ('current', 2, 2, blob))
        self.db.execute('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)', ('current', 1, json.dumps(records[0]), 1))
        self.db.commit()
        self.assertEqual(list(MODULE.iter_transcript_records(self.root, 'liv', self.entry)), records)

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
        self.assertNotIn('A synthetic title', json.dumps(result))
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
