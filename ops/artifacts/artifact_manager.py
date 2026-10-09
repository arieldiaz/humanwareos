#!/usr/bin/env python3
"""Promote, project, and migrate versioned review artifacts. Contract: docs/versioning.md."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

# In a runtime this file is <runtime>/framework/ops/artifacts/; the runtime holds the instance config.
RUNTIME = Path(__file__).resolve().parents[3]


def runtime_json(relative: str) -> dict:
    path = RUNTIME / relative
    return json.loads(path.read_text()) if path.is_file() else {}


INSTANCE = runtime_json("config/instance.json")
DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT") or INSTANCE.get("paths", {}).get("dataRoot")
ROOT = Path(DATA_ROOT) / "artifacts" if DATA_ROOT else None
REVIEW_ROOT = Path(DATA_ROOT) / "generated" / "review-projections" if DATA_ROOT else None
BRAND = INSTANCE.get("name", "Humanware OS")
VERSIONING = (Path(os.environ["HUMANWARE_FRAMEWORK_ROOT"]) / "surfaces" / "domain" / "versioning"
              if os.environ.get("HUMANWARE_FRAMEWORK_ROOT") else RUNTIME / "surface" / "versioning") / "versioning.mjs"
SCHEMA = 4
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REQUIRED_META = ("artifact-title", "artifact-project", "artifact-created", "artifact-updated")
SHELL_SCRIPT = '<script src="/artifacts/artifact-shell.js"></script>'
SHELL_SCRIPT_REFERENCE = 'src="/artifacts/artifact-shell.js"'
VERSIONS, DIFF = "versions", "diff"
LEGACY_LABEL = re.compile(r"\s*(?:·\s*(?:[A-Z]?\d+(?:\.\d+)?|[A-Z]\d*)|\((?:[rv]?\d+)\))\s*$")
DATE_FORMATS = ("%Y-%m-%d", "%d %b %Y", "%B %d, %Y", "%b %d, %Y", "%b %d %Y")
ARTIFACT_ADDRESS = re.compile(r"(?:.*/artifacts/)?([a-z0-9-]+)/(\d+)(?:/versions/(\d+))?/?")
MEDIA_ROOTS = [Path(DATA_ROOT) / "generated" / "media"] if DATA_ROOT else []
MEDIA_ROOTS.append(Path(os.environ.get("OPENCLAW_STATE_DIR") or Path.home() / ".openclaw") / "media")


# Registry: projects own artifacts numbered 1..N and the next number to assign; artifacts own versions numbered 1..N.

def registry_path(root: Path) -> Path:
    return root / "manifests" / "registry.json"


def revisions_root(root: Path) -> Path:
    return root / "revisions"


def load_registry(root: Path) -> dict:
    path = registry_path(root)
    return json.loads(path.read_text()) if path.exists() else {"schemaVersion": SCHEMA, "projects": []}


def write_registry(root: Path, registry: dict) -> None:
    path = registry_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(".registry.json.tmp")
    temporary.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def find_project(registry: dict, project_id: str) -> dict | None:
    return next((project for project in registry["projects"]
                 if project_id in [project["id"], *project.get("aliases", [])]), None)


def current(artifact: dict) -> dict:
    return artifact["versions"][artifact["current_version"] - 1]


def artifact_title(artifact: dict) -> str:
    return artifact.get("title") or current(artifact)["title"]


def artifact_sessions(artifact: dict) -> list[str]:
    return [*([artifact["session"]] if artifact.get("session") else []), *artifact.get("folded_sessions", [])]


def artifact_url(project_id: str, number: int) -> str:
    return f"/artifacts/{project_id}/{number}/"


def version_url(project_id: str, number: int, version: int) -> str:
    return f"{artifact_url(project_id, number)}{VERSIONS}/{version}/"


def breadcrumbs(project: dict, artifact: dict | None = None, version: int = 0, view: str = "") -> str:
    """The one artifact trail: home / Artifacts / project / artifact / Versions / n, plus History or Diff."""
    trail = [("/", BRAND), ("/artifacts/", "Artifacts"), (address_url(project["id"]), project["name"])]
    if artifact:
        url = artifact_url(project["id"], artifact["number"])
        trail.append((url, artifact_title(artifact)))
        if version or view:
            trail.append((f"{url}{VERSIONS}/", "Versions"))
        if view == "history":
            trail.append((f"{url}{VERSIONS}/history/", "History"))
        if version:
            trail.append((version_url(project["id"], artifact["number"], version), str(version)))
        if view == DIFF:
            trail.append((f"{version_url(project['id'], artifact['number'], version)}{DIFF}/", "Diff"))
    links = [f'<a href="{html.escape(url)}">{html.escape(label)}</a>' for url, label in trail[:-1]]
    links.append(f'<span class="current">{html.escape(trail[-1][1])}</span>')
    return '<nav class="os-breadcrumbs" aria-label="Breadcrumb">' + '<span class="sep">/</span>'.join(links) + '</nav>'


def iso_date(*labels: str) -> str:
    for label in labels:
        for fmt in DATE_FORMATS:
            try:
                return datetime.strptime(str(label).strip(), fmt).date().isoformat()
            except ValueError:
                continue
    return ""


# Rendering: the framework versioning renderer, one card for every grid, one page frame.

def render_version(item: dict, command: str, version_id: str = "", diff: str | None = None) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".patch") as patch:
        args = [command, version_id] if version_id else [command]
        if diff is not None:
            patch.write(diff)
            patch.flush()
            args.append(patch.name)
        node = os.environ.get("NODE_BIN") or shutil.which("node") or "/opt/homebrew/bin/node"
        return subprocess.run([node, str(VERSIONING), *args], input=json.dumps(item),
                              capture_output=True, text=True, check=True).stdout


def versioned_item(project_id: str, artifact: dict) -> dict:
    """Map a registry artifact to the framework versioned-item model."""
    number, versions = artifact["number"], []
    for version in artifact["versions"]:
        k = version["number"]
        record = {"id": f"v{k}", "number": k, "title": version["title"], "date_label": version["date_label"],
                  "url": version_url(project_id, number, k)}
        if version.get("date"):
            record["date"] = version["date"]
        if k > 1:
            record |= {"supersedes": f"v{k - 1}", "diff_url": f"{record['url']}{DIFF}/"}
        versions.append(record)
    return {"id": f"{project_id}-{number}", "title": artifact_title(artifact),
            "url": artifact_url(project_id, number), "current_version": f"v{artifact['current_version']}",
            "versions": versions}


def page(title: str, crumbs: str, body: str, scripts: str = "", footer: str = "") -> str:
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · Artifacts · {html.escape(BRAND)}</title><link rel="stylesheet" href="/os-shell.css"><link rel="stylesheet" href="/os-footer.css"><link rel="stylesheet" href="/artifacts/artifacts.css"><link rel="stylesheet" href="/artifacts/theme.css"><link rel="stylesheet" href="/versioning/versioning.css"></head>
<body><header class="os-shell-header">{crumbs}</header><main class="shell">{body}</main>{f'<footer class="os-shell-footer">{footer}</footer>' if footer else ""}{scripts}<script src="/os-shell.js"></script></body></html>'''


def card(url: str, title: str, date_label: str, label: str, links: str = "") -> str:
    """The one artifact card: a live rendered preview, shared by project and versions pages."""
    footer = f'<p class="card-links">{links}</p>' if links else ""
    return (f'<article class="card artifact-card"><a class="artifact-current" href="{html.escape(url)}">'
            f'<span class="shot"><iframe src="{html.escape(url)}" loading="lazy" tabindex="-1" aria-hidden="true" scrolling="no">'
            f'</iframe></span><h3>{html.escape(title)}</h3><span class="meta"><span>{html.escape(date_label)}</span>'
            f'<span>{html.escape(label)}</span></span></a>{footer}</article>')


def card_page(title: str, crumbs: str, intro: str, cards: list[str], footer: str = "") -> str:
    return page(title, crumbs, f'<p class="count">{intro}</p><div class="grid artifact-grid">{"".join(cards)}</div>',
                '<script src="/artifacts/preview.js"></script>', footer)


def project_page(project: dict) -> str:
    cards = []
    for artifact in sorted(project["artifacts"], key=lambda item: -item["number"]):
        number, count, shown = artifact["number"], len(artifact["versions"]), current(artifact)
        url = artifact_url(project["id"], number)
        links = f'<a href="{url}{VERSIONS}/">{count} versions</a>' if count > 1 else ""
        cards.append(card(url, f'{number} · {artifact_title(artifact)}', shown["date_label"], f"#{number}", links))
    return card_page(project["name"], breadcrumbs(project), f'{len(project["artifacts"])} artifacts', cards)


def versions_page(project: dict, artifact: dict, footer: str) -> str:
    """Every version as a rendered card, newest first, linking its diff and the history list."""
    project_id, number, count = project["id"], artifact["number"], len(artifact["versions"])
    cards = [card(version_url(project_id, number, version["number"]), version["title"], version["date_label"],
                  f'Version {version["number"]}',
                  f'<a href="{version_url(project_id, number, version["number"])}{DIFF}/">Diff from {version["number"] - 1}</a>'
                  if version["number"] > 1 else "")
             for version in reversed(artifact["versions"])]
    url = artifact_url(project_id, number)
    intro = (f'<a href="{url}">{number} · {html.escape(artifact_title(artifact))}</a> · {count} '
             f'{"version" if count == 1 else "versions"} · <a href="{url}{VERSIONS}/history/">History list</a>')
    return card_page(artifact_title(artifact), breadcrumbs(project, artifact, view=VERSIONS), intro, cards, footer)


def redirect_page(target: str) -> str:
    escaped = html.escape(target)
    return (f'<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><link rel="canonical" href="{escaped}">'
            f'<meta http-equiv="refresh" content="0;url={escaped}"><script>location.replace({json.dumps(target)}+location.hash)</script>'
            f'<a href="{escaped}">{escaped}</a>\n')


# Validation.

def validate_document(path: Path, projects: list[str]) -> list[str]:
    document = path.read_text(errors="replace")
    errors = []
    for name in REQUIRED_META:
        match = re.search(rf'<meta\s+name=["\']{name}["\']\s+content=["\']([^"\']+)', document)
        if not match:
            errors.append(f"missing {name} metadata")
        elif name == "artifact-project" and match.group(1) not in projects:
            errors.append(f"artifact-project is {match.group(1)!r}, expected one of {projects!r}")
    if SHELL_SCRIPT_REFERENCE not in document:
        errors.append("missing artifact-shell.js")
    return errors


def verify_store(root: Path, registry: dict, strict_shell: bool = True, planned: frozenset = frozenset()) -> list[str]:
    errors = [] if registry.get("schemaVersion") == SCHEMA else [f"unsupported registry schema: {registry.get('schemaVersion')!r}"]
    claimed: set[str] = set()
    sessions: dict[str, str] = {}
    for project in registry.get("projects", []):
        project_id = project["id"]
        names = [project_id, *project.get("aliases", [])]
        for name in names:
            if not SLUG.fullmatch(name) or name in claimed:
                errors.append(f"invalid or duplicate project address: {name}")
            claimed.add(name)
        addresses: set[str] = set()
        numbers = sorted(artifact.get("number") for artifact in project["artifacts"] if isinstance(artifact.get("number"), int))
        if numbers != list(range(1, len(project["artifacts"]) + 1)):
            errors.append(f"artifact numbers are not dense 1..N: {project_id}")
        if project.get("nextNumber") != len(project["artifacts"]) + 1:
            errors.append(f"nextNumber is not N+1: {project_id}")
        for artifact in project["artifacts"]:
            number = artifact.get("number")
            label = f"{project_id}/{number}"
            if not isinstance(number, int) or number < 1 or str(number) in addresses:
                errors.append(f"invalid or duplicate artifact number: {label}")
            addresses.add(str(number))
            for session in artifact_sessions(artifact):
                if session in sessions:
                    errors.append(f"session makes more than one artifact: {session} ({sessions[session]}, {label})")
                sessions[session] = label
            versions = artifact.get("versions", [])
            if not versions or [version.get("number") for version in versions] != list(range(1, len(versions) + 1)):
                errors.append(f"versions are not numbered 1..N: {label}")
                continue
            if not isinstance(artifact.get("current_version"), int) or not 1 <= artifact["current_version"] <= len(versions):
                errors.append(f"current version is not registered: {label}")
            for version in versions:
                target = revisions_root(root) / project_id / str(version.get("revision", ""))
                if (project_id, version.get("revision")) in planned:
                    continue
                if not SLUG.fullmatch(str(version.get("revision", ""))) or not (target / "index.html").is_file():
                    errors.append(f"missing revision: {label}/v{version['number']}")
                elif strict_shell and not target.is_symlink():
                    errors.extend(f"{label}/v{version['number']}: {error}" for error in validate_document(target / "index.html", names))
        for artifact in project["artifacts"]:
            for legacy in artifact.get("legacy", {}):
                if not SLUG.fullmatch(legacy) or legacy.isdigit() or legacy in addresses:
                    errors.append(f"invalid or duplicate legacy address: {project_id}/{legacy}")
                addresses.add(legacy)
    for old, new in registry.get("redirects", {}).items():
        if not all(SLUG.fullmatch(part) for part in old.split("/")) or shadows(registry, old):
            errors.append(f"redirect shadows a live address: {old}")
        try:
            if "/" in new and resolve(registry, new) or find_project(registry, new):
                continue
            raise LookupError(new)
        except LookupError:
            errors.append(f"redirect target is not live: {old} -> {new}")
    return errors


def shadows(registry: dict, address: str) -> bool:
    """True when a redirect at this address would sit on or under a live project or artifact address."""
    parts = address.split("/")
    project = find_project(registry, parts[0])
    if project is None:
        return False
    live = {str(a["number"]) for a in project["artifacts"]} | {name for a in project["artifacts"] for name in a.get("legacy", {})}
    return parts[0] != project["id"] or len(parts) == 1 or parts[1] in live


# Projection: a generated tree Caddy serves; revisions are never copied or rewritten.

def link_entries(address: Path, revision: Path) -> None:
    """Expose a revision's entries at a generated address that may also hold versions/ or diff/."""
    address.mkdir(parents=True)
    for entry in revision.iterdir():
        if entry.name in {VERSIONS, DIFF}:
            raise ValueError(f"revision uses a reserved name: {entry}")
        (address / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())


def version_diff(root: Path, project_id: str, previous: str, revision: str) -> str:
    def lines(revision_id: str) -> list[str]:
        return (revisions_root(root) / project_id / revision_id / "index.html").read_text(errors="replace").splitlines()
    return "\n".join(difflib.unified_diff(lines(previous), lines(revision), "previous/index.html",
                                          "current/index.html", lineterm="")) + "\n"


def project_artifact(root: Path, project_dir: Path, project: dict, artifact: dict) -> None:
    project_id, number, versions = project["id"], artifact["number"], artifact["versions"]
    model = versioned_item(project_id, artifact)
    live = project_dir / str(number)
    link_entries(live, revisions_root(root) / project_id / current(artifact)["revision"])
    footer = render_version(model, "footer", model["current_version"])
    (project_dir / f"{number}.footer.html").write_text(footer)
    (project_dir / f"{number}.crumbs.html").write_text(breadcrumbs(project, artifact))
    history = live / VERSIONS
    (history / "history").mkdir(parents=True)
    # Versions, history, and diff pages carry the artifact's own footer, not the host's.
    (history / "index.html").write_text(versions_page(project, artifact, footer))
    (history / "history" / "index.html").write_text(page(model["title"], breadcrumbs(project, artifact, view="history"),
                                                         render_version(model, "history"), footer=footer))
    for version in versions:
        k = version["number"]
        link_entries(history / str(k), revisions_root(root) / project_id / version["revision"])
        (history / f"{k}.footer.html").write_text(render_version(model, "footer", f"v{k}"))
        (history / f"{k}.crumbs.html").write_text(breadcrumbs(project, artifact, k))
        if k > 1:
            diff = version_diff(root, project_id, versions[k - 2]["revision"], version["revision"])
            (history / str(k) / DIFF).mkdir()
            (history / str(k) / DIFF / "index.html").write_text(page(version["title"], breadcrumbs(project, artifact, k, DIFF),
                                                                          render_version(model, "diff", f"v{k}", diff), footer=footer))
    for legacy, k in artifact.get("legacy", {}).items():
        (project_dir / legacy).mkdir()
        target = version_url(project_id, number, k) if k else artifact_url(project_id, number)
        (project_dir / legacy / "index.html").write_text(redirect_page(target))


def build_projection(root: Path, registry: dict, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "registry.json").write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n")
    (destination / "site.json").write_text(json.dumps({"name": BRAND}) + "\n")
    for project in registry["projects"]:
        project_dir = destination / project["id"]
        project_dir.mkdir()
        (project_dir / "index.html").write_text(project_page(project))
        for artifact in project["artifacts"]:
            project_artifact(root, project_dir, project, artifact)
        for alias in project.get("aliases", []):
            (destination / alias).symlink_to(project["id"], target_is_directory=True)
    for old, new in registry.get("redirects", {}).items():
        (destination / old).mkdir(parents=True, exist_ok=True)
        (destination / old / "index.html").write_text(redirect_page(address_url(new)))


def expected_entries(project: dict, redirects: dict) -> set[str]:
    entries = {"index.html"} | {old.split("/")[1] for old in redirects if old.startswith(f"{project['id']}/")}
    for artifact in project["artifacts"]:
        entries |= {str(artifact["number"]), f"{artifact['number']}.footer.html", f"{artifact['number']}.crumbs.html",
                    *artifact.get("legacy", {})}
    return entries


def verify_projection(root: Path, review_root: Path, registry: dict) -> list[str]:
    errors = []
    try:
        if json.loads((review_root / "registry.json").read_text()) != registry:
            errors.append("projected registry does not match canonical registry")
    except (OSError, json.JSONDecodeError):
        errors.append("missing or invalid projected registry")
    expected = {project["id"] for project in registry["projects"]}
    aliases = {alias: project["id"] for project in registry["projects"] for alias in project.get("aliases", [])}
    expected |= {old.split("/")[0] for old in registry.get("redirects", {})}
    actual = {entry.name for entry in review_root.iterdir() if not entry.name.endswith(".json")} if review_root.is_dir() else set()
    errors.extend(f"unexpected projected project: {name}" for name in sorted(actual - expected - set(aliases)))
    errors.extend(f"missing projected project: {name}" for name in sorted((expected | set(aliases)) - actual))
    for alias, project_id in aliases.items():
        if (review_root / alias).resolve() != (review_root / project_id).resolve():
            errors.append(f"wrong project alias: {alias}")
    for project in registry["projects"]:
        project_dir = review_root / project["id"]
        if not project_dir.is_dir():
            continue
        names = {entry.name for entry in project_dir.iterdir()}
        errors.extend(f"projection mismatch: {project['id']}/{name}" for name in sorted(names ^ expected_entries(project, registry.get("redirects", {}))))
        for artifact in project["artifacts"]:
            label = f"{project['id']}/{artifact['number']}"
            live = project_dir / str(artifact["number"]) / "index.html"
            revision = revisions_root(root) / project["id"] / current(artifact)["revision"] / "index.html"
            if not live.is_symlink() or live.resolve() != revision.resolve():
                errors.append(f"wrong live version: {label}")
            for version in artifact["versions"]:
                for kind in ("footer", "crumbs"):
                    if not (project_dir / str(artifact["number"]) / VERSIONS / f"{version['number']}.{kind}.html").is_file():
                        errors.append(f"missing version {kind}: {label}/v{version['number']}")
    return errors


def materialize(root: Path, review_root: Path, registry: dict) -> None:
    """Build, verify, then atomically swap the projection; the previous one survives any failure."""
    review_root.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".artifact-review-", dir=review_root.parent))
    previous = review_root.with_name(f".{review_root.name}.previous")
    try:
        build_projection(root, registry, temporary)
        errors = verify_projection(root, temporary, registry)
        if errors:
            raise ValueError("artifact projection failed:\n- " + "\n- ".join(errors))
        if previous.exists():
            shutil.rmtree(previous)
        if review_root.is_symlink():
            review_root.unlink()
        elif review_root.exists():
            review_root.replace(previous)
        temporary.replace(review_root)
        shutil.rmtree(previous, ignore_errors=True)
    except Exception:
        if not review_root.exists() and previous.exists():
            previous.replace(review_root)
        raise
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


# Creation: one session makes one artifact; every later promotion in it is that artifact's next version.

def allocate(registry: dict, project: dict) -> int:
    """Assign the project's next artifact number; a redirect left at that address yields to the new artifact."""
    if "nextNumber" not in project:
        raise ValueError(f"project {project['id']} has no nextNumber: run artifact_manager.py renumber --apply")
    number = project["nextNumber"]
    project["nextNumber"] = number + 1
    redirects = registry.get("redirects", {})
    for old in [old for old in redirects if f"{old}/".startswith(f"{project['id']}/{number}/")]:
        del redirects[old]
    return number


def add_version(registry: dict, project_id: str, project_name: str, session: str, title: str, date_label: str,
                taken: frozenset = frozenset()) -> tuple[dict, dict, dict]:
    updated = json.loads(json.dumps(registry))
    owner = next(((project, artifact) for project in updated["projects"] for artifact in project["artifacts"]
                  if session in artifact_sessions(artifact)), None)
    if owner and project_id not in [owner[0]["id"], *owner[0].get("aliases", [])]:
        raise ValueError(f"session already made artifact {owner[0]['id']}/{owner[1]['number']}")
    if owner:
        project, artifact = owner
    else:
        project = find_project(updated, project_id)
        if project is None:
            project = {"id": project_id, "name": project_name, "nextNumber": 1, "artifacts": []}
            updated["projects"].insert(0, project)
        artifact = {"number": allocate(updated, project), "session": session, "current_version": 0, "versions": []}
        project["artifacts"].append(artifact)
    k = len(artifact["versions"]) + 1
    # Renumbering never renames revisions, so an earlier artifact may already own this number's revision names.
    taken = taken | {v["revision"] for a in project["artifacts"] for v in a["versions"]}
    revision = next(name for name in (f"{artifact['number']}-v{k}" + (f"-{i}" if i > 1 else "") for i in range(1, len(taken) + 2))
                    if name not in taken)
    version = {"number": k, "revision": revision, "title": title, "date_label": date_label}
    if iso := iso_date(date_label):
        version["date"] = iso
    artifact["versions"].append(version)
    artifact["current_version"] = k
    updated["schemaVersion"] = SCHEMA
    return updated, project, artifact


def create(args: argparse.Namespace) -> None:
    if not SLUG.fullmatch(args.project):
        raise ValueError("project must be a lowercase URL slug")
    original = load_registry(args.root)
    existing = find_project(original, args.project)
    on_disk = revisions_root(args.root) / (existing["id"] if existing else args.project)
    registry, project, artifact = add_version(original, args.project, args.project_name, args.session, args.title, args.date,
                                              frozenset(entry.name for entry in on_disk.iterdir()) if on_disk.is_dir() else frozenset())
    source = Path(args.source).resolve()
    errors = (validate_document(source / "index.html", [project["id"], *project.get("aliases", [])])
              if (source / "index.html").is_file() else ["missing index.html"])
    if errors:
        raise ValueError("artifact contract failed:\n- " + "\n- ".join(errors))
    target = revisions_root(args.root) / project["id"] / current(artifact)["revision"]
    if target.exists() or target.is_symlink():
        raise ValueError(f"immutable revision already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    wrote = False
    try:
        errors = verify_store(args.root, registry, strict_shell=False)
        if errors:
            raise ValueError("artifact contract failed:\n- " + "\n- ".join(errors))
        write_registry(args.root, registry)
        wrote = True
        materialize(args.root, args.review_root, registry)
    except Exception:
        if wrote:
            write_registry(args.root, original)
        shutil.rmtree(target)
        raise
    print(artifact_url(project["id"], artifact["number"]))


# Locate: answer "where is it" from the registry and the configured media roots, never from a home-folder search.

def address_url(address: str) -> str:
    return f"/artifacts/{address}/"


def resolve(registry: dict, address: str) -> tuple[dict, dict, int]:
    """Follow grouping redirects to the live (project, artifact, version number or 0 for live)."""
    redirects = registry.get("redirects", {})
    for _ in range(len(redirects) + 1):
        match = ARTIFACT_ADDRESS.fullmatch(address.strip())
        if not match:
            raise LookupError(f"not an artifact address: {address} (expected <project>/<n>[/versions/<k>])")
        key = f"{match[1]}/{match[2]}" + (f"/{VERSIONS}/{match[3]}" if match[3] else "")
        if (key if key in redirects else f"{match[1]}/{match[2]}") in redirects:
            address = redirects.get(key) or redirects[f"{match[1]}/{match[2]}"]
            continue
        project = find_project(registry, match[1])
        artifact = next((a for a in project["artifacts"] if a["number"] == int(match[2])), None) if project else None
        if not artifact:
            raise LookupError(f"no artifact {match[1]}/{match[2]}")
        k = int(match[3] or 0)
        if not 0 <= k <= len(artifact["versions"]):
            raise LookupError(f"artifact {match[1]}/{match[2]} has no version {k}")
        return project, artifact, k
    raise LookupError(f"redirect loop at {address}")


def locate_artifact(root: Path, address: str) -> Path:
    try:
        project, artifact, k = resolve(load_registry(root), address)
    except LookupError as error:
        raise LookupError(f"{error} in {registry_path(root)}") from None
    return revisions_root(root) / project["id"] / artifact["versions"][(k or artifact["current_version"]) - 1]["revision"]


def locate_media(name: str, roots: list[Path]) -> list[Path]:
    if not name or Path(name).name != name:
        raise LookupError(f"media lookup takes a bare filename, not a path: {name}")
    found = sorted(path for root in roots if root.is_dir() for path in root.rglob(name) if path.is_file())
    if not found:
        raise LookupError(f"no media file {name} in " + ", ".join(map(str, roots)))
    return found


# Grouping: merge projects and fold artifacts by changing metadata only; old addresses become redirects.

def version_key(version: dict) -> str:
    return version.get("date") or iso_date(version["date_label"]) or "9999-12-31"


def plan_grouping(registry: dict, plan: dict) -> tuple[dict, dict[str, str], list[tuple[str, str, str]], list[str]]:
    """Apply a grouping plan to a copy of the registry.

    Returns the new registry, the old -> new address mapping of every artifact and version that moved or was
    renumbered, the revision links (project, new revision, source project/revision) a write must add, and
    warnings. Re-applying an applied plan changes nothing: merged projects resolve through redirects, and folded
    artifacts resolve to their one artifact."""
    updated = json.loads(json.dumps(registry))
    redirects = updated.setdefault("redirects", {})
    mapping: dict[str, str] = {}
    links: list[tuple[str, str, str]] = []
    warnings: list[str] = []

    def move(moves: dict[str, str], live: set[str]) -> None:
        for old, new in list(mapping.items()):
            mapping[old] = moves.get(new, new)
        for old, new in list(redirects.items()):
            redirects[old] = moves.get(new, new)
        mapping.update({old: new for old, new in moves.items() if old != new})
        redirects.update({old: new for old, new in moves.items() if old != new and old not in live})

    for spec in plan.get("projects", []):
        target = next((p for p in updated["projects"] if p["id"] == spec["id"]), None)
        if target is None:
            target = {"id": spec["id"], "name": spec.get("name", spec["id"]), "nextNumber": 1, "artifacts": []}
            updated["projects"].append(target)
        target["name"] = spec.get("name", target["name"])
        for source_id in spec.get("merge", []):
            source = next((p for p in updated["projects"] if p["id"] == source_id), None)
            if source is None:
                if redirects.get(source_id) != spec["id"]:
                    warnings.append(f"unknown project to merge: {source_id}")
                continue
            moves = {source_id: spec["id"], **{alias: spec["id"] for alias in source.get("aliases", [])}}
            taken = {v["revision"] for a in target["artifacts"] for v in a["versions"]}
            for artifact in sorted(source["artifacts"], key=lambda item: item["number"]):
                number = allocate(updated, target)
                old = f"{source_id}/{artifact['number']}"
                moves[old] = f"{spec['id']}/{number}"
                for version in artifact["versions"]:
                    revision = f"{source_id}-{version['revision']}"
                    if revision in taken:
                        raise ValueError(f"revision name collision in {spec['id']}: {revision}")
                    links.append((spec["id"], revision, f"{source_id}/{version['revision']}"))
                    moves[f"{old}/{VERSIONS}/{version['number']}"] = f"{spec['id']}/{number}/{VERSIONS}/{version['number']}"
                    version["revision"] = revision
                moves |= {f"{source_id}/{legacy}": moves[old] + (f"/{VERSIONS}/{k}" if k else "")
                          for legacy, k in artifact.pop("legacy", {}).items()}
                target["artifacts"].append(artifact | {"number": number})
            updated["projects"].remove(source)
            move(moves, set())

    claimed: dict[int, str] = {}
    for group in plan.get("groups", []):
        project = find_project(updated, group["project"])
        if project is None:
            warnings.append(f"unknown project in group {group['title']!r}: {group['project']}")
            continue
        members: list[dict] = []
        for ref in group["artifacts"]:
            address = f"{group['project']}/{ref}" if isinstance(ref, int) else ref
            try:
                owner, artifact, _ = resolve(updated, address)
            except LookupError:
                warnings.append(f"unknown artifact in group {group['title']!r}: {address}")
                continue
            if owner is not project:
                warnings.append(f"artifact outside project in group {group['title']!r}: {address}")
            elif claimed.setdefault(id(artifact), group["title"]) != group["title"]:
                warnings.append(f"artifact already in group {claimed[id(artifact)]!r}, skipped in {group['title']!r}: {address}")
            elif artifact not in members:
                members.append(artifact)
        if not members:
            continue
        members.sort(key=lambda artifact: artifact["number"])
        keeper = members[0]
        keeper["title"] = group["title"]
        if len(members) == 1:
            continue
        ordered = sorted(((version_key(v), a["number"], v["number"], a, v) for a in members for v in a["versions"]),
                         key=lambda row: row[:3])
        prefix, moves, renumbered = f"{project['id']}/", {}, {}
        for k, (_, number, old_k, _, version) in enumerate(ordered, start=1):
            moves[f"{prefix}{number}/{VERSIONS}/{old_k}"] = f"{prefix}{keeper['number']}/{VERSIONS}/{k}"
            renumbered[(number, old_k)] = k
        legacy, sessions = {}, []
        for artifact in members:
            legacy |= {name: renumbered[(artifact["number"], k)] if k else 0 for name, k in artifact.get("legacy", {}).items()}
            sessions += artifact_sessions(artifact)
            if artifact is not keeper:
                moves[f"{prefix}{artifact['number']}"] = f"{prefix}{keeper['number']}"
                project["artifacts"].remove(artifact)
        keeper["versions"] = [version | {"number": k} for k, (*_, version) in enumerate(ordered, start=1)]
        keeper["current_version"] = len(keeper["versions"])
        keeper.pop("session", None)
        keeper.pop("folded_sessions", None)
        if sessions:
            keeper["session"] = sessions[0]
        if sessions[1:]:
            keeper["folded_sessions"] = sessions[1:]
        if legacy:
            keeper["legacy"] = legacy
        live = {f"{prefix}{keeper['number']}/{VERSIONS}/{k}" for k in range(1, len(ordered) + 1)}
        move(moves, live)
    moves, dropped = densify(updated)

    def existed(address: str) -> bool:
        """Intermediate numbers assigned and renumbered within this plan were never served."""
        try:
            return not ARTIFACT_ADDRESS.fullmatch(address) or bool(resolve(registry, address))
        except LookupError:
            return False

    mapping = {old: new for old, new in ({old: moves.get(new, new) for old, new in mapping.items()} | moves).items()
               if existed(old)}
    warnings += [f"dropped redirect shadowing a live address: {old} -> {new}" for old, new in dropped if existed(old)]
    if updated.get("redirects"):
        updated["redirects"] = {old: new for old, new in updated["redirects"].items() if existed(old)}
        if not updated["redirects"]:
            updated.pop("redirects")
    grouped = {group["project"] for group in plan.get("groups", [])}
    warnings += [f"artifact in no group: {project['id']}/{artifact['number']}" for project in updated["projects"]
                 if project["id"] in grouped for artifact in project["artifacts"] if id(artifact) not in claimed]
    return updated, mapping, links, warnings


# Renumbering: artifact numbers stay dense, 1..N per project in order of each artifact's first version.

def densify(registry: dict) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Renumber every project's artifacts densely in place and set nextNumber.

    Returns the old -> new address of every artifact and version that moved, and the redirects dropped because their
    address is now live. Retired addresses and existing redirect targets follow the moves; an old address that a
    new live artifact now occupies is dropped, so it lands on that artifact."""
    moves: dict[str, str] = {}
    for project in registry["projects"]:
        ordered = sorted(project["artifacts"], key=lambda a: (min(version_key(v) for v in a["versions"]), a["number"]))
        for number, artifact in enumerate(ordered, start=1):
            if artifact["number"] != number:
                old, new = f"{project['id']}/{artifact['number']}", f"{project['id']}/{number}"
                moves[old] = new
                moves |= {f"{old}/{VERSIONS}/{k}": f"{new}/{VERSIONS}/{k}" for k in range(1, len(artifact["versions"]) + 1)}
            artifact["number"] = number
        project["artifacts"] = ordered
        project["nextNumber"] = len(ordered) + 1
    redirects = registry.setdefault("redirects", {})
    combined = {old: moves.get(new, new) for old, new in redirects.items()} | moves
    dropped = sorted((old, new) for old, new in combined.items() if shadows(registry, old))
    registry["redirects"] = {old: new for old, new in combined.items() if not shadows(registry, old)}
    if not registry["redirects"]:
        registry.pop("redirects")
    return moves, dropped


def renumber(root: Path, review_root: Path, apply: bool) -> str:
    """Densify a registry, snapshotting it under archives/ first; prints the old -> new table and dropped redirects."""
    registry = load_registry(root)
    updated = json.loads(json.dumps(registry)) | {"schemaVersion": SCHEMA}
    moves, dropped = densify(updated)
    lines = [f"artifacts renumbered: {sum(1 for old in moves if VERSIONS not in old)}"]
    for project in updated["projects"]:
        rows = [(old, new) for old, new in moves.items() if VERSIONS not in old and old.startswith(f"{project['id']}/")]
        lines += [f"{project['id']} · nextNumber {project['nextNumber']}"] + [f"  {old} -> {new}" for old, new in rows]
    lines += ["", f"dropped redirects: {len(dropped)}", *(f"  {old} -> {new}" for old, new in dropped)]
    untitled = [f"{p['id']}/{a['number']} (version title: {current(a)['title']})" for p in updated["projects"]
                for a in p["artifacts"] if not a.get("title")]
    lines += ["", f"untitled artifacts: {len(untitled)}", *(f"  {item}" for item in untitled)]
    errors = verify_store(root, updated, strict_shell=False)
    lines += ["", f"errors: {len(errors)}", *(f"  {error}" for error in errors)]
    if apply and not errors and updated != registry:
        snapshot = root / "archives" / f"registry-{datetime.now().strftime('%Y%m%dT%H%M%S')}.json"
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(registry_path(root), snapshot)
        write_registry(root, updated)
        try:
            materialize(root, review_root, updated)
        except Exception:
            write_registry(root, registry)
            raise
        errors = verify_projection(root, review_root, updated)
        lines += [f"snapshot: {snapshot}", f"projection errors: {len(errors)}", *(f"  {error}" for error in errors)]
    return "\n".join(lines)


def grouping_layout(before: dict, after: dict, mapping: dict, warnings: list[str]) -> str:
    def counts(registry: dict) -> str:
        artifacts = sum(len(p["artifacts"]) for p in registry["projects"])
        versions = sum(len(a["versions"]) for p in registry["projects"] for a in p["artifacts"])
        return f"{len(registry['projects'])} projects, {artifacts} artifacts, {versions} versions"
    lines = [f"before: {counts(before)}", f"after:  {counts(after)}", ""]
    for project in after["projects"]:
        lines.append(f"{project['name']} ({address_url(project['id'])}) · {len(project['artifacts'])} artifacts")
        lines += [f"  {a['number']:>3} · {artifact_title(a)} · {len(a['versions'])} versions"
                  for a in sorted(project["artifacts"], key=lambda item: item["number"])]
    lines += ["", f"redirects: {len(after.get('redirects', {}))}", f"moved or renumbered addresses: {len(mapping)}"]
    lines += [f"  {old} -> {new}" for old, new in sorted(mapping.items())]
    lines += ["", f"warnings: {len(warnings)}", *(f"  {warning}" for warning in warnings)]
    return "\n".join(lines)


def group(root: Path, review_root: Path, plan: dict, write: bool) -> str:
    registry = load_registry(root)
    updated, mapping, links, warnings = plan_grouping(registry, plan)
    report = grouping_layout(registry, updated, mapping, warnings)
    if not write or updated == registry:
        errors = verify_store(root, updated, strict_shell=False, planned=frozenset((p, r) for p, r, _ in links))
        return report + f"\n\nerrors: {len(errors)}" + "".join(f"\n  {error}" for error in errors)
    created = []
    try:
        for project_id, revision, source in links:
            link = revisions_root(root) / project_id / revision
            if not link.is_symlink():
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(Path("..") / source, target_is_directory=True)
                created.append(link)
        errors = verify_store(root, updated, strict_shell=False)
        if errors:
            raise ValueError("grouping contract failed:\n- " + "\n- ".join(errors))
        record = root / "manifests" / "groupings" / f"{date.today().isoformat()}-{hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()[:12]}.json"
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(json.dumps({"plan": plan, "mapping": mapping}, indent=2, ensure_ascii=False) + "\n")
        write_registry(root, updated)
        try:
            materialize(root, review_root, updated)
        except Exception:
            write_registry(root, registry)
            raise
    except Exception:
        for link in created:
            link.unlink()
        raise
    return report


# Migration from the flat registry: group by creating session; without one, a run of consecutive same-title revisions.

def revision_date(root: Path, project_id: str, item: dict) -> str:
    document = revisions_root(root) / project_id / item["id"] / "index.html"
    text = document.read_text(errors="replace") if document.is_file() else ""
    meta = dict(re.findall(r'<meta\s+name="artifact-([a-z-]+)"\s+content="([^"]*)"', text))
    found = iso_date(meta.get("created", ""), item.get("date_label", ""), meta.get("updated", ""))
    return found or (date.fromtimestamp(document.stat().st_mtime).isoformat() if document.is_file() else "9999-12-31")


def plan_migration(root: Path, registry: dict, sessions: dict[str, str | None]) -> dict:
    """Return a schema-3 registry: one artifact per creating session, versions and artifacts in date order.

    `sessions` maps "<project>/<revision-id>" to its creating session. Sessionless revisions that are consecutive
    in date order and share a title once legacy labels are dropped form one artifact; any other sessionless revision
    is its own. This fallback is migration-only: `create` stays strictly one session, one artifact. Old labels, including title suffixes such as " · 13" or " (r2)", are dropped; old addresses become
    hidden redirects."""
    migrated = {"schemaVersion": SCHEMA, "projects": []}
    for project in registry["projects"]:
        flat = []
        for position, item in enumerate(reversed(project["artifacts"])):
            for version in item.get("versions") or [item]:
                flat.append({**version, "position": position, "stable": item["id"] if item.get("versions") else None,
                             "session": sessions.get(f"{project['id']}/{version['id']}") or item.get("session")})
        for entry in flat:
            entry["date"] = revision_date(root, project["id"], entry)
        groups: dict[str, list[dict]] = {}
        previous = None
        for entry in sorted(flat, key=lambda entry: (entry["date"], entry["position"])):
            title = LEGACY_LABEL.sub("", entry["title"]).strip().casefold()
            key = entry["session"] or (previous[0] if previous and previous[1] == title else f"revision:{entry['id']}")
            previous = (key, title) if not entry["session"] else None
            groups.setdefault(key, []).append(entry)
        ordered = sorted(groups.items(), key=lambda group: min((entry["date"], entry["position"]) for entry in group[1]))
        artifacts = []
        for number, (key, members) in enumerate(ordered, start=1):
            members.sort(key=lambda entry: (entry["date"], entry["position"]))
            versions = [{"number": k, "revision": entry["id"], "title": LEGACY_LABEL.sub("", entry["title"]) or entry["title"],
                         "date_label": entry["date_label"],
                         **({"date": entry["date"]} if not entry["date"].startswith("9999") else {})}
                        for k, entry in enumerate(members, start=1)]
            legacy = {entry["id"]: k for k, entry in enumerate(members, start=1)}
            legacy |= {entry["stable"]: 0 for entry in members if entry["stable"]}
            artifact = {"number": number, **({"session": key} if not key.startswith("revision:") else {}),
                        "current_version": len(versions), "versions": versions, "legacy": legacy}
            artifacts.append(artifact)
        migrated["projects"].append({key: project[key] for key in ("id", "name", "aliases") if key in project}
                                    | {"nextNumber": len(artifacts) + 1, "artifacts": artifacts})
    return migrated


def migration_table(migrated: dict) -> list[dict]:
    return [{"project": project["id"], "artifact": artifact["number"], "title": current(artifact)["title"],
             "versions": len(artifact["versions"]), "session": bool(artifact.get("session")),
             "legacy": list(artifact["legacy"])}
            for project in migrated["projects"] for artifact in project["artifacts"]]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--review-root", type=Path, default=REVIEW_ROOT)
    sub = parser.add_subparsers(dest="command", required=True)
    create_parser = sub.add_parser("create", help="promote a staged page as this session's artifact's next version")
    for name in ("source", "project", "project-name", "session", "title", "date"):
        create_parser.add_argument(f"--{name}", required=True)
    sub.add_parser("rebuild")
    sub.add_parser("verify").add_argument("--allow-legacy-shell", action="store_true")
    migrate_parser = sub.add_parser("migrate", help="plan the session migration; --write applies it to --root")
    migrate_parser.add_argument("--sessions", type=Path, required=True, help='JSON {"<project>/<revision>": "<session>"|null}')
    migrate_parser.add_argument("--write", action="store_true")
    group_parser = sub.add_parser("group", help="merge projects and fold artifacts from a plan; --write applies it to --root")
    group_parser.add_argument("--plan", type=Path, required=True,
                              help='JSON {"projects": [{"id", "name", "merge": [<project>]}], "groups": [{"project", "title", "artifacts": [<n>|"<project>/<n>"]}]}')
    group_parser.add_argument("--write", action="store_true")
    renumber_parser = sub.add_parser("renumber", help="number artifacts densely by first version date; --apply snapshots and writes")
    renumber_parser.add_argument("--apply", action="store_true")
    locate_parser = sub.add_parser("locate", help="print the exact path of an artifact revision or generated media file")
    locate_parser.add_argument("kind", choices=("artifact", "media"))
    locate_parser.add_argument("target", help="<project>/<n>[/versions/<k>] or artifact URL; media filename")
    args = parser.parse_args()
    if args.command == "locate" and args.kind == "media":
        try:
            print("\n".join(map(str, locate_media(args.target, MEDIA_ROOTS))))
        except LookupError as error:
            raise SystemExit(f"locate: {error}")
        return
    if args.root is None or args.review_root is None:
        parser.error("no data root: set HUMANWARE_DATA_ROOT or run from an assembled runtime")
    if args.command == "create":
        create(args)
        return
    if args.command == "locate":
        try:
            print(locate_artifact(args.root, args.target))
        except LookupError as error:
            raise SystemExit(f"locate: {error}")
        return
    if args.command == "group":
        print(group(args.root, args.review_root, json.loads(args.plan.read_text()), args.write))
        return
    if args.command == "renumber":
        print(renumber(args.root, args.review_root, args.apply))
        return
    registry = load_registry(args.root)
    if args.command == "migrate":
        before = hashlib.sha256(registry_path(args.root).read_bytes()).hexdigest()
        migrated = plan_migration(args.root, registry, json.loads(args.sessions.read_text()))
        errors = verify_store(args.root, migrated, strict_shell=False)
        print(json.dumps({"registry_sha256": before, "errors": errors, "artifacts": migration_table(migrated),
                          "registry": migrated}, indent=2, ensure_ascii=False))
        if args.write and not errors:
            write_registry(args.root, migrated)
            materialize(args.root, args.review_root, migrated)
        return
    if args.command == "rebuild":
        materialize(args.root, args.review_root, registry)
    errors = verify_store(args.root, registry, strict_shell=not getattr(args, "allow_legacy_shell", False))
    errors.extend(verify_projection(args.root, args.review_root, registry))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
