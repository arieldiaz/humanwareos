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

    def test_reaction_tile_keeps_outbound_status(self):
        events = [{
            "kind": "tool.call",
            "ts": "2026-08-24T15:00:00Z",
            "details": {"tool": "message", "arguments": {
                "action": "react", "emoji": "raised_hand", "messageId": "123.45"
            }},
        }]
        workflow = MODULE.workflow_states(events)["123.45"]
        self.assertEqual(workflow["state"], "needs_you")
        self.assertEqual(workflow["outbound"], "act")

    def test_working_expires_when_no_run_is_running(self):
        workflow = {"state": "active", "outbound": "working"}
        self.assertIsNone(MODULE.effective_workflow(workflow, ["done"]))
        self.assertEqual(MODULE.effective_workflow(workflow, ["running"]), workflow)
        answer = {"state": "needs_you", "outbound": "answer"}
        self.assertEqual(MODULE.effective_workflow(answer, ["done"]), answer)


if __name__ == "__main__":
    unittest.main()
