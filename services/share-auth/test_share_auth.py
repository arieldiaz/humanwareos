import tempfile
import unittest
from pathlib import Path

from share_auth import Store, digest, valid_resource


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "auth.sqlite3", aliases={"/team-finance/": "/artifacts/team/finance-dashboard/"})

    def tearDown(self):
        self.temp.cleanup()

    def test_link_is_single_use_and_session_is_grant_scoped(self):
        _, token = self.store.invite("Person@Example.com", "/artifacts/project/revision/", now=100)
        session, resource = self.store.redeem(token, now=101)
        self.assertEqual(resource, "/artifacts/project/revision/")
        self.assertIsNone(self.store.redeem(token, now=102))
        self.assertTrue(self.store.authorized(session, "/artifacts/project/revision/index.html", now=103))
        self.assertFalse(self.store.authorized(session, "/artifacts/project/other/", now=103))

    def test_link_expires(self):
        _, token = self.store.invite("person@example.com", "/artifacts/team/finance-dashboard/", now=100)
        self.assertIsNone(self.store.redeem(token, now=100 + 901))

    def test_revoke_invalidates_session(self):
        grant_id, token = self.store.invite("person@example.com", "/artifacts/team/finance-dashboard/", now=100)
        session, _ = self.store.redeem(token, now=101)
        self.assertTrue(self.store.authorized(session, "/artifacts/team/finance-dashboard/", now=102))
        self.assertTrue(self.store.revoke(grant_id, now=103))
        self.assertFalse(self.store.authorized(session, "/artifacts/team/finance-dashboard/", now=104))

    def test_only_supported_resource_paths_are_accepted(self):
        self.assertTrue(valid_resource("/artifacts/project/revision/"))
        self.assertTrue(valid_resource("/artifacts/team/finance-dashboard/"))
        self.assertFalse(valid_resource("/stats/"))
        self.assertFalse(valid_resource("/artifacts/../secret/"))

    def test_aliased_api_requires_exact_grant(self):
        _, token = self.store.invite("reader@example.com", "/artifacts/team/finance-dashboard/", now=100)
        session, _ = self.store.redeem(token, now=101)
        self.assertTrue(self.store.authorized(session, "/team-finance/state", now=102))
        _, other = self.store.invite("reader@example.com", "/artifacts/other/revision/", now=100)
        other_session, _ = self.store.redeem(other, now=101)
        self.assertFalse(self.store.authorized(other_session, "/team-finance/state", now=102))
        self.assertFalse(valid_resource("/grist/doc/abc"))
        self.assertFalse(valid_resource("/artifacts/team/finance-dashboard/%2e%2e/"))

    def test_database_contains_hash_not_bearer_token(self):
        _, token = self.store.invite("person@example.com", "/artifacts/team/finance-dashboard/", now=100)
        with self.store.connect() as db:
            stored = db.execute("SELECT token_hash FROM links").fetchone()["token_hash"]
        self.assertEqual(stored, digest(token))
        self.assertNotEqual(stored, token)


if __name__ == "__main__":
    unittest.main()
