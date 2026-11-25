#!/usr/bin/env python3
"""One folder per session in the owner's data root, holding the session's full record.

The folder contract and commands are in README.md beside this file. Tool stores are
opened read-only; every write lands inside the data root, through a temp file and a
rename. Standard library only, so it runs under the host's system Python.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from openclaw_sessions import (  # noqa: E402
    SessionStoreError, database_path, iter_agent_ids, iter_sessions, iter_transcript_archives,
    iter_transcript_texts, logical_session_id, session_key_fields, zstd_decompress)

SCHEMA_VERSION = 1
CHUNK = 1 << 20
MARKER_WINDOW = 1 << 20
# OpenClaw's harness hook names the gateway session in each prompt it hands a CLI tool.
MARKER = re.compile(rb"session=(agent:[A-Za-z0-9_.:-]+)")
FIRST_TS = re.compile(rb'"timestamp":"([^"]+)"')
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CODEX_FILE = re.compile(rf"^rollout-.*-({UUID})\.jsonl$")
CODEX_KEY = re.compile(rf"^codex-app-server:({UUID}):")
LEGACY_FILE = re.compile(rf"^({UUID})(-topic-[0-9.]+)?\.jsonl(\..+)?$")
ISO = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$")
UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
CURSOR_TOOLS = ("cursor-agent", "cursor-ask")
PROJECTIONS = ("transcript.jsonl", "usage.json", "summary.md")


class Stores:
    """Where the data root and each tool's own storage live; tests point these at fixtures."""

    def __init__(self, data_root, openclaw=None, claude=None, codex=None, cursor=None, env=None):
        env = os.environ if env is None else env
        home = Path(env.get("HOME") or Path.home())
        self.data = Path(data_root).resolve()
        self.openclaw = Path(openclaw or env.get("OPENCLAW_STATE_DIR") or home / ".openclaw")
        self.claude = Path(claude or env.get("CLAUDE_CONFIG_DIR") or home / ".claude")
        self.codex = Path(codex or env.get("CODEX_HOME") or home / ".codex")
        self.cursor = Path(cursor or home / ".cursor")
        self.sessions = self.data / "evidence" / "sessions"

    def codex_roots(self):
        roots = [self.codex / "sessions", self.codex / "archived_sessions"]
        roots += sorted((self.openclaw / "agents").glob("*/agent/codex-home/sessions"))
        return [root for root in roots if root.is_dir()]


# --- time and names -----------------------------------------------------------------

def iso(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def millis(value):
    """Epoch milliseconds from a number or an ISO-8601 string, else None."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return int(value)
    match = ISO.match(str(value or ""))
    if not match:
        return None
    zone = match.group(3) or "+00:00"
    text = f"{match.group(1)}.{(match.group(2) or '0')[:6].ljust(6, '0')}{'+00:00' if zone == 'Z' else zone}"
    return int(datetime.fromisoformat(text).timestamp() * 1000)


def now():
    return iso(datetime.now(timezone.utc).timestamp() * 1000)


def safe(value):
    name = UNSAFE.sub("-", str(value)).strip(".") or "_"
    return name[:200]


def folder_id(logical_id):
    return safe(logical_id.replace(":", "-"))


# --- files --------------------------------------------------------------------------

def sha_file(path, limit=None):
    """SHA-256 of the file, or of its first `limit` bytes; None when it is missing or shorter."""
    digest, left = hashlib.sha256(), limit
    try:
        with open(path, "rb") as handle:
            while left is None or left > 0:
                chunk = handle.read(CHUNK if left is None else min(CHUNK, left))
                if not chunk:
                    break
                digest.update(chunk)
                if left is not None:
                    left -= len(chunk)
    except FileNotFoundError:
        return None
    return digest.hexdigest() if left in (None, 0) else None


def _temp(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path.parent / f".{path.name}.tmp-{os.getpid()}"


def write_atomic(path, data):
    temp = _temp(path)
    with open(temp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def pretty(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def versioned(path, sha):
    suffix = "".join(path.suffixes[-1:])
    stem = path.name[: len(path.name) - len(suffix)] if suffix else path.name
    return path.with_name(f"{stem}.{sha[:12]}{suffix}")


def _chunks(source):
    if source.get("path") is not None:
        with open(source["path"], "rb") as handle:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    return
                yield chunk
    else:
        yield source["data"]


def file_sources(path, name, kind):
    return {"name": name, "kind": kind, "origin": str(path), "path": Path(path)}


def tree_sources(root, prefix, kind):
    """A file source for every file below `root`, named `<prefix>/<relative path>` with safe parts."""
    found = []
    for directory, folders, files in os.walk(root):
        folders.sort()
        for file in sorted(files):
            path = Path(directory) / file
            parts = [safe(part) for part in path.relative_to(root).parts]
            found.append(file_sources(path, "/".join([prefix] + parts), kind))
    return found


# --- copying one source -------------------------------------------------------------

def source_digest(stores, entry):
    """SHA-256 of what the entry copied, re-read from the source now: (present, sha)."""
    kind = entry["kind"]
    try:
        if kind == "openclaw-events":
            data, rows = events_export(stores, entry["agent"], entry["sessionId"], entry["maxSeq"])
            data = data if rows else None
        elif kind == "openclaw-archive":
            row = next(iter_transcript_archives(stores.openclaw, entry["agent"], archive_name=entry["archiveName"]), None)
            data = row and row["archive_blob"]
        else:
            path = Path(entry["origin"])
            if not path.exists():
                return False, None
            return True, sha_file(path, entry["bytes"])
    except (SessionStoreError, sqlite3.Error, OSError):
        return False, None
    if data is None:
        return False, None
    return True, hashlib.sha256(data[: entry["bytes"]]).hexdigest()


def put(stores, folder, source, old, dry=False):
    """Copy one source into the folder unless its bytes are unchanged; returns (entry, bytes copied).

    A copy whose content is replaced by something other than its own extension is kept beside the
    new one under a versioned name, so nothing recorded is ever lost.
    """
    dest = folder / source["name"]
    extra = {key: value for key, value in source.items() if key not in ("name", "kind", "origin", "path", "data")}
    stat = os.stat(source["path"]) if source.get("path") is not None else None
    if old and stat and old.get("bytes") == stat.st_size and old.get("mtimeNs") == stat.st_mtime_ns and dest.exists():
        return old, 0
    if dry:
        if source.get("data") is not None and old and old.get("sha256") == hashlib.sha256(source["data"]).hexdigest():
            return old, 0
        return old, stat.st_size if stat else len(source["data"])
    temp, digest, size, prefix = _temp(dest), hashlib.sha256(), 0, None
    old_size = old.get("bytes") if old else None
    with open(temp, "wb") as handle:
        for chunk in _chunks(source):
            if old_size is not None and prefix is None and size + len(chunk) >= old_size:
                cut = old_size - size
                digest.update(chunk[:cut])
                prefix = digest.hexdigest()
                digest.update(chunk[cut:])
            else:
                digest.update(chunk)
            handle.write(chunk)
            size += len(chunk)
        handle.flush()
        os.fsync(handle.fileno())
    if old_size is not None and prefix is None and size == old_size:
        prefix = digest.hexdigest()
    sha = digest.hexdigest()
    base = {"name": source["name"], "kind": source["kind"], "origin": source["origin"], **extra}
    if stat:
        base["mtimeNs"] = stat.st_mtime_ns
    current = sha_file(dest) if dest.exists() else None
    if current == sha:
        os.remove(temp)
        entry = dict(old or {}, **base)
        if not old:
            entry.update(bytes=size, sha256=sha, copiedAt=now(), verified=True, verifiedAt=now())
        return entry, 0
    previous = list((old or {}).get("previous", []))
    if current is not None and not (old and current == old.get("sha256") and prefix == old.get("sha256")):
        keep = versioned(dest, current)
        os.replace(dest, keep)
        previous.append({"name": str(keep.relative_to(folder)), "sha256": current, "bytes": keep.stat().st_size, "replacedAt": now()})
    os.chmod(temp, 0o600)
    os.replace(temp, dest)
    entry = dict(base, bytes=size, sha256=sha, copiedAt=now())
    present, source_sha = source_digest(stores, entry)
    entry.update(verified=sha_file(dest) == sha and present and source_sha == sha, verifiedAt=now())
    if previous:
        entry["previous"] = previous
    return entry, size


# --- normalising transcripts --------------------------------------------------------

def _text(parts):
    return "\n".join(part for part in parts if part) or None


def _line(base, role, texts=(), calls=(), results=(), **fields):
    line = dict(base, role=role)
    text = _text(texts)
    if text:
        line["text"] = text
    if calls:
        line["toolCalls"] = list(calls)
    if results:
        line["toolResults"] = list(results)
    line.update({key: value for key, value in fields.items() if value is not None})
    return line if text or calls or results else None


def normalize_openclaw(event, agent, session_id, seq):
    if not isinstance(event, dict):
        return None
    base = {"id": f"openclaw:{agent}:{event.get('id') or f'{session_id}:{seq}'}", "ts": event.get("timestamp"),
            "source": "openclaw", "agent": agent, "sessionId": session_id, "seq": seq}
    if event.get("type") == "compaction":
        return _line(base, "system", [event.get("summary")], kind="compaction")
    message = event.get("message")
    if event.get("type") != "message" or not isinstance(message, dict):
        return None
    base["ts"] = base["ts"] or iso(millis(message.get("timestamp")))
    role, content = message.get("role"), message.get("content")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content if isinstance(content, list) else []
    texts, calls = [], []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            texts.append(block.get("text"))
        elif block.get("type") == "toolCall":
            calls.append({"id": block.get("id"), "name": block.get("name"), "input": block.get("arguments")})
    if role == "toolResult":
        result = {"toolCallId": message.get("toolCallId"), "name": message.get("toolName"),
                  "isError": message.get("isError"), "text": _text(texts)}
        return _line(base, role, results=[result])
    return _line(base, role, texts, calls, model=message.get("model"), provider=message.get("provider"))


def normalize_claude(record, session_id, index):
    message = record.get("message") if isinstance(record, dict) else None
    if record.get("type") not in ("user", "assistant") or not isinstance(message, dict):
        return None
    content = message.get("content")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content if isinstance(content, list) else []
    texts, calls, results = [], [], []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            texts.append(block.get("text"))
        elif kind == "tool_use":
            calls.append({"id": block.get("id"), "name": block.get("name"), "input": block.get("input")})
        elif kind == "tool_result":
            inner = block.get("content")
            inner = inner if isinstance(inner, str) else _text(part.get("text") for part in inner or [] if isinstance(part, dict))
            results.append({"toolCallId": block.get("tool_use_id"), "isError": block.get("is_error"), "text": inner})
    role = "toolResult" if results and not texts and not calls else message.get("role")
    base = {"id": f"claude:{session_id}:{record.get('uuid') or index}", "ts": record.get("timestamp"),
            "source": "claude", "sessionId": session_id, "seq": index}
    return _line(base, role, texts, calls, results, model=message.get("model"), sidechain=record.get("isSidechain") or None)


def normalize_codex(record, session_id, index, model):
    payload = record.get("payload") if isinstance(record, dict) else None
    if record.get("type") != "response_item" or not isinstance(payload, dict):
        return None
    base = {"id": f"codex:{session_id}:{index}", "ts": record.get("timestamp"), "source": "codex",
            "sessionId": session_id, "seq": index}
    kind = payload.get("type")
    if kind == "message":
        texts = [part.get("text") for part in payload.get("content") or [] if isinstance(part, dict)]
        return _line(base, payload.get("role"), texts, model=model if payload.get("role") == "assistant" else None)
    if kind in ("function_call", "custom_tool_call", "local_shell_call"):
        call = {"id": payload.get("call_id"), "name": payload.get("name") or kind, "input": payload.get("arguments") or payload.get("input") or payload.get("action")}
        return _line(base, "assistant", calls=[call], model=model)
    if kind in ("function_call_output", "custom_tool_call_output"):
        output = payload.get("output")
        return _line(base, "toolResult", results=[{"toolCallId": payload.get("call_id"), "text": output if isinstance(output, str) else dumps(output)}])
    return None


def normalize_cursor(record, chat_id, blob_id, index):
    if not isinstance(record, dict) or record.get("role") not in ("user", "assistant", "tool"):
        return None
    content = record.get("content")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content if isinstance(content, list) else []
    texts, calls, results = [], [], []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            texts.append(block.get("text"))
        elif block.get("type") == "tool-call":
            calls.append({"id": block.get("toolCallId"), "name": block.get("toolName"), "input": block.get("args") or block.get("input")})
        elif block.get("type") == "tool-result":
            output = block.get("result", block.get("output"))
            results.append({"toolCallId": block.get("toolCallId"), "name": block.get("toolName"),
                            "text": output if isinstance(output, str) else dumps(output)})
    base = {"id": f"cursor:{chat_id}:{blob_id}", "ts": None, "source": "cursor", "sessionId": chat_id, "seq": index}
    return _line(base, "toolResult" if record["role"] == "tool" else record["role"], texts, calls, results)


def _jsonl(text):
    for index, raw in enumerate(text.split("\n")):
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            yield index, record


def _read_jsonl(path):
    with open(path, "rb") as handle:
        return handle.read().decode("utf-8", errors="replace")


# --- OpenClaw catalog ---------------------------------------------------------------

def events_export(stores, agent, session_id, max_seq=None):
    """A window's events exactly as stored, one per line: (bytes, [(seq, text)])."""
    rows = list(iter_transcript_texts(stores.openclaw, agent, session_id, max_seq=max_seq))
    return "".join(text + "\n" for _, text in rows).encode(), rows


class Catalog:
    """Every OpenClaw session window, archive and legacy transcript file, grouped by logical session."""

    def __init__(self, stores):
        self.stores = stores
        self.sessions = defaultdict(lambda: {"windows": [], "archives": [], "legacy": []})
        self.by_key = defaultdict(list)
        self.by_window = {}
        self.bound = {}
        self.errors = []
        agents = stores.openclaw / "agents"
        for agent in sorted(path.name for path in agents.iterdir() if path.is_dir()) if agents.is_dir() else []:
            try:
                self._agent(agent)
            except (SessionStoreError, sqlite3.Error, OSError, ValueError) as error:
                self.errors.append({"source": f"openclaw:{agent}", "error": f"{type(error).__name__}: {error}"})

    def _agent(self, agent):
        state = self.stores.openclaw
        if agent in set(iter_agent_ids(state)):
            for key, entry in iter_sessions(state, agent, include_history=True):
                if not isinstance(entry, dict) or not entry.get("sessionId"):
                    continue
                logical = logical_session_id(agent, key, entry)
                window = {"agent": agent, "sessionKey": key, "sessionId": str(entry["sessionId"]), "logicalId": logical,
                          **{field: entry.get(field) for field in ("createdAt", "startedAt", "endedAt", "status", "channel", "model",
                                                                    "modelProvider", "agentHarnessId", "parentSessionKey", "spawnedBy")}}
                window["cli"] = entry.get("cliSessionIds") if isinstance(entry.get("cliSessionIds"), dict) else {}
                self.sessions[logical]["windows"].append(window)
                self.by_key[key].append(window)
                self.by_window[window["sessionId"]] = logical
                for tool, cli_id in window["cli"].items():
                    if isinstance(cli_id, str) and cli_id:
                        self.bound[("claude" if tool == "claude-cli" else "cursor" if tool in CURSOR_TOOLS else tool, cli_id)] = logical
            if database_path(state, agent).exists():
                for row in iter_transcript_archives(state, agent, blobs=False):
                    logical = self.by_window.get(row["session_id"]) or logical_session_id(
                        agent, row["session_key"], dict(session_key_fields(row["session_key"]), sessionId=row["session_id"]))
                    row = dict(row, agent=agent)
                    row.pop("archive_blob")
                    self.sessions[logical]["archives"].append(row)
        legacy = state / "agents" / agent / "sessions"
        for name in sorted(os.listdir(legacy)) if legacy.is_dir() else []:
            match = LEGACY_FILE.match(name)
            if match and ".trajectory" not in name and (legacy / name).is_file():
                logical = self.by_window.get(match.group(1)) or f"openclaw:{agent}:{match.group(1)}"
                self.sessions[logical]["legacy"].append({"agent": agent, "path": legacy / name})

    def lookup(self, query):
        """The logical session a logical id, folder id, session key or window id names, or None."""
        if query in self.sessions:
            return query
        for logical in self.sessions:
            if folder_id(logical) == query:
                return logical
        windows = self.by_key.get(query)
        if windows:
            return max(windows, key=lambda window: window.get("createdAt") or 0)["logicalId"]
        return self.by_window.get(query)

    def resolve_key(self, key, when):
        """The logical session a marker key names at time `when`, or None when the store no longer knows it."""
        fields = session_key_fields(key)
        if fields:
            return logical_session_id(key.split(":")[1], key, dict(fields, sessionId=None))
        windows = self.by_key.get(key) or []
        if not windows:
            return None
        earlier = [window for window in windows if (window.get("createdAt") or 0) <= (when or 0)]
        chosen = max(earlier, key=lambda w: w.get("createdAt") or 0) if earlier else min(windows, key=lambda w: w.get("createdAt") or 0)
        return chosen["logicalId"]


# --- tool stores --------------------------------------------------------------------

def claude_marker(path):
    """The gateway session key the CLI transcript first names, and its first timestamp."""
    with open(path, "rb") as handle:
        head = handle.read(MARKER_WINDOW)
    key, stamp = MARKER.search(head), FIRST_TS.search(head)
    return (key.group(1).decode() if key else None), millis(stamp.group(1).decode() if stamp else None)


def claude_files(stores, since_ms=None):
    files = sorted((stores.claude / "projects").glob("*/*.jsonl"))
    if since_ms is not None:
        files = [path for path in files if path.stat().st_mtime * 1000 >= since_ms]
    return files


def claude_claims(stores, catalog, files):
    """{path: logical id} for CLI transcripts an OpenClaw session owns: a live binding, else the prompt marker."""
    claims = {}
    for path in files:
        bound = catalog.bound.get(("claude", path.stem))
        if bound:
            claims[path] = bound
            continue
        try:
            key, when = claude_marker(path)
        except OSError:
            continue
        logical = key and catalog.resolve_key(key, when)
        if logical:
            claims[path] = logical
    return claims


def codex_files(stores, ids=None):
    found = {}
    for root in stores.codex_roots():
        names = ["rollout-*.jsonl"] if ids is None else [f"rollout-*-{rid}.jsonl" for rid in sorted(ids)]
        paths = [path for name in names for pattern in (f"*/*/*/{name}", name) for path in root.glob(pattern)]
        for path in sorted(paths):
            match = CODEX_FILE.match(path.name)
            if match:
                found.setdefault(match.group(1), path)
    return found


def cursor_chats(stores, ids=None):
    chats = stores.cursor / "chats"
    found = {}
    for path in sorted(chats.glob("*/*")) if chats.is_dir() else []:
        if path.is_dir() and (ids is None or path.name in ids):
            found.setdefault(path.name, path)
    return found


def claude_sources(path):
    cli_id = safe(path.stem)
    sources = [file_sources(path, f"tools/claude-{cli_id}.jsonl", "claude")]
    sidecar = path.parent / path.stem
    if sidecar.is_dir():
        sources += tree_sources(sidecar, f"tools/claude-{cli_id}", "claude")
    return sources


# --- plans --------------------------------------------------------------------------

def _plan(logical, origin, **fields):
    plan = {"logicalId": logical, "id": folder_id(logical), "origin": origin, "sources": [], "lines": [],
            "notes": [], "windows": [], "toolSessions": [], "models": set(), "harnesses": set(), "agents": set()}
    plan.update(fields)
    return plan


def _add_claude(plan, path):
    plan["sources"] += claude_sources(path)
    plan["toolSessions"].append({"tool": "claude", "id": path.stem, "path": str(path)})
    plan["harnesses"].add("claude-cli")
    memory = path.parent / "memory"
    if memory.is_dir() and memory not in plan["notes"]:
        plan["notes"].append(memory)


def plan_openclaw(stores, catalog, logical, claude_paths):
    session = catalog.sessions[logical]
    plan = _plan(logical, "openclaw", codex=set())
    cursor_ids = set()
    for window in sorted(session["windows"], key=lambda w: (w.get("createdAt") or 0, w["sessionId"])):
        agent, session_id = window["agent"], window["sessionId"]
        plan["windows"].append({key: value for key, value in window.items() if key not in ("cli", "logicalId") and value is not None})
        plan["agents"].add(agent)
        plan["models"].update(filter(None, [window.get("model")]))
        plan["harnesses"].update(filter(None, [window.get("agentHarnessId")]))
        data, rows = events_export(stores, agent, session_id)
        if rows:
            plan["sources"].append({"name": f"tools/openclaw-{safe(agent)}-{safe(session_id)}.jsonl", "kind": "openclaw-events",
                                    "origin": f"sqlite:{agent}:{session_id}:{database_path(stores.openclaw, agent)}", "data": data,
                                    "agent": agent, "sessionId": session_id, "rows": len(rows), "maxSeq": rows[-1][0]})
        for seq, text in rows:
            try:
                event = json.loads(text)
            except json.JSONDecodeError:
                continue
            _openclaw_event(plan, event, agent, session_id, seq)
        for tool, cli_id in window["cli"].items():
            if tool in CURSOR_TOOLS and isinstance(cli_id, str):
                cursor_ids.add(cli_id)
    for archive in session["archives"]:
        row = next(iter_transcript_archives(stores.openclaw, archive["agent"], archive_name=archive["archive_name"]))
        blob = row["archive_blob"]
        plan["agents"].add(archive["agent"])
        plan["sources"].append({"name": f"tools/openclaw-{safe(archive['agent'])}-{safe(archive['archive_name'])}", "kind": "openclaw-archive",
                                "origin": f"sqlite-archive:{archive['agent']}:{archive['archive_name']}:{database_path(stores.openclaw, archive['agent'])}",
                                "data": blob, "agent": archive["agent"], "sessionId": archive["session_id"],
                                "archiveName": archive["archive_name"], "reason": archive["reason"]})
        text = zstd_decompress([blob])[0] if archive["encoding"] == "zstd" else blob.decode("utf-8", errors="replace")
        for index, event in _jsonl(text):
            _openclaw_event(plan, event, archive["agent"], archive["session_id"], index)
    for legacy in session["legacy"]:
        path, agent = legacy["path"], legacy["agent"]
        plan["agents"].add(agent)
        plan["sources"].append(file_sources(path, f"tools/openclaw-{safe(agent)}-{safe(path.name)}", "openclaw-file"))
        with open(path, "rb") as handle:
            raw = handle.read()
        text = zstd_decompress([raw])[0] if path.name.endswith(".zst") else raw.decode("utf-8", errors="replace")
        for index, event in _jsonl(text):
            _openclaw_event(plan, event, agent, LEGACY_FILE.match(path.name).group(1), index)
    for path in sorted(set(claude_paths)):
        _add_claude(plan, path)
    for cli_id, path in sorted(codex_files(stores, plan["codex"]).items()):
        plan["sources"].append(file_sources(path, f"tools/codex-{safe(cli_id)}.jsonl", "codex"))
        plan["toolSessions"].append({"tool": "codex", "id": cli_id, "path": str(path)})
        plan["harnesses"].add("codex")
    for chat_id, path in sorted(cursor_chats(stores, cursor_ids).items()):
        plan["sources"] += tree_sources(path, f"tools/cursor-{safe(chat_id)}", "cursor")
        plan["toolSessions"].append({"tool": "cursor", "id": chat_id, "path": str(path)})
    starts = [w.get("createdAt") for w in session["windows"] if w.get("createdAt")]
    starts += [millis(line.get("ts")) for line in plan["lines"][:1] if line.get("ts")]
    plan["start"] = min(filter(None, starts), default=None)
    if session["windows"]:
        latest = max(session["windows"], key=lambda w: w.get("createdAt") or 0)
        plan["status"] = latest.get("status")
        ends = [w.get("endedAt") for w in session["windows"]]
        plan["end"] = max(ends) if all(ends) else None
    else:
        plan["status"] = "archived"
    return plan


def _openclaw_event(plan, event, agent, session_id, seq):
    message = event.get("message") if isinstance(event, dict) else None
    if isinstance(message, dict):
        match = CODEX_KEY.match(str(message.get("idempotencyKey") or ""))
        if match:
            plan["codex"].add(match.group(1))
    line = normalize_openclaw(event, agent, session_id, seq)
    if line:
        plan["lines"].append(line)
        plan["models"].update(filter(None, [line.get("model")]))


def plan_claude(stores, path):
    plan = _plan(f"claude:{path.stem}", "claude", status=None, end=None)
    _add_claude(plan, path)
    key = claude_marker(path)[0]
    if key:
        plan["windows"].append({"sessionKey": key, "sessionId": None, "note": "named by the CLI transcript; not in the store"})
    for index, record in _jsonl(_read_jsonl(path)):
        line = normalize_claude(record, path.stem, index)
        if line:
            plan["lines"].append(line)
            plan["models"].update(filter(None, [line.get("model")]))
    stamps = [millis(line["ts"]) for line in plan["lines"] if line.get("ts")]
    plan["start"] = min(filter(None, stamps), default=int(path.stat().st_mtime * 1000))
    return plan


def plan_codex(stores, cli_id, path):
    plan = _plan(f"codex:{cli_id}", "codex", status=None, end=None)
    plan["sources"].append(file_sources(path, f"tools/codex-{safe(cli_id)}.jsonl", "codex"))
    plan["toolSessions"].append({"tool": "codex", "id": cli_id, "path": str(path)})
    plan["harnesses"].add("codex")
    model, start = None, None
    for index, record in _jsonl(_read_jsonl(path)):
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if record.get("type") == "session_meta":
            start = start or millis(payload.get("timestamp"))
        if record.get("type") == "turn_context" and payload.get("model"):
            model = payload["model"]
            plan["models"].add(model)
        line = normalize_codex(record, cli_id, index, model)
        if line:
            plan["lines"].append(line)
    plan["start"] = start or min(filter(None, (millis(line.get("ts")) for line in plan["lines"])), default=int(path.stat().st_mtime * 1000))
    return plan


def plan_cursor(stores, chat_id, path):
    plan = _plan(f"cursor:{chat_id}", "cursor", status=None, end=None)
    plan["sources"] += tree_sources(path, f"tools/cursor-{safe(chat_id)}", "cursor")
    plan["toolSessions"].append({"tool": "cursor", "id": chat_id, "path": str(path)})
    plan["harnesses"].add("cursor-agent")
    meta = read_json(path / "meta.json") or {}
    plan["start"] = meta.get("createdAtMs") or int(path.stat().st_mtime * 1000)
    store = path / "store.db"
    if store.exists():
        # immutable=1: a read that never takes a lock or touches the chat's WAL files.
        connection = sqlite3.connect(store.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
        try:
            rows = connection.execute("SELECT rowid, id, data FROM blobs ORDER BY rowid").fetchall()
        except sqlite3.Error:
            rows = []  # content only in the chat's WAL; the byte-exact copy in tools/ still holds it
            plan["transcriptGap"] = "cursor store has no readable blobs table outside its WAL"
        finally:
            connection.close()
        for index, (_, blob_id, data) in enumerate(rows):
            try:
                record = json.loads(bytes(data))
            except (TypeError, ValueError):
                continue
            line = normalize_cursor(record, chat_id, blob_id, index)
            if line:
                plan["lines"].append(line)
    return plan


# --- ledger and summaries -----------------------------------------------------------

class Ledger:
    """usage.cost reports by logical session; the latest report per usageId wins."""

    def __init__(self, stores, preload=False):
        self.root = stores.sessions / "events"
        self.cache = None
        if preload:
            self.cache = self._scan(None, None)

    def _scan(self, logical, first_day):
        found = defaultdict(dict)
        for path in sorted(self.root.glob("*.jsonl")) if self.root.is_dir() else []:
            if first_day and path.stem < first_day:
                continue
            with open(path, encoding="utf-8", errors="replace") as handle:
                for raw in handle:
                    if "usage.cost" not in raw or (logical and logical not in raw):
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if event.get("kind") == "usage.cost" and (logical is None or event.get("logicalSessionId") == logical):
                        cost = event.get("cost") or {}
                        found[event.get("logicalSessionId")][cost.get("usageId") or event.get("id")] = event
        return found

    def usage(self, logical, start):
        if self.cache is not None:
            reports = self.cache.get(logical, {})
        else:
            first = iso(start - 86400000)[:10] if start else None
            reports = self._scan(logical, first).get(logical, {})
        runs, totals, unavailable = {}, defaultdict(int), 0
        for event in sorted(reports.values(), key=lambda e: (e.get("ts") or "", e.get("id") or "")):
            cost = event.get("cost") or {}
            run = runs.setdefault(event.get("runId") or "uncounted", {"runId": event.get("runId"), "agent": event.get("agent"),
                                                                        "firstAt": event.get("ts"), "models": [], "reports": 0, "tokens": {}})
            run["reports"] += 1
            model = cost.get("model") or (event.get("details") or {}).get("model")
            if model and model not in run["models"]:
                run["models"].append(model)
            tokens = cost.get("tokens")
            if not isinstance(tokens, dict):
                unavailable += 1
                continue
            for name, count in tokens.items():
                if isinstance(count, int) and not isinstance(count, bool):
                    run["tokens"][name] = run["tokens"].get(name, 0) + count
                    totals[name] += count
        return {"logicalId": logical, "source": "evidence/sessions/events", "reports": len(reports),
                "withoutTokens": unavailable, "totals": dict(sorted(totals.items())), "runs": list(runs.values())}


def summary_path(stores, logical):
    return stores.data / "generated" / "sessions" / "summaries" / (hashlib.sha256(logical.encode()).hexdigest()[:24] + ".md")


# --- writing a folder ---------------------------------------------------------------

def existing_folder(stores, fid):
    return next(iter(sorted(stores.sessions.glob(f"[0-9][0-9][0-9][0-9]/[0-9][0-9]/{fid}"))), None)


def folder_for(stores, plan):
    found = existing_folder(stores, plan["id"])
    if found:
        return found
    start = datetime.fromtimestamp((plan.get("start") or 0) / 1000, timezone.utc)
    return stores.sessions / f"{start:%Y}" / f"{start:%m}" / plan["id"]


def _guard(stores, folder):
    resolved = folder.resolve() if folder.exists() else folder.parent.resolve() / folder.name
    if stores.sessions.resolve() not in resolved.parents:
        raise ValueError(f"refusing to write outside {stores.sessions}")


def _append_transcript(folder, lines, dry):
    path = folder / "transcript.jsonl"
    existing = b""
    if path.exists():
        with open(path, "rb") as handle:
            existing = handle.read()
    seen = set()
    for raw in existing.splitlines():
        try:
            seen.add(json.loads(raw).get("id"))
        except (json.JSONDecodeError, AttributeError):
            continue
    fresh, order = [], {id(line): index for index, line in enumerate(lines)}
    for line in sorted(lines, key=lambda l: (millis(l.get("ts")) or 0, order[id(l)])):
        if line["id"] not in seen:
            seen.add(line["id"])
            fresh.append(line)
    if fresh and not dry:
        write_atomic(path, existing + "".join(dumps(line) + "\n" for line in fresh).encode())
    return len(fresh), len(seen)


def _projection(path, data, dry):
    if read_bytes(path) != data and not dry:
        write_atomic(path, data)
        return True
    return False


def read_bytes(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def write_plan(stores, plan, ledger, dry=False):
    folder = folder_for(stores, plan)
    _guard(stores, folder)
    record = read_json(folder / "session.json") or {}
    old = {entry["name"]: entry for entry in record.get("sources", [])}
    sources, copied = [], 0
    for source in plan["sources"]:
        entry, size = put(stores, folder, source, old.get(source["name"]), dry)
        copied += size
        if entry:
            sources.append(entry)
    manifest = []
    for memory in plan["notes"]:
        slug = safe(memory.parent.name)
        for source in tree_sources(memory, f"notes/{slug}", "claude-notes"):
            entry, size = put(stores, folder, source, old.get(source["name"]), dry)
            copied += size
            if entry:
                sources.append(entry)
                manifest.append({"project": slug, "path": source["name"], "bytes": entry["bytes"], "sha256": entry["sha256"]})
    names = {entry["name"] for entry in sources}
    sources += [entry for name, entry in old.items() if name not in names]
    appended, lines = _append_transcript(folder, plan["lines"], dry)
    usage = ledger.usage(plan["logicalId"], plan.get("start"))
    changed = {"usage.json": _projection(folder / "usage.json", pretty(usage), dry)}
    if manifest:
        changed["notes/manifest.json"] = _projection(folder / "notes" / "manifest.json", pretty({
            "sources": sorted({str(memory) for memory in plan["notes"]}), "files": manifest}), dry)
    summary = read_bytes(summary_path(stores, plan["logicalId"]))
    if summary is not None:
        changed["summary.md"] = _projection(folder / "summary.md", summary, dry)
    slack = plan["logicalId"].split(":") if plan["logicalId"].startswith("slack:") else None
    files = {}
    for name in PROJECTIONS + ("notes/manifest.json",):
        data = read_bytes(folder / name)
        if data is not None:
            files[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    document = {
        "schemaVersion": SCHEMA_VERSION, "id": plan["id"], "logicalId": plan["logicalId"], "origin": plan["origin"],
        "agents": sorted(plan["agents"]), "channel": "slack" if slack else None,
        "thread": {"channelId": slack[1], "threadId": slack[2]} if slack else None,
        "startedAt": iso(plan.get("start")), "endedAt": iso(plan.get("end")), "status": plan.get("status"),
        "models": sorted(plan["models"]), "harnesses": sorted(plan["harnesses"]),
        "openclaw": {"sessionIds": sorted({w["sessionId"] for w in plan["windows"] if w["sessionId"]} | {e["sessionId"] for e in sources if e.get("sessionId")}),
                     "sessionKeys": sorted({w["sessionKey"] for w in plan["windows"]}), "windows": plan["windows"]},
        "toolSessions": plan["toolSessions"], "files": files,
        "transcript": dict({"lines": lines}, **({"gap": plan["transcriptGap"]} if plan.get("transcriptGap") else {})),
        "sources": sorted(sources, key=lambda entry: entry["name"]),
        "verified": all(entry.get("verified") for entry in sources),
    }
    previous = {key: value for key, value in record.items() if key != "updatedAt"}
    if previous != document:
        document["updatedAt"] = now()
        if not dry:
            write_atomic(folder / "session.json", pretty(document))
    else:
        document["updatedAt"] = record.get("updatedAt")
    return {"folder": str(folder), "id": plan["id"], "logicalId": plan["logicalId"], "sourceBytesCopied": copied,
            "sources": len(sources), "transcriptLinesAppended": appended, "transcriptLines": lines,
            "sessionJsonChanged": previous != {k: v for k, v in document.items() if k != "updatedAt"},
            "projectionsChanged": sorted(name for name, flag in changed.items() if flag), "verified": document["verified"]}


# --- commands -----------------------------------------------------------------------

def plan_for(stores, catalog, query):
    """The plan for one session named by any of its ids; a tool session an OpenClaw session owns writes that one."""
    logical = catalog.lookup(query)
    tool, _, tool_id = query.partition(":" if ":" in query else "-")
    if not logical and (tool not in ("claude", "codex", "cursor") or not tool_id):
        raise KeyError(query)
    if not logical and tool == "claude":
        path = next(iter(sorted((stores.claude / "projects").glob(f"*/{tool_id}.jsonl"))), None)
        if path is None:
            raise KeyError(query)
        owner = claude_claims(stores, catalog, [path]).get(path)
        if not owner:
            return plan_claude(stores, path)
        logical = owner
    if not logical and tool == "codex":
        path = codex_files(stores, {tool_id}).get(tool_id)
        if path is None:
            raise KeyError(query)
        return plan_codex(stores, tool_id, path)
    if not logical and tool == "cursor":
        owner = catalog.bound.get(("cursor", tool_id))
        if not owner:
            path = cursor_chats(stores, {tool_id}).get(tool_id)
            if path is None:
                raise KeyError(query)
            return plan_cursor(stores, tool_id, path)
        logical = owner
    if not logical:
        raise KeyError(query)
    windows = catalog.sessions[logical]["windows"]
    since = min(filter(None, (w.get("createdAt") for w in windows)), default=None)
    files = claude_files(stores, since - 3600000 if since else None)
    claims = claude_claims(stores, catalog, files)
    return plan_openclaw(stores, catalog, logical, [path for path, owner in claims.items() if owner == logical])


def command_write(stores, query):
    catalog = Catalog(stores)
    return write_plan(stores, plan_for(stores, catalog, query), Ledger(stores))


def command_backfill(stores, dry=False, since=None, limit=None, log=None):
    catalog = Catalog(stores)
    ledger = Ledger(stores, preload=True)
    since_ms = millis(f"{since}T00:00:00Z") if since else None
    report = {"dryRun": dry, "sessions": defaultdict(int), "openclawByAgent": defaultdict(int), "bytes": 0,
              "transcriptLines": 0, "errors": list(catalog.errors)}
    claims = claude_claims(stores, catalog, claude_files(stores))
    owned = defaultdict(list)
    for path, logical in claims.items():
        owned[logical].append(path)
    claimed = {"claude": {path.stem for path in claims}, "codex": set(),
               "cursor": {cli_id for (tool, cli_id) in catalog.bound if tool == "cursor"}}
    written = 0

    def run(source, make, label):
        nonlocal written
        if limit is not None and written >= limit:
            return None
        try:
            plan = make()
            if since_ms and (plan.get("start") or 0) < since_ms:
                return plan
            result = write_plan(stores, plan, ledger, dry)
        except Exception as error:  # one unreadable source never stops the backfill
            report["errors"].append({"source": label, "error": f"{type(error).__name__}: {error}"})
            return None
        written += 1
        report["sessions"][source] += 1
        report["bytes"] += result["sourceBytesCopied"]
        report["transcriptLines"] += result["transcriptLinesAppended"]
        if log:
            log(dumps({key: result[key] for key in ("id", "sourceBytesCopied", "transcriptLinesAppended", "verified")}))
        return plan

    for logical in sorted(catalog.sessions):
        plan = run("openclaw", lambda: plan_openclaw(stores, catalog, logical, owned.get(logical, [])), logical)
        if plan:
            claimed["codex"] |= plan.get("codex", set())
            if plan["id"] and not (since_ms and (plan.get("start") or 0) < since_ms):
                for agent in plan["agents"]:
                    report["openclawByAgent"][agent] += 1
    for path in claude_files(stores):
        if path.stem not in claimed["claude"]:
            run("claude", lambda: plan_claude(stores, path), str(path))
    for cli_id, path in codex_files(stores).items():
        if cli_id not in claimed["codex"]:
            run("codex", lambda: plan_codex(stores, cli_id, path), str(path))
    for chat_id, path in cursor_chats(stores).items():
        if chat_id not in claimed["cursor"]:
            run("cursor", lambda: plan_cursor(stores, chat_id, path), str(path))
    report["sessions"] = dict(report["sessions"])
    report["openclawByAgent"] = dict(report["openclawByAgent"])
    return report


def verify_folder(stores, folder):
    """Problems found re-checking one folder: every copy against its record and its source."""
    problems, notes = [], []
    record = read_json(folder / "session.json")
    if not isinstance(record, dict):
        return [f"{folder}: session.json missing or invalid"], notes
    for entry in record.get("sources", []):
        copy = folder / entry["name"]
        if sha_file(copy) != entry.get("sha256"):
            problems.append(f"{entry['name']}: copy does not match its recorded hash")
            continue
        present, sha = source_digest(stores, entry)
        if not present:
            notes.append(f"{entry['name']}: source no longer present; the copy is the record")
        elif sha != entry["sha256"]:
            problems.append(f"{entry['name']}: source differs from the copy; run write")
    for name, meta in (record.get("files") or {}).items():
        data = read_bytes(folder / name)
        if data is None or hashlib.sha256(data).hexdigest() != meta.get("sha256"):
            problems.append(f"{name}: does not match its recorded hash")
    return problems, notes


def folders(stores):
    return sorted(path.parent for path in stores.sessions.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]/*/session.json"))


def index_line(folder):
    record = read_json(folder / "session.json") or {}
    size = sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())
    tools = sorted({tool["tool"] for tool in record.get("toolSessions", [])})
    return "\t".join([record.get("id") or folder.name, record.get("startedAt") or "-", ",".join(record.get("agents") or []) or "-",
                      ",".join(tools) or "-", str(size), "verified" if record.get("verified") else "unverified"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-root", default=os.environ.get("HUMANWARE_DATA_ROOT"))
    parser.add_argument("--openclaw-state", help="default $OPENCLAW_STATE_DIR or ~/.openclaw")
    parser.add_argument("--claude-root", help="default $CLAUDE_CONFIG_DIR or ~/.claude")
    parser.add_argument("--codex-home", help="default $CODEX_HOME or ~/.codex")
    parser.add_argument("--cursor-root", help="default ~/.cursor")
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write", help="write or update one session folder")
    write.add_argument("--session", required=True, help="logical id, folder id, OpenClaw session key or id, or <tool>-<id>")
    backfill = commands.add_parser("backfill", help="write every session the stores hold")
    backfill.add_argument("--dry-run", action="store_true")
    backfill.add_argument("--since", help="YYYY-MM-DD; skip sessions that started earlier")
    backfill.add_argument("--limit", type=int)
    verify = commands.add_parser("verify", help="re-check folders; exits 1 on any mismatch")
    verify.add_argument("folder", nargs="?")
    verify.add_argument("--all", action="store_true")
    commands.add_parser("index", help="one line per session folder")
    args = parser.parse_args(argv)
    if not args.data_root:
        parser.error("no data root: set HUMANWARE_DATA_ROOT or pass --data-root")
    stores = Stores(args.data_root, args.openclaw_state, args.claude_root, args.codex_home, args.cursor_root)
    if args.command == "write":
        print(json.dumps(command_write(stores, args.session), indent=2))
    elif args.command == "backfill":
        print(json.dumps(command_backfill(stores, args.dry_run, args.since, args.limit,
                                          log=None if args.dry_run else lambda line: print(line, file=sys.stderr)), indent=2))
    elif args.command == "verify":
        if not args.all and not args.folder:
            parser.error("verify needs a folder or --all")
        failed = 0
        for folder in folders(stores) if args.all else [Path(args.folder)]:
            problems, notes = verify_folder(stores, folder)
            failed += bool(problems)
            for line in problems:
                print(f"FAIL {folder.name}: {line}")
            for line in notes:
                print(f"note {folder.name}: {line}")
            if not problems:
                print(f"ok {folder.name}")
        return 1 if failed else 0
    else:
        for folder in folders(stores):
            print(index_line(folder))
    return 0


if __name__ == "__main__":
    sys.exit(main())
