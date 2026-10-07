#!/usr/bin/env python3
"""Loopback publisher that mirrors an artifact's live version to the public site repository."""

from __future__ import annotations

import json
import html as html_lib
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

RUNTIME = Path(__file__).resolve().parents[3]


def runtime_json(relative: str) -> dict:
    path = RUNTIME / relative
    return json.loads(path.read_text()) if path.is_file() else {}


# Instance choices: config/services/artifacts.json; data root from the instance; private origin from the domain surface.
CONFIG = runtime_json("config/services/artifacts.json")
INSTANCE = runtime_json("config/instance.json")
DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT") or INSTANCE.get("paths", {}).get("dataRoot", "")
SHELL_CHROME = re.compile("|".join([re.escape(INSTANCE.get("name", "Humanware OS")), "Design Artifacts", "Design HQ"]), re.IGNORECASE)
HOST = "127.0.0.1"
PORT = int(CONFIG.get("listen", "127.0.0.1:8791").rsplit(":", 1)[1])
PRIVATE_ROOT = (Path(DATA_ROOT) / "artifacts").resolve()
REVISION_ROOT = (PRIVATE_ROOT / "revisions").resolve()
LEGACY_ROOT = Path(CONFIG.get("legacyRoot", "/nonexistent")).resolve()
PUBLIC_ORIGIN = CONFIG.get("publicOrigin", "").rstrip("/")
PUBLIC_REPO = Path(CONFIG.get("publicRepo", "/nonexistent")).resolve()
PUBLIC_ROOT = (PUBLIC_REPO / "public" / "artifacts").resolve()
PUBLIC_FOOTER = (PUBLIC_REPO / CONFIG.get("publicFooter", "public/fragments/site-footer.html")).resolve()
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
TEXT_SUFFIXES = {".html", ".css", ".js", ".json", ".md", ".txt", ".svg", ".xml"}
FORBIDDEN = (
    *CONFIG.get("privateMarkers", []),
    urlparse(runtime_json("config/surfaces/domain.json").get("privateOrigin", "")).netloc or "private-origin.invalid",
    "localhost:",
    "127.0.0.1:",
    "/Users/",
    "file://",
)
JOBS: dict[str, dict[str, str]] = {}
JOBS_LOCK = threading.Lock()


def run(*args: str) -> str:
    result = subprocess.run(args, cwd=PUBLIC_REPO, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def preflight(source: Path) -> list[str]:
    errors: list[str] = []
    if not (source / "index.html").is_file():
        errors.append("artifact has no index.html")
    for path in source.rglob("*"):
        if path.is_symlink():
            errors.append(f"symlink is not publishable: {path.relative_to(source)}")
            continue
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = path.read_text(errors="replace")
        for marker in FORBIDDEN:
            if marker in text:
                errors.append(f"{path.relative_to(source)} references private marker {marker!r}")
    return errors


def set_job(job_id: str, **values: str) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(values)


def meta_content(document: str, name: str) -> str:
    match = re.search(rf'<meta\s+name=["\']{re.escape(name)}["\']\s+content=["\']([^"\']*)["\']', document)
    return html_lib.unescape(match.group(1)).strip() if match else ""


def public_footer(document: str, public_url: str, fragment: str, number: int) -> str:
    label = f"{number} · {meta_content(document, 'artifact-title')}"
    values = {
        "title": label,
        "url": public_url,
        "created": meta_content(document, "artifact-created"),
        "updated": meta_content(document, "artifact-updated"),
    }
    footer = fragment.replace('class="sitefoot"', 'class="sitefoot public-artifact-footer"', 1)
    for field, value in values.items():
        tag = "time" if field in {"created", "updated"} else "span"
        footer = re.sub(
            rf'<{tag}([^>]*data-footer-{field}[^>]*)>.*?</{tag}>',
            lambda match: f'<{tag}{match.group(1)}>{html_lib.escape(value)}</{tag}>',
            footer,
            count=1,
            flags=re.DOTALL,
        )
    footer = re.sub(r'\s*<a\b[^>]*data-footer-history[^>]*>.*?</a>', '', footer, flags=re.DOTALL)
    return footer


def resolve_registered_artifact(registry: dict, project_id: str, number: int) -> tuple[str, str]:
    """Return the canonical project and the artifact's current revision."""
    for project in registry.get("projects", []):
        if project_id in [project["id"], *project.get("aliases", [])]:
            for artifact in project["artifacts"]:
                if artifact["number"] == number:
                    return project["id"], artifact["versions"][artifact["current_version"] - 1]["revision"]
    raise ValueError("artifact is not promoted for review")


def publish(job_id: str, project: str, artifact: int) -> None:
    try:
        set_job(job_id, state="preflight", label="Preflighting…")
        public_url = publish_sync(job_id, project, artifact)
        set_job(job_id, state="deploying", label="Waiting for www…")
        marker_url = f"{public_url}artifact-publish.json?publish={job_id}"
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(marker_url, headers={"User-Agent": "Humanware-Artifact-Publisher/1.0"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    marker = json.load(response)
                if marker.get("publish_id") == job_id:
                    set_job(job_id, state="deployed", label="Live", url=public_url)
                    return
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                pass
            time.sleep(3)
        raise ValueError("push succeeded but www deployment was not confirmed within 5 minutes")
    except (ValueError, subprocess.CalledProcessError, OSError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        set_job(job_id, state="error", label="Publish failed", error=detail or "publish failed")


def publish_sync(job_id: str, project: str, artifact: int) -> str:
    if not SLUG.fullmatch(project) or not PUBLIC_ORIGIN:
        raise ValueError("invalid project or no public origin configured")
    registry = json.loads((PRIVATE_ROOT / "manifests" / "registry.json").read_text())
    project, revision = resolve_registered_artifact(registry, project, artifact)
    public_url = f"{PUBLIC_ORIGIN}/artifacts/{project}/{artifact}/"
    source_path = REVISION_ROOT / project / revision
    if REVISION_ROOT not in source_path.absolute().parents or not source_path.exists():
        raise ValueError("registered artifact does not exist")
    source = source_path.resolve()
    if REVISION_ROOT not in source.parents and LEGACY_ROOT not in source.parents:
        raise ValueError("artifact source escaped an allowed root")
    errors = preflight(source)
    if errors:
        raise ValueError("preflight failed: " + "; ".join(errors[:8]))
    if run("git", "status", "--porcelain"):
        raise ValueError("public repository has uncommitted changes")
    run("git", "pull", "--ff-only", "origin", "main")
    target = (PUBLIC_ROOT / project / str(artifact)).resolve()
    if PUBLIC_ROOT not in target.parents:
        raise ValueError("invalid public target")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    public_index = target / "index.html"
    document = public_index.read_text()
    document = re.sub(r'\s*<script\s+src="/artifacts/artifact-shell\.js"></script>', "", document)
    shell_pattern = re.compile(r"\s*<(nav|header)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
    document = shell_pattern.sub(
        lambda match: "" if SHELL_CHROME.search(match.group(0)) else match.group(0),
        document,
    )
    footer = public_footer(document, public_url, PUBLIC_FOOTER.read_text(), artifact)
    document = document.replace("</body>", f"{footer}</body>")
    public_index.write_text(document)
    (target / "artifact-publish.json").write_text(json.dumps({"publish_id": job_id}) + "\n")
    relative = target.relative_to(PUBLIC_REPO)
    set_job(job_id, state="committing", label="Committing…")
    run("git", "add", "--", str(relative))
    run("git", "commit", "-m", f"artifacts: publish {project}/{artifact}", "--", str(relative))
    set_job(job_id, state="pushing", label="Pushing to www…")
    run("git", "push", "origin", "main")
    return public_url


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.respond(200, {"status": "ok"})
            return
        if parsed.path != "/status":
            self.send_error(404)
            return
        job_id = parse_qs(parsed.query).get("id", [""])[0]
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            payload = dict(job) if job else None
        if not payload:
            self.respond(404, {"error": "publish job not found"})
            return
        self.respond(200, payload)

    def do_POST(self) -> None:
        if self.path != "/publish":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > 4096:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            project = str(payload.get("project", ""))
            artifact = payload.get("artifact")
            if not SLUG.fullmatch(project) or not isinstance(artifact, int) or artifact < 1:
                raise ValueError("project must be a URL slug and artifact a number")
            job_id = uuid.uuid4().hex
            job = {"id": job_id, "state": "queued", "label": "Queued…"}
            with JOBS_LOCK:
                JOBS[job_id] = job
            threading.Thread(target=publish, args=(job_id, project, artifact), daemon=True).start()
            self.respond(202, job)
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

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} {format % args}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
