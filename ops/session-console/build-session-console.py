#!/usr/bin/env python3
"""Build a Humanware OS Session Console from append-only runtime traces.

OpenClaw trajectories are Tier-0 evidence. This adapter normalizes them into a
sanitized append-only event ledger, then builds a bounded read model for Caddy.
It intentionally omits system prompts, compiled context, raw user/assistant
messages, and unbounded tool output. Other harness adapters can emit the same
ledger schema without changing the UI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
from collections import defaultdict
from datetime import datetime, timezone
from glob import glob
from urllib.parse import urlsplit, urlunsplit


SCHEMA_VERSION = 1
DEFAULT_DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", os.path.expanduser("~/humanware-data"))
DEFAULT_OPENCLAW_ROOT = os.path.expanduser("~/.openclaw/agents")
SLACK_TEAM_ID = os.environ.get("HUMANWARE_SLACK_TEAM_ID", "")
SLACK_WORKSPACE_DOMAIN = os.environ.get("HUMANWARE_SLACK_WORKSPACE_DOMAIN", "")
MAX_SESSIONS = 150
MAX_EVENTS_PER_SESSION = 100

SECRET_PATTERNS = (
    re.compile(r"\b(?:xox[baprs]-|gh[pousr]_|sk-(?:proj-)?)[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+\-/=]{8,}"),
    re.compile(r"(?i)(\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*)[^\s,;]+"),
)
SAFE_ARGUMENTS = {
    "action", "agentId", "branch", "channelId", "cwd", "emoji", "file",
    "messageId", "message_id", "model", "number", "path", "pr", "repo",
    "remove", "sessionKey", "threadId", "url",
}
def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_from_ms(value) -> str | None:
    try:
        return datetime.fromtimestamp(float(value) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


def redact(value, limit=280) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(lambda match: (match.group(1) if match.lastindex else "") + "[redacted]", text)
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(" ,.;:-") + "…"
    return text


def safe_url(value) -> str:
    try:
        parts = urlsplit(str(value))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except ValueError:
        return "[invalid URL]"


def text_content(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return " ".join(
        str(part.get("text") or "")
        for part in content
        if isinstance(part, dict) and part.get("type") in ("text", "input_text")
    )


def clean_title(value, limit=160) -> str:
    text = str(value or "")
    text = re.sub(r"<https?://[^|>]+\|([^>]+)>", r"\1", text)
    text = re.sub(r"<@[A-Z0-9]+>(?:\s*\([^)]+\))?", "", text)
    text = re.sub(r"<#[A-Z0-9]+>", "", text)
    text = re.sub(r"\[Slack file:[^]]+\]", "", text)
    text = re.sub(r"^\[Image\]\s*User text:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^\[Slack #[^]]+\]\s*[^:]+:\s*", "", text, flags=re.IGNORECASE)
    return redact(text, limit)


def root_title(meta: dict) -> str | None:
    """Return the stable Slack root title carried by the session registry."""
    display_name = meta.get("displayName")
    if not isinstance(display_name, str):
        return None
    match = re.match(r"^Slack thread #[^:]+:\s*(.+)$", display_name.strip())
    if not match:
        return None
    title = clean_title(match.group(1), 160)
    if re.match(r"^Parent thread:\s+[A-Z0-9]+\s+\d+(?:\.\d+)?\s*$", title):
        return None
    return title


def usable_cached_title(value) -> str | None:
    title = clean_title(value, 160)
    if re.match(r"^Parent thread:\s+[A-Z0-9]+\s+\d+(?:\.\d+)?\s*$", title):
        return None
    return title or None


def bounded_sessions(sessions: list[dict], limit: int = MAX_SESSIONS) -> list[dict]:
    """Keep every actionable row; bound only completed history."""
    actionable = [
        item for item in sessions
        if item["status"] in {"active", "needs_you"}
        or (item.get("workflow") or {}).get("state") == "scheduled"
    ]
    history = [item for item in sessions if item not in actionable]
    return actionable + history[:max(0, limit - len(actionable))]


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default


def each_jsonl(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                try:
                    yield raw, json.loads(raw)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def agent_from_path(path: str) -> str:
    parts = pathlib.Path(path).parts
    try:
        return parts[parts.index("agents") + 1]
    except (ValueError, IndexError):
        return "unknown"


def safe_arguments(arguments) -> dict:
    if not isinstance(arguments, dict):
        return {}
    result = {}
    for key in SAFE_ARGUMENTS:
        if key not in arguments:
            continue
        value = arguments[key]
        if key == "url":
            value = safe_url(value)
        result[key] = value if isinstance(value, (bool, int, float)) else redact(value, 180)
    command = arguments.get("command") or arguments.get("cmd")
    if command:
        result["command"] = redact(command, 220)
    return result


def result_preview(data) -> str | None:
    if not isinstance(data, dict):
        return None
    value = data.get("output")
    if value is None:
        value = data.get("result")
    if isinstance(value, dict):
        value = value.get("message") or value.get("error") or value.get("status")
    if isinstance(value, (str, int, float, bool)):
        return redact(value, 260) or None
    return None


def normalize(record: dict, raw: str, source_path: str, logical_id: str) -> dict | None:
    kind = str(record.get("type") or "unknown")
    data = record.get("data") if isinstance(record.get("data"), dict) else {}
    ts = record.get("ts") or utc_now()
    trace_id = record.get("traceId") or record.get("sessionId") or pathlib.Path(source_path).stem
    seq = record.get("seq")
    digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:16]
    event_id = f"openclaw:{trace_id}:{seq if seq is not None else digest}"
    base = {
        "schemaVersion": SCHEMA_VERSION,
        "id": event_id,
        "ts": ts,
        "logicalSessionId": logical_id,
        "runtimeSessionId": record.get("sessionId"),
        "runId": record.get("runId"),
        "turnId": data.get("turnId"),
        "agent": agent_from_path(source_path),
        "source": "openclaw",
        "provider": record.get("provider"),
        "model": record.get("modelId"),
        "kind": kind,
        "level": "verbose",
        "summary": kind.replace(".", " ").capitalize(),
        "details": {},
        "rawRef": {"file": pathlib.Path(source_path).name, "seq": record.get("sourceSeq")},
    }

    if kind == "session.started":
        base.update(level="normal", summary="Session started")
        base["details"] = {k: data.get(k) for k in ("toolCount", "workspaceDir") if data.get(k) is not None}
    elif kind == "prompt.submitted":
        base.update(level="normal", summary="Request received")
        prompt = redact(data.get("prompt"), 220)
        base["details"] = {"objective": prompt, "imagesCount": data.get("imagesCount")}
    elif kind == "context.compiled":
        base["summary"] = "Context and tools prepared"
        base["details"] = {"imagesCount": data.get("imagesCount"), "toolCount": len(data.get("tools") or [])}
    elif kind == "tool.call":
        tool = str(data.get("name") or "tool")
        args = safe_arguments(data.get("arguments"))
        base["summary"] = f"Called {tool}"
        base["details"] = {"tool": tool, "arguments": args}
        if tool == "message" and args.get("action") in ("send", "react"):
            base["level"] = "normal"
    elif kind == "tool.result":
        tool = str(data.get("name") or "tool")
        failed = bool(data.get("isError")) or data.get("success") is False or data.get("status") in ("error", "failed")
        base["level"] = "normal" if failed else "verbose"
        base["summary"] = f"{tool} {'failed' if failed else 'completed'}"
        base["details"] = {
            "tool": tool,
            "failed": failed,
            "status": data.get("status"),
            "preview": result_preview(data),
        }
    elif kind.endswith("completed"):
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        base.update(level="normal", summary=kind.replace(".", " ").capitalize())
        base["details"] = {
            "durationMs": data.get("durationMs") or data.get("runtimeMs"),
            "stopReason": data.get("stopReason"),
            "usage": {k: usage.get(k) for k in ("input", "output", "cacheRead", "cacheWrite", "total") if usage.get(k) is not None},
        }
    elif "reason" in kind or "thinking" in kind:
        # Provider-visible reasoning summaries are allowed; hidden CoT is never available here.
        base["summary"] = redact(data.get("summary") or data.get("text") or "Provider reasoning checkpoint", 260)
        base["details"] = {"providerVisible": True}
    else:
        base["level"] = "forensic"

    base["details"] = {k: v for k, v in base["details"].items() if v not in (None, "", {}, [])}
    return base


def registry_index(openclaw_root: str, state: dict):
    runtime_to_logical = {}
    descriptors = {}
    title_cache = state.setdefault("titles", {})
    runtime_cache = state.setdefault("runtimeByPath", {})
    trajectory_files = glob(os.path.join(openclaw_root, "*", "sessions", "*.trajectory.jsonl"))

    for registry_path in glob(os.path.join(openclaw_root, "*", "sessions", "sessions.json")):
        agent = agent_from_path(registry_path)
        for key, meta in read_json(registry_path, {}).items():
            if not isinstance(meta, dict) or not meta.get("sessionId"):
                continue
            runtime_id = str(meta["sessionId"])
            channel_id = str(meta.get("groupId") or (meta.get("origin") or {}).get("nativeChannelId") or "").upper()
            thread_id = str(meta.get("lastThreadId") or ((meta.get("route") or {}).get("thread") or {}).get("id") or "")
            origin = meta.get("origin") or {}
            slack_backed = (
                ":slack:" in key
                or meta.get("channel") == "slack"
                or meta.get("lastChannel") == "slack"
                or origin.get("provider") == "slack"
                or origin.get("surface") == "slack"
            )
            logical_id = f"slack:{channel_id}:{thread_id}" if slack_backed and channel_id and thread_id else f"openclaw:{agent}:{runtime_id}"
            runtime_to_logical[runtime_id] = logical_id
            descriptor = descriptors.setdefault(logical_id, {
                "id": logical_id, "agents": set(), "models": set(), "providers": set(),
                "channel": None, "channelId": None, "threadId": None, "title": None,
                "startedAt": None, "updatedAt": None, "runStatuses": [], "runtimeMs": 0,
                "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0, "slackUrl": None,
                "slackAppUrl": None,
            })
            descriptor["agents"].add(agent)
            if meta.get("model"):
                descriptor["models"].add(str(meta["model"]))
            if meta.get("modelProvider"):
                descriptor["providers"].add(str(meta["modelProvider"]))
            channel_label = meta.get("groupChannel") or origin.get("label")
            if isinstance(channel_label, str) and not channel_label.startswith("#"):
                channel_label = None
            descriptor["channel"] = descriptor["channel"] or channel_label
            descriptor["channelId"] = channel_id or descriptor["channelId"]
            descriptor["threadId"] = thread_id or descriptor["threadId"]
            started = iso_from_ms(meta.get("sessionStartedAt") or meta.get("startedAt") or meta.get("createdAt"))
            updated = iso_from_ms(meta.get("updatedAt") or meta.get("lastInteractionAt") or meta.get("endedAt"))
            if started and (not descriptor["startedAt"] or started < descriptor["startedAt"]):
                descriptor["startedAt"] = started
            if updated and (not descriptor["updatedAt"] or updated > descriptor["updatedAt"]):
                descriptor["updatedAt"] = updated
            descriptor["runStatuses"].append(str(meta.get("status") or "unknown"))
            descriptor["runtimeMs"] += int(meta.get("runtimeMs") or 0)
            descriptor["inputTokens"] += int(meta.get("inputTokens") or 0)
            descriptor["outputTokens"] += int(meta.get("outputTokens") or 0)
            descriptor["costUsd"] += float(meta.get("estimatedCostUsd") or 0)
            if channel_id and thread_id.replace(".", "").isdigit():
                compact = thread_id.replace(".", "")
                if SLACK_WORKSPACE_DOMAIN:
                    descriptor["slackUrl"] = f"https://{SLACK_WORKSPACE_DOMAIN}.slack.com/archives/{channel_id}/p{compact}"
                descriptor["slackAppUrl"] = f"slack://channel?team={SLACK_TEAM_ID}&id={channel_id}&message={thread_id}"

            session_file = meta.get("sessionFile")
            if session_file and not descriptor["title"]:
                stable_title = root_title(meta)
                cached = stable_title or usable_cached_title(title_cache.get(session_file))
                if cached:
                    descriptor["title"] = cached
                    if stable_title:
                        title_cache[session_file] = stable_title
                else:
                    fallback = None
                    for _, record in each_jsonl(session_file):
                        message = record.get("message") if isinstance(record, dict) else None
                        if record.get("type") != "message" or not isinstance(message, dict) or message.get("role") != "user":
                            continue
                        candidate = clean_title(text_content(message.get("content")), 160)
                        if not candidate:
                            continue
                        if candidate.startswith("[System]"):
                            continue
                        fallback = fallback or candidate
                        descriptor["title"] = candidate
                        title_cache[session_file] = candidate
                        break
                    if not descriptor["title"] and fallback:
                        descriptor["title"] = fallback
                        title_cache[session_file] = fallback

    for path in trajectory_files:
        session_hint = pathlib.Path(path).name.removesuffix(".trajectory.jsonl")
        logical_id = runtime_to_logical.get(session_hint)
        if not logical_id:
            # The record's sessionId is authoritative; filename is only a fallback.
            runtime_id = runtime_cache.get(path)
            if not runtime_id:
                first = next(each_jsonl(path), (None, {}))[1]
                runtime_id = str(first.get("sessionId") or session_hint)
                runtime_cache[path] = runtime_id
            logical_id = runtime_to_logical.get(runtime_id, f"openclaw:{agent_from_path(path)}:{runtime_id}")
            runtime_to_logical[runtime_id] = logical_id
        descriptors.setdefault(logical_id, {
            "id": logical_id, "agents": {agent_from_path(path)}, "models": set(), "providers": set(),
            "channel": None, "channelId": None, "threadId": None, "title": None,
            "startedAt": None, "updatedAt": None, "runStatuses": [], "runtimeMs": 0,
            "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0, "slackUrl": None,
            "slackAppUrl": None,
        })
    return trajectory_files, runtime_to_logical, descriptors


def each_new_jsonl(path: str, offset: int):
    """Yield complete JSONL records after a byte offset and return the new offset."""
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            while True:
                start = handle.tell()
                raw_bytes = handle.readline()
                if not raw_bytes:
                    return
                if not raw_bytes.endswith(b"\n"):
                    handle.seek(start)
                    return
                try:
                    raw = raw_bytes.decode("utf-8", errors="replace")
                    yield raw, json.loads(raw)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def existing_events(events_root: str):
    events = []
    seen = set()
    for path in sorted(glob(os.path.join(events_root, "*.jsonl"))):
        for _, event in each_jsonl(path):
            event_id = event.get("id")
            if event_id and event_id not in seen:
                seen.add(event_id)
                events.append(event)
    return seen, events


def append_events(events_root: str, additions: list[dict]):
    by_day = defaultdict(list)
    for event in additions:
        day = str(event.get("ts") or utc_now())[:10]
        by_day[day].append(event)
    os.makedirs(events_root, mode=0o700, exist_ok=True)
    for day, events in by_day.items():
        path = os.path.join(events_root, f"{day}.jsonl")
        with open(path, "a", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True) + "\n")
        os.chmod(path, 0o600)


OUTBOUND_LIFECYCLE = {
    "answer": ("needs_you", "question"),
    "act": ("needs_you", "raised_hand"),
    "working": ("active", "arrows_counterclockwise"),
    "scheduled": ("scheduled", "calendar"),
    "closed": ("completed", "white_check_mark"),
}


def workflow_states(events):
    states = {}
    for event in sorted(events, key=lambda item: item.get("ts") or ""):
        details = event.get("details") or {}
        if event.get("kind") != "status.set":
            continue
        thread_id = str(details.get("threadId") or "")
        if not thread_id:
            continue
        outbound = details.get("status")
        if outbound in {"no_action", "closed"} or details.get("remove"):
            states.pop(thread_id, None)
            continue
        mapped = OUTBOUND_LIFECYCLE.get(outbound)
        if mapped:
            states[thread_id] = {
                "state": mapped[0],
                "emoji": details.get("emoji") or mapped[1],
                "outbound": outbound,
                "ts": event.get("ts"),
            }
    return states


def effective_workflow(workflow: dict | None, run_statuses: list[str]) -> dict | None:
    if workflow and workflow.get("outbound") == "working" and "running" not in run_statuses:
        return None
    return workflow


def classify(descriptor: dict, workflow: dict | None, now: datetime) -> str:
    if workflow and workflow.get("state") == "needs_you":
        return "needs_you"
    if workflow and workflow.get("state") == "active":
        return "active"
    statuses = descriptor.get("runStatuses") or []
    if "running" in statuses:
        return "active"
    if any(status in ("failed", "timeout", "killed") for status in statuses):
        return "error"
    if workflow and workflow.get("state") == "completed":
        return "completed"
    known = [status for status in statuses if status != "unknown"]
    if known and all(status == "done" for status in known):
        return "completed"
    updated = descriptor.get("updatedAt")
    if updated:
        try:
            age = (now - datetime.fromisoformat(updated.replace("Z", "+00:00"))).total_seconds()
            if age < 15 * 60:
                return "active"
        except ValueError:
            pass
    return "idle"


def build(data_root: str, openclaw_root: str, dry_run=False):
    events_root = os.path.join(data_root, "evidence", "sessions", "events")
    derived_root = os.path.join(data_root, "generated", "sessions")
    state_path = os.path.join(derived_root, "state.json")
    state = read_json(state_path, {"schemaVersion": 1, "sources": {}, "titles": {}, "runtimeByPath": {}})
    state.setdefault("sources", {})
    state.setdefault("titles", {})
    state.setdefault("runtimeByPath", {})
    trajectory_files, runtime_map, descriptors = registry_index(openclaw_root, state)
    seen, ledger = existing_events(events_root)
    additions = []

    for path in trajectory_files:
        fallback = pathlib.Path(path).name.removesuffix(".trajectory.jsonl")
        try:
            stat = os.stat(path)
        except OSError:
            continue
        previous = state["sources"].get(path) or {}
        offset = int(previous.get("offset") or 0)
        if previous.get("inode") != stat.st_ino or stat.st_size < offset:
            offset = 0
        for raw, record in each_new_jsonl(path, offset):
            runtime_id = str(record.get("sessionId") or fallback)
            logical_id = runtime_map.get(runtime_id, f"openclaw:{agent_from_path(path)}:{runtime_id}")
            event = normalize(record, raw, path, logical_id)
            if event and event["id"] not in seen:
                seen.add(event["id"])
                additions.append(event)
        state["sources"][path] = {"inode": stat.st_ino, "offset": stat.st_size, "mtimeNs": stat.st_mtime_ns}

    if additions and not dry_run:
        append_events(events_root, additions)
    ledger.extend(additions)
    ledger.sort(key=lambda item: item.get("ts") or "")
    grouped = defaultdict(list)
    for event in ledger:
        grouped[event.get("logicalSessionId")].append(event)

    lifecycle = workflow_states(ledger)
    by_thread = {key: value for key, value in lifecycle.items()}
    now = datetime.now(timezone.utc)
    sessions = []
    for logical_id in set(descriptors) | set(grouped):
        descriptor = descriptors.get(logical_id) or {
            "id": logical_id, "agents": set(), "models": set(), "providers": set(),
            "channel": None, "channelId": None, "threadId": None, "title": None,
            "startedAt": None, "updatedAt": None, "runStatuses": [], "runtimeMs": 0,
            "inputTokens": 0, "outputTokens": 0, "costUsd": 0.0, "slackUrl": None,
            "slackAppUrl": None,
        }
        events = grouped.get(logical_id, [])
        if events:
            descriptor["startedAt"] = descriptor.get("startedAt") or events[0].get("ts")
            latest_ts = events[-1].get("ts")
            if latest_ts and (not descriptor.get("updatedAt") or latest_ts > descriptor["updatedAt"]):
                descriptor["updatedAt"] = latest_ts
            descriptor["agents"].update(event.get("agent") for event in events if event.get("agent"))
            descriptor["models"].update(event.get("model") for event in events if event.get("model"))
            descriptor["providers"].update(event.get("provider") for event in events if event.get("provider"))
        workflow = effective_workflow(
            by_thread.get(str(descriptor.get("threadId") or "")),
            descriptor.get("runStatuses") or [],
        )
        status = classify(descriptor, workflow, now)
        errors = sum(1 for event in events if (event.get("details") or {}).get("failed"))
        title = descriptor.get("title") or (
            f"{descriptor.get('channel')} · {', '.join(sorted(descriptor['agents']))}"
            if descriptor.get("channel") else f"OpenClaw · {', '.join(sorted(descriptor['agents'])) or 'session'}"
        )
        sessions.append({
            "id": logical_id,
            "title": title,
            "status": status,
            "outboundStatus": (workflow or {}).get("outbound"),
            "workflow": workflow,
            "agents": sorted(descriptor["agents"]),
            "models": sorted(descriptor["models"]),
            "providers": sorted(descriptor["providers"]),
            "harnesses": ["OpenClaw"],
            "channel": descriptor.get("channel"),
            "channelId": descriptor.get("channelId"),
            "threadId": descriptor.get("threadId"),
            "slackUrl": descriptor.get("slackUrl"),
            "slackAppUrl": descriptor.get("slackAppUrl"),
            "startedAt": descriptor.get("startedAt"),
            "updatedAt": descriptor.get("updatedAt"),
            "runtimeMs": descriptor.get("runtimeMs") or 0,
            "inputTokens": descriptor.get("inputTokens") or 0,
            "outputTokens": descriptor.get("outputTokens") or 0,
            "costUsd": round(descriptor.get("costUsd") or 0, 6),
            "eventCount": len(events),
            "errors": errors,
            "lastEvent": events[-1].get("summary") if events else None,
            "events": events[-MAX_EVENTS_PER_SESSION:],
        })

    sessions.sort(key=lambda item: item.get("updatedAt") or item.get("startedAt") or "", reverse=True)
    sessions = bounded_sessions(sessions)
    result = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": utc_now(),
        "summary": {
            "active": sum(item["status"] == "active" for item in sessions),
            "needsYou": sum(item["status"] == "needs_you" for item in sessions),
            "completed": sum(item["status"] == "completed" for item in sessions),
            "errors": sum(item["status"] == "error" for item in sessions),
            "total": len(sessions),
        },
        "sources": [{"id": "openclaw", "label": "OpenClaw trajectories", "files": len(trajectory_files)}],
        "tracePolicy": {
            "normal": "Actions, decisions, outcomes, and errors",
            "verbose": "Sanitized tool calls/results and provider-visible checkpoints",
            "forensic": "Normalized event types and source references; never hidden chain-of-thought",
        },
        "sessions": sessions,
    }
    if not dry_run:
        os.makedirs(derived_root, mode=0o700, exist_ok=True)
        target = os.path.join(derived_root, "current.json")
        temp = target + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(result, handle, separators=(",", ":"), sort_keys=True)
        os.chmod(temp, 0o600)
        os.replace(temp, target)
        state_temp = state_path + ".tmp"
        with open(state_temp, "w", encoding="utf-8") as handle:
            json.dump(state, handle, separators=(",", ":"), sort_keys=True)
        os.chmod(state_temp, 0o600)
        os.replace(state_temp, state_path)
    return result, len(additions)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=DEFAULT_DATA_ROOT)
    parser.add_argument("--openclaw-root", default=DEFAULT_OPENCLAW_ROOT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    result, additions = build(args.data_root, args.openclaw_root, args.dry_run)
    print(json.dumps({"sessions": result["summary"]["total"], "newEvents": additions, "dryRun": args.dry_run}))


if __name__ == "__main__":
    main()
