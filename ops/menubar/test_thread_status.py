import unittest

import thread_status


class ThreadStatusTest(unittest.TestCase):
    def test_root_status_uses_lifecycle_tile_and_human_owner_wins(self):
        reactions = [
            {"name": "calendar", "users": ["UBOT"]},
            {"name": "raised_hand", "users": ["UHUMAN"]},
        ]
        self.assertEqual(thread_status.root_status(reactions, "UHUMAN"), "act")

    def test_ambiguous_bot_tiles_are_not_invented(self):
        reactions = [
            {"name": "calendar", "users": ["UBOT1"]},
            {"name": "raised_hand", "users": ["UBOT2"]},
        ]
        self.assertIsNone(thread_status.root_status(reactions, "UHUMAN"))

    def test_snapshot_from_roots_omits_done_and_unmarked_threads(self):
        roots = {
            ("C1", "1"): {"thread_ts": "1", "reactions": [{"name": "raised_hand", "users": ["UBOT"]}]},
            ("C1", "2"): {"thread_ts": "2", "reactions": [{"name": "white_check_mark", "users": ["UHUMAN"]}]},
            ("C1", "3"): {"thread_ts": "3", "reactions": []},
        }
        snapshot = thread_status.snapshot_from_slack_roots(roots, "now", "UHUMAN")
        self.assertEqual([(item["thread_ts"], item["status"]) for item in snapshot["threads"]], [("1", "act")])

    def test_only_explicit_lifecycle_enters_menu(self):
        data = {"sessions": [
            {"channelId": "C1", "threadId": "1", "status": "active"},
            {"channelId": "C1", "threadId": "2", "outboundStatus": "working", "title": "Real work"},
            {"channelId": "C1", "threadId": "3", "outboundStatus": "done"},
        ]}
        snapshot = thread_status.snapshot_from_sessions(data)
        self.assertEqual([(item["thread_ts"], item["status"]) for item in snapshot["threads"]], [("2", "working")])

    def test_renders_explicit_groups(self):
        result = thread_status.render_groups({"threads": [{
            "status": "act", "channel_name": "work", "root_text": "Choose", "channel_id": "C1", "thread_ts": "1"
        }]}, "T1")
        self.assertEqual(result["groups"][0]["label"], "On you")
        self.assertIn("team=T1", result["groups"][0]["threads"][0]["appUrl"])

    def test_framework_label_for_working(self):
        result = thread_status.render_groups({"threads": [{
            "status": "working", "channel_name": "work", "root_text": "Build", "channel_id": "C1", "thread_ts": "1"
        }]}, "T1")
        self.assertEqual(result["groups"][0]["label"], "On agent")


if __name__ == "__main__":
    unittest.main()
