#!/usr/bin/env python3
"""Generate or edit images through the signed-in Codex CLI into an artifact staging folder. Contract: docs/data-plane.md.

Codex's built-in image tool runs on the owner's ChatGPT subscription, so no API key is involved. Each image is copied
into <staging>/originals/ and recorded in <staging>/provenance.json, the shape `artifact_manager.py create` carries into
the revision. Nothing is posted to any chat."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CODEX = os.environ.get("CODEX_BIN") or shutil.which("codex") or "/opt/homebrew/bin/codex"
MAX_REFERENCES = 16
ORIGINALS, PROVENANCE = "originals", "provenance.json"


def generated_root() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "generated_images"


def instruction(prompt: str, count: int, aspect: str | None, references: list[Path]) -> str:
    lines = [f"Use your image generation tool to create {count} image(s), one tool call each, from this prompt:", "",
             prompt, ""]
    if aspect:
        lines.append(f"Aspect ratio: {aspect}.")
    if references:
        lines.append("Use the attached images as references.")
    lines.append("Do not run commands or change files. Finish by printing the absolute path of each saved image, "
                 "one per line, and nothing else.")
    return "\n".join(lines)


def run_codex(text: str, references: list[Path]) -> tuple[list[Path], str]:
    """Run one Codex turn; return the images it reports under its generated_images root, and the Codex version."""
    version = subprocess.run([CODEX, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    with tempfile.TemporaryDirectory() as scratch:
        last = Path(scratch) / "last.txt"
        # The prompt precedes --image, which is variadic and would otherwise swallow it.
        command = [CODEX, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", scratch,
                   "--output-last-message", str(last), text, *[arg for ref in references for arg in ("--image", str(ref))]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=900, stdin=subprocess.DEVNULL)
        reply = last.read_text() if last.is_file() else ""
    if result.returncode:
        raise RuntimeError(f"codex exited {result.returncode}: {(result.stderr or result.stdout).strip()[-2000:]}")
    root = generated_root().resolve()
    images = [Path(line.strip()).resolve() for line in reply.splitlines() if line.strip()]
    images = [path for path in images if path.is_relative_to(root) and path.is_file()]
    if not images:
        raise RuntimeError(f"codex reported no generated image: {reply.strip()[-2000:] or '(empty reply)'}")
    return images, version


def generate(staging: Path, name: str, prompt: str, references: list[Path], *, aspect: str | None = None,
             count: int = 1) -> list[Path]:
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        raise ValueError("name must be a lowercase slug")
    if len(references) > MAX_REFERENCES or not all(path.is_file() for path in references):
        raise ValueError(f"references must be at most {MAX_REFERENCES} existing files")
    references = [path.resolve() for path in references]
    images, version = run_codex(instruction(prompt, count, aspect, references), references)
    originals = staging / ORIGINALS
    originals.mkdir(parents=True, exist_ok=True)
    record_path = staging / PROVENANCE
    record = json.loads(record_path.read_text()) if record_path.is_file() else {"images": []}
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    taken = {path.stem for path in originals.iterdir()}
    written, i = [], 1
    for image in images:
        while f"{name}-{i}" in taken:
            i += 1
        taken.add(f"{name}-{i}")
        path = originals / f"{name}-{i}{image.suffix.lower()}"
        shutil.copyfile(image, path)
        written.append(path)
        record["images"].append({
            "file": f"{ORIGINALS}/{path.name}", "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "prompt": prompt, "generator": f"{version} image_generation",
            "operation": "edit" if references else "generate", "parameters": {"aspect": aspect, "count": count},
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
    parser.add_argument("--aspect", help="aspect ratio hint, for example 1:1, 3:2, or 16:9")
    parser.add_argument("--count", type=int, choices=range(1, 5), default=1, metavar="1-4")
    args = parser.parse_args()
    try:
        paths = generate(args.staging, args.name, args.prompt, args.reference, aspect=args.aspect, count=args.count)
    except (ValueError, RuntimeError, subprocess.SubprocessError, OSError) as error:
        raise SystemExit(f"image_generator: {error}")
    print("\n".join(map(str, paths)))


if __name__ == "__main__":
    main()
