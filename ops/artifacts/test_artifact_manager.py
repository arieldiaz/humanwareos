from __future__ import annotations

import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import artifact_manager as am

VERSIONING = Path(__file__).resolve().parents[2] / "surfaces" / "domain" / "versioning" / "versioning.mjs"


def document(title: str = "Example", project: str = "learning", body: str = "") -> str:
    return (f'<html><head><meta name="artifact-title" content="{title}"><meta name="artifact-project" content="{project}">'
            f'<meta name="artifact-created" content="22 Aug 2026"><meta name="artifact-updated" content="22 Aug 2026"></head>'
            f'<body>{body}{am.SHELL_SCRIPT}</body></html>')


class ArtifactManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        base = Path(self.temporary.name)
        self.root, self.review, self.source = base / "artifacts", base / "review", base / "staged"
        self.source.mkdir()
        patcher = patch.object(am, "VERSIONING", VERSIONING)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def promote(self, session: str, title: str = "Example", project: str = "learning", body: str = "") -> None:
        self.source.joinpath("index.html").write_text(document(title, project, body))
        am.create(Namespace(root=self.root, review_root=self.review, source=str(self.source), project=project,
                            project_name=project.title(), session=session, title=title, date="22 Aug 2026"))

    def test_one_session_is_one_artifact_and_another_session_is_a_new_artifact(self) -> None:
        self.promote("slack:a", "Draft")
        self.promote("slack:a", "Draft, revised", body="<p>more</p>")
        self.promote("slack:b", "Other")
        project = am.load_registry(self.root)["projects"][0]
        self.assertEqual([(a["number"], a["session"], len(a["versions"]), a["current_version"]) for a in project["artifacts"]],
                         [(1, "slack:a", 2, 2), (2, "slack:b", 1, 1)])
        self.assertEqual([v["revision"] for v in project["artifacts"][0]["versions"]], ["1-v1", "1-v2"])
        self.assertEqual(project["artifacts"][0]["versions"][1]["date"], "2026-08-22")
        self.assertEqual(am.verify_projection(self.root, self.review, am.load_registry(self.root)), [])

    def test_a_session_cannot_start_an_artifact_in_another_project(self) -> None:
        self.promote("slack:a")
        with self.assertRaisesRegex(ValueError, "session already made artifact learning/1"):
            self.promote("slack:a", project="health")

    def test_projection_serves_live_versions_history_diffs_footers_and_redirects(self) -> None:
        self.promote("slack:a", "Draft")
        self.promote("slack:a", "Final", body="<p>final</p>")
        registry = am.load_registry(self.root)
        registry["projects"][0]["artifacts"][0]["legacy"] = {"old-draft": 1, "old-stable": 0}
        am.write_registry(self.root, registry)
        am.materialize(self.root, self.review, registry)
        live = self.review / "learning" / "1"
        self.assertEqual((live / "index.html").resolve(), (self.root / "revisions/learning/1-v2/index.html").resolve())
        self.assertEqual((live / "versions/1/index.html").resolve(), (self.root / "revisions/learning/1-v1/index.html").resolve())
        grid = (live / "versions/index.html").read_text()
        self.assertEqual(grid.count('class="card artifact-card"'), 2)
        self.assertIn('href="/artifacts/learning/1/versions/2/diff/">Diff from 1', grid)
        self.assertIn('href="/artifacts/learning/1/versions/history/"', grid)
        self.assertIn('class="card artifact-card"', (self.review / "learning/index.html").read_text())
        diff = (live / "versions/2/diff/index.html").read_text()
        self.assertIn('<code class="addition">+', diff)
        self.assertIn("&lt;p&gt;final&lt;/p&gt;", diff)
        footer = (self.review / "learning/1.footer.html").read_text()
        self.assertIn('data-hw-current="true"', footer)
        self.assertNotIn("Version 2 of 2", footer)
        self.assertIn("Version 1 of 2", (live / "versions/1.footer.html").read_text())
        self.assertIn("/artifacts/learning/1/versions/1/", (self.review / "learning/old-draft/index.html").read_text())
        self.assertIn('"/artifacts/learning/1/"', (self.review / "learning/old-stable/index.html").read_text())
        self.assertEqual(am.verify_projection(self.root, self.review, registry), [])

    def test_contract_rejects_invalid_documents_and_numbering(self) -> None:
        self.source.joinpath("index.html").write_text("<html></html>")
        with self.assertRaisesRegex(ValueError, "missing artifact-shell.js"):
            am.create(Namespace(root=self.root, review_root=self.review, source=str(self.source), project="learning",
                                project_name="Learning", session="s", title="T", date="22 Aug 2026"))
        self.assertFalse((self.root / "revisions/learning/1-v1").exists())
        self.promote("s")
        registry = am.load_registry(self.root)
        artifact = registry["projects"][0]["artifacts"][0]
        registry["projects"][0]["artifacts"].append({**artifact, "session": "t"})
        artifact["versions"][0]["number"] = 2
        errors = am.verify_store(self.root, registry)
        self.assertIn("invalid or duplicate artifact number: learning/1", errors)
        self.assertIn("versions are not numbered 1..N: learning/1", errors)

    def test_migration_groups_by_session_renumbers_by_date_and_keeps_old_addresses_as_redirects(self) -> None:
        legacy = [("iter-13", "Home · 13", "Q2", "2026-09-03"), ("iter-07", "Home · 7", "3.2", "2026-09-01"),
                  ("variants", "Variants", "F", "2026-09-02"), ("solo", "Solo", "1", "2026-08-30")]
        for revision, title, _, day in legacy:
            target = self.root / "revisions/learning" / revision
            target.mkdir(parents=True)
            target.joinpath("index.html").write_text(document(title).replace("22 Aug 2026", day))
        flat = {"schemaVersion": 1, "projects": [{"id": "learning", "name": "Learning", "artifacts": [
            {"id": revision, "project": "learning", "title": title, "number": number, "date_label": day}
            for revision, title, number, day in legacy]}]}
        am.write_registry(self.root, flat)
        before = am.registry_path(self.root).read_bytes()
        sessions = {"learning/iter-07": "slack:home", "learning/iter-13": "slack:home", "learning/variants": "codex:x",
                    "learning/solo": None}
        migrated = am.plan_migration(self.root, flat, sessions)
        self.assertEqual(am.registry_path(self.root).read_bytes(), before)
        self.assertEqual(am.verify_store(self.root, migrated), [])
        rows = [(r["artifact"], r["title"], r["versions"], r["session"]) for r in am.migration_table(migrated)]
        self.assertEqual(rows, [(1, "Solo", 1, False), (2, "Home", 2, True), (3, "Variants", 1, True)])
        home = migrated["projects"][0]["artifacts"][1]
        self.assertEqual([(v["number"], v["revision"]) for v in home["versions"]], [(1, "iter-07"), (2, "iter-13")])
        self.assertEqual(home["legacy"], {"iter-07": 1, "iter-13": 2})
        self.assertNotIn("Q2", json.dumps(migrated))
        self.assertEqual([v["title"] for v in home["versions"]], ["Home", "Home"])
        am.materialize(self.root, self.review, migrated)
        self.assertEqual(am.verify_projection(self.root, self.review, migrated), [])

    def test_migration_joins_consecutive_sessionless_revisions_with_the_same_title(self) -> None:
        legacy = [("a1", "Site · 1", "2026-07-27"), ("a2", "Site · 2", "2026-07-28"), ("s1", "Site", "2026-07-29"),
                  ("a3", "Site (r3)", "2026-07-30"), ("b1", "Other", "2026-07-31"), ("a4", "Site", "2026-08-01")]
        for revision, title, day in legacy:
            target = self.root / "revisions/learning" / revision
            target.mkdir(parents=True)
            target.joinpath("index.html").write_text(document(title).replace("22 Aug 2026", day))
        flat = {"schemaVersion": 1, "projects": [{"id": "learning", "name": "Learning", "artifacts": [
            {"id": revision, "project": "learning", "title": title, "date_label": day}
            for revision, title, day in reversed(legacy)]}]}
        migrated = am.plan_migration(self.root, flat, {"learning/s1": "slack:s"})
        self.assertEqual(am.verify_store(self.root, migrated), [])
        self.assertEqual([[v["revision"] for v in a["versions"]] for a in migrated["projects"][0]["artifacts"]],
                         [["a1", "a2"], ["s1"], ["a3"], ["b1"], ["a4"]])
        self.assertNotIn("session", migrated["projects"][0]["artifacts"][0])


if __name__ == "__main__":
    unittest.main()
