#!/usr/bin/env python3
"""Reference additive artifact publisher for a tailnet-only HTTP endpoint."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("ARTIFACT_PUBLISHER_PORT", "8791"))
PRIVATE_ROOT = Path(os.environ["ARTIFACT_PRIVATE_ROOT"]).resolve()
PUBLIC_REPO = Path(os.environ["ARTIFACT_PUBLIC_REPO"]).resolve()
PUBLIC_ROOT = (PUBLIC_REPO / os.environ.get("ARTIFACT_PUBLIC_SUBDIR", "public/artifacts")).resolve()
PUBLIC_HOST = os.environ["ARTIFACT_PUBLIC_HOST"].rstrip("/")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".md", ".txt", ".svg", ".xml"}
FORBIDDEN = tuple(filter(None, os.environ.get("ARTIFACT_FORBIDDEN_MARKERS", "").split(",")))


def git(*args: str) -> str:
    result = subprocess.run(("git", *args), cwd=PUBLIC_REPO, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def preflight(source: Path) -> list[str]:
    errors: list[str] = []
    if not (source / "index.html").is_file():
        errors.append("artifact has no index.html")
    for path in source.rglob("*"):
        if path.is_symlink():
            errors.append(f"symlink is not publishable: {path.relative_to(source)}")
        elif path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            text = path.read_text(errors="replace")
            errors.extend(f"{path.relative_to(source)} references {marker!r}" for marker in FORBIDDEN if marker in text)
    return errors


def publish(project: str, artifact: str) -> dict[str, str]:
    if not SLUG.fullmatch(project) or not SLUG.fullmatch(artifact):
        raise ValueError("invalid project or artifact slug")
    source = (PRIVATE_ROOT / project / artifact).resolve()
    target = (PUBLIC_ROOT / project / artifact).resolve()
    if PRIVATE_ROOT not in source.parents or not source.is_dir() or PUBLIC_ROOT not in target.parents:
        raise ValueError("path escaped a configured root or source does not exist")
    errors = preflight(source)
    if errors:
        raise ValueError("preflight failed: " + "; ".join(errors[:8]))
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    relative = target.relative_to(PUBLIC_REPO)
    git("add", "--", str(relative))
    if git("status", "--short", "--", str(relative)):
        git("commit", "-m", f"artifacts: publish {project}/{artifact}", "--", str(relative))
        git("push", "origin", git("branch", "--show-current"))
    return {"url": f"{PUBLIC_HOST}/artifacts/{project}/{artifact}/", "commit": git("rev-parse", "--short", "HEAD")}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            if self.path != "/publish":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > 4096:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            self.respond(200, publish(str(payload.get("project", "")), str(payload.get("artifact", ""))))
        except (ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
            detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
            self.respond(400, {"error": detail or "publish failed"})

    def respond(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
