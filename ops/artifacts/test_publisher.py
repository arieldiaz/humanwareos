import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import publisher


class PublisherTests(unittest.TestCase):
    def test_publish_sync_mirrors_the_live_version_at_the_artifact_number(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            private_root = root / "private"
            revision_root = private_root / "revisions"
            for revision, body in (("3-v1", "First"), ("3-v2", "Current version")):
                source = revision_root / "humanware-os" / revision
                source.mkdir(parents=True)
                (source / "index.html").write_text(
                    f'<meta name="artifact-title" content="Dossier"><body><main>{body}</main>'
                    '<script src="/artifacts/artifact-shell.js"></script></body>'
                )
            manifests = private_root / "manifests"
            manifests.mkdir()
            (manifests / "registry.json").write_text(json.dumps({"schemaVersion": 3, "projects": [{
                "id": "humanware-os", "aliases": ["humanware"], "artifacts": [{
                    "number": 3, "current_version": 2,
                    "versions": [{"number": 1, "revision": "3-v1"}, {"number": 2, "revision": "3-v2"}],
                }],
            }]}))
            public_repo = root / "public-repo"
            public_root = public_repo / "public" / "artifacts"
            public_root.mkdir(parents=True)
            footer = public_repo / "footer.html"
            footer.write_text('<footer class="sitefoot"><span data-footer-title></span><span data-footer-url></span></footer>')

            with (
                patch.object(publisher, "PRIVATE_ROOT", private_root),
                patch.object(publisher, "REVISION_ROOT", revision_root),
                patch.object(publisher, "PUBLIC_ORIGIN", "https://www.example.com"),
                patch.object(publisher, "PUBLIC_REPO", public_repo),
                patch.object(publisher, "PUBLIC_ROOT", public_root),
                patch.object(publisher, "PUBLIC_FOOTER", footer),
                patch.object(publisher, "run", return_value=""),
                patch.object(publisher, "set_job"),
            ):
                public_url = publisher.publish_sync("job-1", "humanware", 3)
                with self.assertRaisesRegex(ValueError, "not promoted"):
                    publisher.publish_sync("job-2", "humanware-os", 4)

            self.assertEqual(public_url, "https://www.example.com/artifacts/humanware-os/3/")
            document = (public_root / "humanware-os" / "3" / "index.html").read_text()
            self.assertIn("Current version", document)
            self.assertIn("3 · Dossier", document)
            self.assertIn(public_url, document)
            self.assertNotIn("artifact-shell.js", document)
            self.assertFalse((public_root / "humanware").exists())

    def test_preflight_rejects_private_markers(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "index.html").write_text('<a href="http://127.0.0.1:8080/">local</a>')
            self.assertEqual(publisher.preflight(source), ["index.html references private marker '127.0.0.1:'"])


if __name__ == "__main__":
    unittest.main()
