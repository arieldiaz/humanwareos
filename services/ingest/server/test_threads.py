import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "ingest",
    Path(__file__).with_name("ingest.py"),
)
ingest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ingest)


def session(**overrides):
    row = {
        "title": "OpenClaw · agent",
        "status": "idle",
        "channel": "?",
        "channelId": "C0TESTCHAN1",
        "threadId": "1787340997.744889",
        "updatedAt": "2026-08-24T14:22:15Z",
        "slackUrl": "https://example.slack.com/archives/C0TESTCHAN1/p1787340997744889",
        "workflow": None,
    }
    row.update(overrides)
    return row


class SessionMenuMapping(unittest.TestCase):
    def test_slack_index_keeps_titles_without_reaction_lifecycle(self):
        original = ingest.slack_pages

        def pages(token, method, key, **params):
            if method == "conversations.list":
                return iter([{"id": "C1", "name": "humanware-os", "is_member": True}])
            return iter([
                {
                    "ts": "1787000000.100000",
                    "latest_reply": "1787000001.200000",
                    "text": "The actual root title",
                    "reactions": [{"name": "raised_hand"}],
                },
                {
                    "ts": "1787000002.100000",
                    "text": "A closed root",
                    "reactions": [{"name": "white_check_mark"}],
                },
            ])

        ingest.slack_pages = pages
        original_domain = ingest.SLACK_WORKSPACE_DOMAIN
        ingest.SLACK_WORKSPACE_DOMAIN = "example"
        try:
            roots = ingest.slack_root_index(["token"])
        finally:
            ingest.slack_pages = original
            ingest.SLACK_WORKSPACE_DOMAIN = original_domain
        self.assertEqual(len(roots), 2)
        self.assertEqual(
            roots[("C1", "1787000000.100000")]["thread_url"],
            "https://example.slack.com/archives/C1/p1787000000100000",
        )
        self.assertEqual(roots[("C1", "1787000000.100000")]["root_text"], "The actual root title")
        for root in roots.values():
            self.assertNotIn("reactions", root)
            self.assertNotIn("closed", root)

    def test_enrichment_keeps_ledger_state_and_replaces_latest_reply_title(self):
        snapshot = ingest.snapshot_from_sessions({
            "generatedAt": "2026-08-24T14:22:15Z",
            "sessions": [session(title="Latest assistant reply", outboundStatus="working")],
        })
        roots = {
            ("C0TESTCHAN1", "1787340997.744889"): {
                "root_text": "First human message",
                "channel_name": "humanware-os",
                "thread_url": "https://example.test/root",
                "last_activity_at": "2026-08-26T18:00:00Z",
            }
        }
        enriched = ingest.enrich_session_snapshot(snapshot, roots)
        self.assertEqual(enriched["threads"][0]["status"], "working")
        self.assertEqual(enriched["threads"][0]["root_text"], "First human message")

    def test_enrichment_does_not_close_from_a_cached_root_checkmark(self):
        snapshot = ingest.snapshot_from_sessions({
            "generatedAt": "2026-08-24T14:22:15Z",
            "sessions": [session(title="Already done", status="needs_you", outboundStatus="act")],
        })
        roots = {
            ("C0TESTCHAN1", "1787340997.744889"): {
                "root_text": "Already done",
                "closed": True,
            }
        }
        enriched = ingest.enrich_session_snapshot(snapshot, roots)["threads"]
        self.assertEqual(len(enriched), 1)
        self.assertEqual(enriched[0]["status"], "act")
        self.assertNotIn("closed", enriched[0])

    def test_latest_threads_returns_ledger_immediately_while_slack_refreshes(self):
        original_read = ingest.SESSIONS_PATH
        original_tokens = ingest.os.environ.get("SLACK_BOT_TOKEN")
        original_thread = ingest.threading.Thread
        original_cache = dict(ingest.THREAD_CACHE)

        class FakePath:
            def read_text(self, encoding):
                return '{"generatedAt":"2026-08-24T14:22:15Z","sessions":[{"title":"Now","outboundStatus":"act","channel":"ops","channelId":"C1","threadId":"1"}]}'

        started = []

        class FakeThread:
            def __init__(self, **kwargs):
                started.append(kwargs)

            def start(self):
                return None

        ingest.SESSIONS_PATH = FakePath()
        ingest.os.environ["SLACK_BOT_TOKEN"] = "token"
        ingest.threading.Thread = FakeThread
        ingest.THREAD_CACHE.update(at=0.0, snapshot=None, refreshing=False)
        try:
            result = ingest.latest_threads()
        finally:
            ingest.SESSIONS_PATH = original_read
            ingest.threading.Thread = original_thread
            ingest.THREAD_CACHE.clear()
            ingest.THREAD_CACHE.update(original_cache)
            if original_tokens is None:
                ingest.os.environ.pop("SLACK_BOT_TOKEN", None)
            else:
                ingest.os.environ["SLACK_BOT_TOKEN"] = original_tokens
        self.assertTrue(result["ok"])
        self.assertEqual(result["groups"][0]["threads"][0]["title"], "Now")
        self.assertEqual(len(started), 1)

    def test_latest_threads_uses_ledger_status_despite_conflicting_root_reactions(self):
        original_read = ingest.SESSIONS_PATH
        original_tokens = ingest.os.environ.get("SLACK_BOT_TOKEN")
        original_cache = dict(ingest.THREAD_CACHE)

        class FakePath:
            def read_text(self, encoding):
                return '{"generatedAt":"2026-09-16T12:00:00Z","sessions":[{"title":"Stale","outboundStatus":"scheduled","channel":"ops","channelId":"C1","threadId":"1"}]}'

        ingest.SESSIONS_PATH = FakePath()
        ingest.os.environ["SLACK_BOT_TOKEN"] = "token"
        ingest.THREAD_CACHE.update(at=ingest.time.time(), snapshot={
            ("C1", "1"): {
                "root_text": "Current root",
                "channel_name": "ops",
                "channel_id": "C1",
                "thread_ts": "1",
                "reactions": [{"name": "raised_hand", "users": ["U_HUMAN"]}],
            }
        }, refreshing=False)
        try:
            result = ingest.latest_threads()
        finally:
            ingest.SESSIONS_PATH = original_read
            ingest.THREAD_CACHE.clear()
            ingest.THREAD_CACHE.update(original_cache)
            if original_tokens is None:
                ingest.os.environ.pop("SLACK_BOT_TOKEN", None)
            else:
                ingest.os.environ["SLACK_BOT_TOKEN"] = original_tokens
        self.assertEqual(result["groups"][0]["status"], "scheduled")
        self.assertEqual(result["groups"][0]["threads"][0]["title"], "Current root")

    def test_enrichment_rejects_parent_thread_metadata_as_a_title(self):
        snapshot = ingest.snapshot_from_sessions({
            "generatedAt": "2026-08-24T14:22:15Z",
            "sessions": [session(title="Review the menu app", outboundStatus="working")],
        })
        roots = {
            ("C0TESTCHAN1", "1787340997.744889"): {
                "root_text": "Parent thread: C0TESTCHAN1 1787000000.100000 <@U0TESTUSER1>",
                "channel_name": "humanware-os",
                "thread_url": "https://example.test/root",
            }
        }
        enriched = ingest.enrich_session_snapshot(snapshot, roots)
        self.assertEqual(enriched["threads"][0]["root_text"], "Review the menu app")
        self.assertEqual(enriched["threads"][0]["thread_url"], "https://example.test/root")

    def test_missing_ledger_fails_without_reaction_fallback(self):
        from unittest.mock import patch
        with patch.object(ingest, "SESSIONS_PATH") as path:
            path.read_text.side_effect = OSError("ledger unavailable")
            result = ingest.latest_threads()
        self.assertFalse(result["ok"])
        self.assertIn("ledger unavailable", result["error"])

class RequiredConfig(unittest.TestCase):
    def test_reports_each_missing_required_value(self):
        from unittest.mock import patch
        with patch.multiple(ingest, DATA_ROOT=None, INBOX_CHANNEL="", SLACK_TEAM_ID="", SLACK_WORKSPACE_DOMAIN=""):
            missing = ingest.missing_required_config()
            self.assertEqual(ingest.main(), 2)
        self.assertEqual(len(missing), 4)
        self.assertIn("HUMANWARE_DATA_ROOT", missing)
        self.assertIn("MENUBAR_INBOX_CHANNEL", missing)
        self.assertIn("HUMANWARE_SLACK_WORKSPACE_DOMAIN", missing)

    def test_complete_config_has_nothing_missing(self):
        from pathlib import Path
        from unittest.mock import patch
        with patch.multiple(ingest, DATA_ROOT=Path("/tmp/data"), INBOX_CHANNEL="C1", SLACK_TEAM_ID="T1", SLACK_WORKSPACE_DOMAIN="example"):
            self.assertEqual(ingest.missing_required_config(), [])

    def test_doppler_store_reports_unconfigured_target(self):
        from unittest.mock import patch
        with patch.multiple(ingest, DOPPLER_PROJECT="", DOPPLER_CONFIG=""):
            self.assertIn("not set", ingest.doppler_store_user_token("U1", "xoxp"))


if __name__ == "__main__":
    unittest.main()
