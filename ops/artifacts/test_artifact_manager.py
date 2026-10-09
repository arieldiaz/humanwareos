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

    def promote(self, session: str, title: str = "Example", project: str = "learning", body: str = "",
                day: str = "22 Aug 2026") -> None:
        self.source.joinpath("index.html").write_text(document(title, project, body))
        am.create(Namespace(root=self.root, review_root=self.review, source=str(self.source), project=project,
                            project_name=project.title(), session=session, title=title, date=day))

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

    def test_locate_prints_the_revision_for_an_address_and_media_by_filename(self) -> None:
        self.promote("slack:a", "Draft")
        self.promote("slack:a", "Final", body="<p>final</p>")
        revisions = self.root / "revisions" / "learning"
        self.assertEqual(am.locate_artifact(self.root, "learning/1"), revisions / "1-v2")
        self.assertEqual(am.locate_artifact(self.root, "https://example.com/artifacts/learning/1/versions/1/"), revisions / "1-v1")
        for address, message in (("learning/2", "no artifact learning/2"), ("learning/1/versions/3", "no version 3"),
                                 ("Learning", "not an artifact address")):
            with self.assertRaisesRegex(LookupError, message):
                am.locate_artifact(self.root, address)
        media = Path(self.temporary.name) / "media"
        (media / "tool-image-generation").mkdir(parents=True)
        (media / "tool-image-generation" / "cat.png").write_bytes(b"png")
        self.assertEqual(am.locate_media("cat.png", [media, media / "missing"]), [media / "tool-image-generation" / "cat.png"])
        for name, message in (("dog.png", "no media file dog.png"), ("../cat.png", "bare filename")):
            with self.assertRaisesRegex(LookupError, message):
                am.locate_media(name, [media])

    def grouping_fixture(self) -> dict:
        self.promote("s:mac", "Mac IA", "humanware", day="01 Sep 2026")
        self.promote("s:menu", "Menu bar", "humanware-os", day="03 Sep 2026")
        self.promote("s:menu", "Menu bar 2", "humanware-os", body="<p>2</p>", day="05 Sep 2026")
        self.promote("s:records", "Records", "humanware-os", day="02 Sep 2026")
        self.promote("s:menu-b", "Menu bar B", "humanware-os", day="04 Sep 2026")
        registry = am.load_registry(self.root)
        am.find_project(registry, "humanware-os")["artifacts"][0]["legacy"] = {"old-menu": 0}
        am.write_registry(self.root, registry)
        am.materialize(self.root, self.review, registry)
        return {"projects": [{"id": "humanware", "name": "Humanware", "merge": ["humanware-os"]}],
                "groups": [{"project": "humanware", "title": "Mac operator IA", "artifacts": [1]},
                           {"project": "humanware", "title": "Menu bar app", "artifacts": ["humanware-os/3", "humanware-os/1"]},
                           {"project": "humanware", "title": "Records", "artifacts": ["humanware-os/2", "humanware-os/9"]}]}

    def test_group_dry_run_prints_the_layout_and_changes_nothing(self) -> None:
        plan = self.grouping_fixture()
        before = am.registry_path(self.root).read_bytes()
        report = am.group(self.root, self.review, plan, write=False)
        self.assertEqual(am.registry_path(self.root).read_bytes(), before)
        self.assertFalse((self.root / "revisions/humanware/humanware-os-1-v1").exists())
        self.assertIn("before: 2 projects, 4 artifacts, 5 versions", report)
        self.assertIn("after:  1 projects, 3 artifacts, 5 versions", report)
        self.assertIn("    2 · Records · 1 versions\n    3 · Menu bar app · 3 versions", report)
        self.assertIn("unknown artifact in group 'Records': humanware-os/9", report)
        self.assertIn("errors: 0", report)
        plan["groups"].pop(0)
        self.assertIn("artifact in no group: humanware/1", am.group(self.root, self.review, plan, write=False))

    def test_group_merges_projects_folds_by_date_keeps_revisions_and_redirects_old_addresses(self) -> None:
        plan = self.grouping_fixture()
        files = sorted(path.relative_to(self.root) for path in (self.root / "revisions").rglob("*") if path.is_file())
        am.group(self.root, self.review, plan, write=True)
        registry = am.load_registry(self.root)
        self.assertEqual([p["id"] for p in registry["projects"]], ["humanware"])
        artifacts = registry["projects"][0]["artifacts"]
        self.assertEqual([(a["number"], a["title"]) for a in artifacts], [(1, "Mac operator IA"), (2, "Records"), (3, "Menu bar app")])
        menu = artifacts[2]
        self.assertEqual([(v["number"], v["revision"]) for v in menu["versions"]],
                         [(1, "humanware-os-1-v1"), (2, "humanware-os-3-v1"), (3, "humanware-os-1-v2")])
        self.assertEqual((menu["current_version"], menu["session"], menu["folded_sessions"]), (3, "s:menu", ["s:menu-b"]))
        for path in files:
            self.assertTrue((self.root / path).is_file(), path)
        self.assertEqual(am.locate_artifact(self.root, "humanware-os/3").name, "humanware-os-1-v2")
        self.assertEqual(am.locate_artifact(self.root, "humanware-os/3/versions/1").name, "humanware-os-3-v1")
        self.assertEqual(am.locate_artifact(self.root, "humanware-os/2"), self.root / "revisions/humanware/humanware-os-2-v1")
        self.assertEqual(registry["redirects"]["humanware-os/old-menu"], "humanware/3")
        self.assertEqual(am.verify_store(self.root, registry, strict_shell=False), [])
        self.assertEqual(am.verify_projection(self.root, self.review, registry), [])
        self.assertIn('"/artifacts/humanware/3/versions/2/"', (self.review / "humanware-os/3/versions/1/index.html").read_text())
        self.assertIn('"/artifacts/humanware/"', (self.review / "humanware-os/index.html").read_text())
        self.assertIn("Menu bar app", (self.review / "humanware/index.html").read_text())
        record = json.loads(next((self.root / "manifests/groupings").iterdir()).read_text())
        self.assertEqual(record["mapping"]["humanware-os/1/versions/2"], "humanware/3/versions/3")
        self.promote("s:menu-b", "Menu bar C", "humanware", body="<p>c</p>", day="06 Sep 2026")
        self.assertEqual(len(am.load_registry(self.root)["projects"][0]["artifacts"][2]["versions"]), 4)

    def test_group_is_idempotent_and_rebuild_reflects_it(self) -> None:
        plan = self.grouping_fixture()
        am.group(self.root, self.review, plan, write=True)
        before = am.registry_path(self.root).read_bytes()
        report = am.group(self.root, self.review, plan, write=True)
        self.assertEqual(am.registry_path(self.root).read_bytes(), before)
        self.assertIn("plan already applied: ", report)
        self.assertIn("moved or renumbered addresses: 0", am.group(self.root, self.review, plan | {"note": 1}, write=False))
        self.assertEqual(len(list((self.root / "manifests/groupings").iterdir())), 1)
        registry = am.load_registry(self.root)
        am.materialize(self.root, self.review, registry)
        self.assertEqual(am.verify_projection(self.root, self.review, registry), [])

    def test_group_moves_listed_versions_renumbers_by_date_and_removes_emptied_artifacts(self) -> None:
        for session, day in (("s:a", "01"), ("s:b", "02"), ("s:a", "03"), ("s:c", "04"), ("s:a", "05"), ("s:c", "06")):
            self.promote(session, session, body=f"<p>{day}</p>", day=f"{day} Sep 2026")
        plan = {"groups": [{"project": "learning", "title": "A", "artifacts": [1]},
                           {"project": "learning", "title": "B", "artifacts": [2, "learning/1/versions/2", "learning/3/versions/2",
                                                                               "learning/3/versions/1"]}]}
        before = am.load_registry(self.root)
        am.group(self.root, self.review, plan, write=True)
        registry = am.load_registry(self.root)
        artifacts = registry["projects"][0]["artifacts"]
        self.assertEqual([(a["title"], [v["revision"] for v in a["versions"]]) for a in artifacts],
                         [("A", ["1-v1", "1-v3"]), ("B", ["2-v1", "1-v2", "3-v1", "3-v2"])])
        for old, new in (("learning/1/versions/3", "learning/1/versions/2"),
                         ("learning/3", "learning/2"), ("learning/3/versions/1", "learning/2/versions/3")):
            self.assertEqual(registry["redirects"][old], new)
        self.assertEqual(am.locate_artifact(self.root, "learning/3/versions/2").name, "3-v2")
        record = json.loads(next((self.root / "manifests/groupings").iterdir()).read_text())
        self.assertEqual(record["mapping"]["learning/1/versions/2"], "learning/2/versions/2")
        self.assertEqual(am.verify_projection(self.root, self.review, registry), [])
        self.assertIn("plan already applied: ", am.group(self.root, self.review, plan, write=False))
        for groups, message in (([["learning/2/versions/1", 1, "learning/2/versions/1"]], "version listed twice"),
                                ([[1, 2], [3, "learning/2/versions/1"]], "folded into 'G0' but one of its versions")):
            with self.assertRaisesRegex(ValueError, message):
                am.plan_grouping(before, {"groups": [{"project": "learning", "title": f"G{i}", "artifacts": refs}
                                                       for i, refs in enumerate(groups)]})
        self.promote("s:a", "s:a", body="<p>07</p>", day="07 Sep 2026")
        self.assertNotIn("learning/1/versions/3", am.load_registry(self.root)["redirects"])

    def test_group_redirects_compose_version_resequencing_with_dense_renumber(self) -> None:
        for session, day in (("s:a", "01"), ("s:b", "02"), ("s:c", "03"), ("s:b", "04")):
            self.promote(session, session, body=f"<p>{day}</p>", day=f"{day} Sep 2026")
        before = am.load_registry(self.root)
        held = {f"learning/{a['number']}/versions/{v['number']}": v["revision"]
                for a in before["projects"][0]["artifacts"] for v in a["versions"]}
        plan = {"groups": [{"project": "learning", "title": "B", "artifacts": [2, "learning/1/versions/1"]},
                           {"project": "learning", "title": "C", "artifacts": [3]}]}
        am.group(self.root, self.review, plan, write=True)
        registry = am.load_registry(self.root)
        self.assertEqual(registry["redirects"]["learning/2/versions/2"], "learning/1/versions/3")
        record = json.loads(next((self.root / "manifests/groupings").iterdir()).read_text())
        for old, revision in held.items():
            self.assertEqual(am.locate_artifact(self.root, record["mapping"].get(old, old)).name, revision, old)
            if old in registry.get("redirects", {}):
                self.assertEqual(am.locate_artifact(self.root, old).name, revision, old)

    def test_allocator_uses_next_number_yields_redirects_and_never_reuses_a_revision_name(self) -> None:
        self.promote("s:a", "A")
        registry = am.load_registry(self.root)
        self.assertEqual(registry["projects"][0]["nextNumber"], 2)
        (self.root / "revisions/learning/2-v1").mkdir()
        registry["redirects"] = {"learning/2": "learning/1", "learning/2/versions/1": "learning/1/versions/1", "learning/20": "learning/1"}
        am.write_registry(self.root, registry)
        self.promote("s:b", "B")
        registry = am.load_registry(self.root)
        artifact = registry["projects"][0]["artifacts"][1]
        self.assertEqual((artifact["number"], artifact["versions"][0]["revision"], registry["projects"][0]["nextNumber"]), (2, "2-v1-2", 3))
        self.assertEqual(registry["redirects"], {"learning/20": "learning/1"})
        self.assertEqual(am.verify_store(self.root, registry), [])
        del registry["projects"][0]["nextNumber"]
        with self.assertRaisesRegex(ValueError, "no nextNumber: run artifact_manager.py renumber"):
            am.add_version(registry, "learning", "Learning", "s:c", "C", "22 Aug 2026")

    def sparse_fixture(self) -> dict:
        for session, day in (("s:a", "03 Sep 2026"), ("s:b", "01 Sep 2026"), ("s:c", "02 Sep 2026")):
            self.promote(session, session, day=day)
        registry = am.load_registry(self.root)
        artifacts = registry["projects"][0]["artifacts"]
        for artifact, number in zip(artifacts, (4, 7, 9)):
            artifact["number"] = number
        registry["schemaVersion"] = 3
        registry["projects"][0].pop("nextNumber")
        registry["redirects"] = {"learning/1": "learning/7", "learning/3/versions/1": "learning/9", "learning/12": "learning/9/versions/1"}
        am.write_registry(self.root, registry)
        return registry

    def test_renumber_densifies_by_first_version_date_and_drops_colliding_redirects(self) -> None:
        before = self.sparse_fixture()
        report = am.renumber(self.root, self.review, apply=False)
        self.assertEqual(am.load_registry(self.root), before)
        self.assertIn("learning/7 -> learning/1\n  learning/9 -> learning/2\n  learning/4 -> learning/3", report)
        self.assertIn("dropped redirects: 2\n  learning/1 -> learning/1\n  learning/3/versions/1 -> learning/2", report)
        self.assertIn("untitled artifacts: 3\n  learning/1 (version title: s:b)", report)
        report = am.renumber(self.root, self.review, apply=True)
        self.assertIn("errors: 0", report)
        self.assertIn("projection errors: 0", report)
        registry = am.load_registry(self.root)
        project = registry["projects"][0]
        self.assertEqual(([a["number"] for a in project["artifacts"]], [a["session"] for a in project["artifacts"]], project["nextNumber"]),
                         ([1, 2, 3], ["s:b", "s:c", "s:a"], 4))
        self.assertEqual(registry["redirects"], {"learning/12": "learning/2/versions/1", "learning/4": "learning/3",
                                                 "learning/4/versions/1": "learning/3/versions/1",
                                                 "learning/7": "learning/1", "learning/7/versions/1": "learning/1/versions/1",
                                                 "learning/9": "learning/2", "learning/9/versions/1": "learning/2/versions/1"})
        self.assertEqual(json.loads(next((self.root / "archives").iterdir()).read_text()), before)
        self.assertEqual(am.verify_store(self.root, registry), [])
        self.assertEqual(am.locate_artifact(self.root, "learning/9").name, "3-v1")
        self.assertIn("errors: 0\n", am.renumber(self.root, self.review, apply=True) + "\n")
        self.assertEqual(len(list((self.root / "archives").iterdir())), 1)

    def test_contract_requires_dense_numbers_next_number_and_unshadowed_redirects(self) -> None:
        self.promote("s:a")
        self.promote("s:b")
        registry = am.load_registry(self.root)
        registry["projects"][0]["artifacts"][1]["number"] = 3
        registry["redirects"] = {"learning/1/versions/1": "learning/1", "learning/1/versions/2": "learning/1"}
        errors = am.verify_store(self.root, registry)
        self.assertIn("artifact numbers are not dense 1..N: learning", errors)
        self.assertIn("redirect shadows a live address: learning/1/versions/1", errors)
        self.assertNotIn("redirect shadows a live address: learning/1/versions/2", errors)
        registry["projects"][0]["nextNumber"] = 5
        self.assertIn("nextNumber is not N+1: learning", am.verify_store(self.root, registry))

    def test_every_artifact_page_carries_the_one_server_side_breadcrumb_trail(self) -> None:
        self.promote("s:a", "Draft")
        self.promote("s:a", "Final", body="<p>final</p>")
        live, home = self.review / "learning", '<a href="/">Humanware OS</a><span class="sep">/</span><a href="/artifacts/">Artifacts</a>'
        project = f'{home}<span class="sep">/</span><a href="/artifacts/learning/">Learning</a>'
        artifact = f'{project}<span class="sep">/</span><a href="/artifacts/learning/1/">Final</a><span class="sep">/</span>'
        versions = f'{artifact}<a href="/artifacts/learning/1/versions/">Versions</a><span class="sep">/</span>'
        with patch.object(am, "BRAND", "Humanware OS"):
            am.materialize(self.root, self.review, am.load_registry(self.root))
        pages = {"index.html": f'{home}<span class="sep">/</span><span class="current">Learning</span>',
                 "1.crumbs.html": f'{project}<span class="sep">/</span><span class="current">Final</span>',
                 "1/versions/index.html": f'{artifact}<span class="current">Versions</span>',
                 "1/versions/history/index.html": f'{versions}<span class="current">History</span>',
                 "1/versions/1.crumbs.html": f'{versions}<span class="current">1</span>',
                 "1/versions/2/diff/index.html": f'{versions}<a href="/artifacts/learning/1/versions/2/">2</a><span class="sep">/</span><span class="current">Diff</span>'}
        for name, trail in pages.items():
            self.assertIn(f'<nav class="os-breadcrumbs" aria-label="Breadcrumb">{trail}</nav>', (live / name).read_text(), name)
        self.assertIn('<header class="os-shell-header"><nav', (live / "index.html").read_text())
        (live / "1/versions/1.crumbs.html").unlink()
        self.assertIn("missing version crumbs: learning/1/v1", am.verify_projection(self.root, self.review, am.load_registry(self.root)))


if __name__ == "__main__":
    unittest.main()
