import unittest

import thread_status


class ThreadStatusTest(unittest.TestCase):
    def test_only_explicit_lifecycle_enters_menu(self):
        data = {"sessions": [
            {"channelId": "C1", "threadId": "1", "status": "active"},
            {"channelId": "C1", "threadId": "2", "outboundStatus": "working", "title": "Real work"},
            {"channelId": "C1", "threadId": "3", "outboundStatus": "no_action"},
        ]}
        snapshot = thread_status.snapshot_from_sessions(data)
        self.assertEqual([(item["thread_ts"], item["status"]) for item in snapshot["threads"]], [("2", "working")])

    def test_renders_explicit_groups(self):
        result = thread_status.render_groups({"threads": [{
            "status": "answer", "channel_name": "work", "root_text": "Choose", "channel_id": "C1", "thread_ts": "1"
        }]}, "T1")
        self.assertEqual(result["groups"][0]["label"], "Clarify")
        self.assertIn("team=T1", result["groups"][0]["threads"][0]["appUrl"])

    def test_framework_label_for_working(self):
        result = thread_status.render_groups({"threads": [{
            "status": "working", "channel_name": "work", "root_text": "Build", "channel_id": "C1", "thread_ts": "1"
        }]}, "T1")
        self.assertEqual(result["groups"][0]["label"], "Working")


if __name__ == "__main__":
    unittest.main()
