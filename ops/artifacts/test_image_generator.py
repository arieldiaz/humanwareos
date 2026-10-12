from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import artifact_manager as am
import image_generator as ig


class ImageGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.staging, self.codex_home = base / "staged", base / "codex"
        (self.codex_home / "generated_images" / "thread").mkdir(parents=True)
        patcher = patch.dict(ig.os.environ, {"CODEX_HOME": str(self.codex_home)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def codex(self, *images: bytes, reply: str | None = None, returncode: int = 0):
        """Fake the Codex CLI: write the images where Codex saves them and report their paths as its last message."""
        calls = []

        def run(command, **_):
            calls.append(command)
            if command[1] == "--version":
                return subprocess.CompletedProcess(command, 0, "codex-cli 9.9.9\n", "")
            paths = []
            for n, image in enumerate(images):
                path = self.codex_home / "generated_images" / "thread" / f"exec-{len(calls)}-{n}.png"
                path.write_bytes(image)
                paths.append(str(path))
            last = Path(command[command.index("--output-last-message") + 1])
            last.write_text(reply if reply is not None else "\n".join(paths) + "\n")
            return subprocess.CompletedProcess(command, returncode, "", "usage limit reached" if returncode else "")
        return calls, patch.object(ig.subprocess, "run", run)

    def test_generate_copies_codex_images_into_originals_with_provenance_that_promotion_accepts(self) -> None:
        calls, fake = self.codex(b"one", b"two")
        with fake:
            paths = ig.generate(self.staging, "cat", "a cat", [], aspect="3:2", count=2)
        self.assertEqual([path.name for path in paths], ["cat-1.png", "cat-2.png"])
        self.assertEqual(paths[1].read_bytes(), b"two")
        command = calls[1]
        self.assertEqual(command[:2], [ig.CODEX, "exec"])
        self.assertIn("a cat\n", command[-1])
        self.assertIn("Aspect ratio: 3:2.", command[-1])
        self.assertNotIn("--image", command)
        record = json.loads((self.staging / "provenance.json").read_text())
        self.assertEqual([(image["file"], image["prompt"], image["operation"], image["generator"]) for image in record["images"]],
                         [("originals/cat-1.png", "a cat", "generate", "codex-cli 9.9.9 image_generation"),
                          ("originals/cat-2.png", "a cat", "generate", "codex-cli 9.9.9 image_generation")])
        self.assertEqual(am.validate_media(self.staging), [])

    def test_edit_attaches_references_and_appends_without_overwriting(self) -> None:
        reference = Path(self.temporary.name) / "ref.png"
        reference.write_bytes(b"reference")
        with self.codex(b"first")[1]:
            ig.generate(self.staging, "cat", "a cat", [])
        calls, fake = self.codex(b"edited")
        with fake:
            [path] = ig.generate(self.staging, "cat", "the cat, cut out", [reference, reference])
        self.assertEqual(path.name, "cat-2.png")
        prompt_at = calls[1].index("--image") - 1
        self.assertIn("the cat, cut out", calls[1][prompt_at])
        self.assertEqual(calls[1][prompt_at + 1:], ["--image", str(reference.resolve())] * 2)
        record = json.loads((self.staging / "provenance.json").read_text())["images"]
        self.assertEqual((len(record), record[-1]["operation"], record[-1]["references"][0]["name"]), (2, "edit", "ref.png"))

    def test_reports_codex_failures_and_ignores_paths_outside_its_image_folder(self) -> None:
        with self.codex(b"x", returncode=1)[1], self.assertRaisesRegex(RuntimeError, "usage limit reached"):
            ig.generate(self.staging, "cat", "a cat", [])
        with self.codex(reply="/etc/hosts\n")[1], self.assertRaisesRegex(RuntimeError, "no generated image"):
            ig.generate(self.staging, "cat", "a cat", [])
        self.assertFalse((self.staging / "provenance.json").exists())

    def test_refuses_bad_input_before_calling_codex(self) -> None:
        calls, fake = self.codex(b"x")
        with fake:
            with self.assertRaisesRegex(ValueError, "lowercase slug"):
                ig.generate(self.staging, "Cat", "a cat", [])
            with self.assertRaisesRegex(ValueError, "existing files"):
                ig.generate(self.staging, "cat", "a cat", [Path("/missing.png")])
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
