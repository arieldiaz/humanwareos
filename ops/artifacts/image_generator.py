#!/usr/bin/env python3
"""Generate or edit images with the OpenAI Images API into an artifact staging folder. Contract: docs/data-plane.md.

Each image lands in <staging>/originals/ and is recorded in <staging>/provenance.json, the shape
`artifact_manager.py create` carries into the revision. Nothing is posted to any chat."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.openai.com/v1/images"
KEY = "OPENAI_API_KEY"
MODEL = "gpt-image-1.5"
ASPECTS = {"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536"}
MAX_REFERENCES = 16
ORIGINALS, PROVENANCE = "originals", "provenance.json"


def multipart(fields: dict[str, str], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
             for name, value in fields.items()]
    for name, path in files:
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
                     f"Content-Type: {kind}\r\n\r\n".encode() + path.read_bytes() + b"\r\n")
    return b"".join(parts) + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def request(fields: dict[str, str], references: list[Path], key: str) -> list[bytes]:
    """Call generations, or edits when references are given; return the decoded images."""
    if references:
        body, kind = multipart(fields, [("image[]", path) for path in references])
        url = f"{API}/edits"
    else:
        body, kind = json.dumps(fields | {"n": int(fields["n"])}).encode(), "application/json"
        url = f"{API}/generations"
    call = urllib.request.Request(url, data=body, method="POST",
                                  headers={"Authorization": f"Bearer {key}", "Content-Type": kind})
    with urllib.request.urlopen(call, timeout=600) as response:
        return [base64.b64decode(item["b64_json"]) for item in json.load(response)["data"]]


def generate(staging: Path, name: str, prompt: str, references: list[Path], *, model: str = MODEL, size: str = "auto",
             output_format: str = "png", background: str = "auto", quality: str = "auto", count: int = 1,
             key: str | None = None) -> list[Path]:
    key = key or os.environ.get(KEY)
    if not key:
        raise ValueError(f"no API key: set {KEY} from the instance secret manager")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("name must be a lowercase slug")
    if len(references) > MAX_REFERENCES or not all(path.is_file() for path in references):
        raise ValueError(f"references must be at most {MAX_REFERENCES} existing files")
    if background == "transparent" and output_format == "jpeg":
        raise ValueError("a transparent background needs png or webp")
    fields = {"model": model, "prompt": prompt, "size": ASPECTS.get(size, size), "quality": quality,
              "output_format": output_format, "background": background, "n": str(count)}
    images = request(fields, references, key)
    originals = staging / ORIGINALS
    originals.mkdir(parents=True, exist_ok=True)
    record_path = staging / PROVENANCE
    record = json.loads(record_path.read_text()) if record_path.is_file() else {"images": []}
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    written, i = [], 1
    for image in images:
        while (path := originals / f"{name}-{i}.{output_format}").exists():
            i += 1
        path.write_bytes(image)
        written.append(path)
        record["images"].append({
            "file": f"{ORIGINALS}/{path.name}", "sha256": hashlib.sha256(image).hexdigest(), "prompt": prompt,
            "model": model, "operation": "edit" if references else "generate",
            "parameters": {field: value for field, value in fields.items() if field not in {"model", "prompt", "n"}},
            "references": [{"name": ref.name, "sha256": hashlib.sha256(ref.read_bytes()).hexdigest()} for ref in references],
            "date": stamp})
    record_path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--staging", type=Path, required=True, help="working staging folder for the artifact")
    parser.add_argument("--name", required=True, help="slug for the image files")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--reference", type=Path, action="append", default=[], help="edit from this image; repeatable")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--size", default="auto", help=f"WxH, auto, or an aspect: {', '.join(ASPECTS)}")
    parser.add_argument("--format", dest="output_format", choices=("png", "jpeg", "webp"), default="png")
    parser.add_argument("--background", choices=("auto", "opaque", "transparent"), default="auto")
    parser.add_argument("--quality", choices=("auto", "low", "medium", "high"), default="auto")
    parser.add_argument("--count", type=int, choices=range(1, 11), default=1)
    args = parser.parse_args()
    try:
        paths = generate(args.staging, args.name, args.prompt, args.reference, model=args.model, size=args.size,
                         output_format=args.output_format, background=args.background, quality=args.quality,
                         count=args.count)
    except ValueError as error:
        raise SystemExit(f"image_generator: {error}")
    print("\n".join(map(str, paths)))


if __name__ == "__main__":
    main()
