from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import artifact_manager as am
import image_generator as ig


class Response(io.BytesIO):
    def __enter__(self) -> "Response":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def respond(*images: bytes):
    calls = []

    def urlopen(request, timeout):
        calls.append(request)
        return Response(json.dumps({"data": [{"b64_json": base64.b64encode(image).decode()} for image in images]}).encode())
    return calls, urlopen


class ImageGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.staging = Path(self.temporary.name) / "staged"
        self.addCleanup(self.temporary.cleanup)

    def test_generate_writes_originals_and_provenance_that_promotion_accepts(self) -> None:
        calls, urlopen = respond(b"one", b"two")
        with patch.object(ig.urllib.request, "urlopen", urlopen):
            paths = ig.generate(self.staging, "cat", "a cat", [], size="3:2", count=2, key="test-key")
        self.assertEqual([path.name for path in paths], ["cat-1.png", "cat-2.png"])
        self.assertEqual(paths[1].read_bytes(), b"two")
        request = calls[0]
        self.assertEqual(request.full_url, f"{ig.API}/generations")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        body = json.loads(request.data)
        self.assertEqual((body["model"], body["size"], body["n"]), (ig.MODEL, "1536x1024", 2))
        record = json.loads((self.staging / "provenance.json").read_text())
        self.assertEqual([(image["file"], image["prompt"], image["operation"]) for image in record["images"]],
                         [("originals/cat-1.png", "a cat", "generate"), ("originals/cat-2.png", "a cat", "generate")])
        self.assertEqual(am.validate_media(self.staging), [])

    def test_edit_sends_references_as_multipart_and_appends_without_overwriting(self) -> None:
        reference = Path(self.temporary.name) / "ref.png"
        reference.write_bytes(b"reference")
        with patch.object(ig.urllib.request, "urlopen", respond(b"first")[1]):
            ig.generate(self.staging, "cat", "a cat", [], key="test-key")
        calls, urlopen = respond(b"edited")
        with patch.object(ig.urllib.request, "urlopen", urlopen):
            [path] = ig.generate(self.staging, "cat", "the cat, cut out", [reference, reference], output_format="webp",
                                 background="transparent", key="test-key")
        self.assertEqual(path.name, "cat-1.webp")
        self.assertEqual(calls[0].full_url, f"{ig.API}/edits")
        self.assertIn("multipart/form-data", calls[0].get_header("Content-type"))
        self.assertEqual(calls[0].data.count(b'name="image[]"; filename="ref.png"'), 2)
        latest = json.loads((self.staging / "provenance.json").read_text())["images"][-1]
        self.assertEqual((latest["operation"], latest["parameters"]["background"], latest["references"][0]["name"]),
                         ("edit", "transparent", "ref.png"))
        self.assertEqual(len(json.loads((self.staging / "provenance.json").read_text())["images"]), 2)

    def test_refuses_before_calling_the_api(self) -> None:
        with patch.object(ig.urllib.request, "urlopen") as urlopen, patch.dict(ig.os.environ, {}, clear=True):
            for kwargs, message in (({}, "set OPENAI_API_KEY"), ({"key": "k", "output_format": "jpeg",
                                                                  "background": "transparent"}, "needs png or webp")):
                with self.assertRaisesRegex(ValueError, message):
                    ig.generate(self.staging, "cat", "a cat", [], **kwargs)
            with self.assertRaisesRegex(ValueError, "existing files"):
                ig.generate(self.staging, "cat", "a cat", [Path("/missing.png")], key="k")
            urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
