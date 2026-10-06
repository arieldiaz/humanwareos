#!/usr/bin/env python3
"""Build metadata views and full private records from runtime activity."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
from collections import defaultdict
from datetime import datetime, timezone
from glob import glob
from urllib.parse import urlsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import activity


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))
from openclaw_sessions import iter_agent_ids, iter_sessions, iter_trajectory_events, iter_transcript_records


SCHEMA_VERSION = 2
DEFAULT_DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", os.path.expanduser("~/humanware-data"))
DEFAULT_OPENCLAW_ROOT = os.path.expanduser("~/.openclaw/agents")
SLACK_TEAM_ID = os.environ.get("HUMANWARE_SLACK_TEAM_ID", "")
SLACK_WORKSPACE_DOMAIN = os.environ.get("HUMANWARE_SLACK_WORKSPACE_DOMAIN", "")
MAX_SESSIONS = 150
MAX_EVENTS_PER_SESSION = 100

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_from_ms(value) -> str | None:
    try:
        return datetime.fromtimestamp(float(value) / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OSError):
        return None


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


def normalize(record: dict, raw: str, source_path: str, logical_id: str) -> dict | None:
    """Translate observed trajectory metadata; never project raw text or arguments."""
    kind = record.get("type")
    data = record.get("data") if isinstance(record.get("data"), dict) else {}
    ts = record.get("ts") or record.get("timestamp")
    if not ts:
        return None
    trace_id = activity.identifier(record.get("traceId") or record.get("sessionId"), pathlib.Path(source_path).stem)
    agent = agent_from_path(source_path)
    digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:16]
    seq = record.get("seq")
    event_id = f"openclaw:{agent}:{trace_id}:{seq if type(seq) is int else digest}"
    source_ref = {"type": "raw", "id": event_id, "localOnly": True}
    tool = activity.identifier(data.get("name"))
    args = data.get("arguments") if isinstance(data.get("arguments"), dict) else {}
    target = None
    normalized_kind = {"context.compiled": "context.assembled", "model.started": "model.invoked",
                       "tool.call": "action.tool", "tool.result": "action.tool"}.get(kind, kind)
    outcome = "unknown"
    reversibility = "unknown"
    if kind in ("tool.call", "tool.result"):
        outcome = "requested" if kind == "tool.call" else ("failed" if data.get("isError") or data.get("success") is False else "succeeded" if data.get("success") is True or data.get("isError") is False else "unknown")
        if tool in ("write", "edit", "apply_patch"):
            normalized_kind, reversibility = "action.write", "reversible"
        elif tool == "message" and args.get("action") in ("send", "react", "edit", "delete"):
            # Reads/searches through the same tool are not deliveries.
            normalized_kind, reversibility = "action.send", "outward"
        elif tool in ("cron", "schedule") and args.get("action") in ("add", "update", "remove", "run"):
            normalized_kind, reversibility = "action.schedule", "outward"
        # Only dedicated target fields, never shell commands or tool output.
        for key, target_type in (("path", "path"), ("file", "path"), ("channelId", "channel"), ("repo", "repository")):
            if activity.identifier(args.get(key)):
                target = {"type": target_type, "id": args[key]}
                break
        if not target and isinstance(args.get("url"), str):
            try:
                host = urlsplit(args['url']).hostname
                if activity.identifier(host):
                    target = {"type": "host", "id": host}
            except ValueError:
                pass
    cost = None
    if kind in ("model.completed", "turn.completed", "run.completed"):
        # Only a per-invocation report is billable, never cumulative run counters.
        if kind == "model.completed":
            normalized_kind = "usage.cost"
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            cost = {"status": "unavailable", "tokens": usage, "usageId": record.get("invocationId") or event_id}
            if isinstance(data.get("cost"), dict):
                cost = dict(data["cost"], tokens=usage, usageId=record.get("invocationId") or event_id)
    if normalized_kind not in activity.KINDS:
        return {"schemaVersion": 2, "id": event_id, "traceId": trace_id,
                "logicalSessionId": logical_id, "runId": activity.identifier(record.get("runId")),
                "ts": activity.timestamp(ts), "agent": agent, "source": "openclaw",
                "kind": activity.identifier(kind, "unknown"), "level": "normal",
                "summary": activity.identifier(kind, "unknown").replace(".", " "),
                "sourceRef": source_ref, "details": {}}
    return activity.event(event_id=event_id, ts=ts, session_id=logical_id,
                          kind=normalized_kind, actor={"identity": agent, "profileId": record.get("profileId")},
                          source_ref=source_ref, run_id=record.get("runId"), trace_id=trace_id,
                          target=target, reversibility=reversibility, outcome=outcome, tool=tool,
                          channel=record.get("channel"), cost=cost,
                          # These are host trajectory metadata, not tool response contents.
                          authority=record.get("authority"), policy=record.get("policy"),
                          parent_ids=record.get("parentIds", []),
                          reason_code=record.get("reasonCode", "observed"),
                          entered_context=record.get("enteredContext"),
                          source_refs=record.get("sourceRefs", []), memory=record.get("memory"))


def projected_session_event(record):
    projected = activity.project(record)
    if projected is not None:
        return projected
    # Historical ledgers are immutable, including old payload-bearing details.
    # Reconstruct only metadata at the read boundary.
    return {key: value for key, value in {
        "id": activity.identifier(record.get("id")), "ts": record.get("ts"),
        "runId": activity.identifier(record.get("runId")),
        "kind": activity.identifier(record.get("kind"), "unknown"),
        "agent": activity.identifier(record.get("agent")), "level": "normal",
        "summary": activity.identifier(record.get("kind"), "unknown").replace(".", " "),
        "details": {}, "sourceRef": {"type": "event", "id": activity.identifier(record.get("id"), "unavailable")},
    }.items() if value is not None}


def registry_index(openclaw_root: str, state: dict):
    runtime_to_logical = {}
    descriptors = {}
    runtime_cache = state.setdefault("runtimeByPath", {})
    trajectory_files = glob(os.path.join(openclaw_root, "*", "sessions", "*.trajectory.jsonl"))

    state_root = pathlib.Path(openclaw_root).parent
    for agent in iter_agent_ids(state_root):
        for key, meta in iter_sessions(state_root, agent, include_history=True):
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
                "inputTokens": 0, "outputTokens": 0, "slackUrl": None,
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
            if channel_id and thread_id.replace(".", "").isdigit():
                compact = thread_id.replace(".", "")
                if SLACK_WORKSPACE_DOMAIN:
                    descriptor["slackUrl"] = f"https://{SLACK_WORKSPACE_DOMAIN}.slack.com/archives/{channel_id}/p{compact}"
                descriptor["slackAppUrl"] = f"slack://channel?team={SLACK_TEAM_ID}&id={channel_id}&message={thread_id}"

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
            "inputTokens": 0, "outputTokens": 0, "slackUrl": None,
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


SENSITIVE_KEYS = {
    "accesstoken", "apikey", "authorization", "bottoken", "cookie", "credential", "credentials",
    "password", "refreshtoken", "secret", "token",
}


def sanitize_trace(value, key=""):
    """Keep provider-visible activity while removing common credential fields."""
    normalized = "".join(character for character in key.lower() if character.isalnum())
    if normalized in SENSITIVE_KEYS:
        return "[REDACTED]"
    if isinstance(value, dict):
        return {item_key: sanitize_trace(item_value, item_key) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [sanitize_trace(item) for item in value]
    return value


def existing_full_trace(raw_root: str):
    seen = set()
    records = []
    for path in sorted(glob(os.path.join(raw_root, "*.jsonl"))):
        for _, record in each_jsonl(path):
            record_id = record.get("id")
            if record_id and record_id not in seen:
                seen.add(record_id)
                records.append(record)
    return seen, records


def append_full_trace(raw_root: str, records: list[dict]):
    by_day = defaultdict(list)
    for record in records:
        by_day[str(record["timestamp"])[:10]].append(record)
    os.makedirs(raw_root, mode=0o700, exist_ok=True)
    for day, items in by_day.items():
        path = os.path.join(raw_root, f"{day}.jsonl")
        with open(path, "a", encoding="utf-8") as handle:
            for item in items:
                handle.write(json.dumps(item, separators=(",", ":")) + "\n")
        os.chmod(path, 0o600)


def session_record_path(logical_id: str) -> str:
    return os.path.join("records", hashlib.sha256(logical_id.encode()).hexdigest()[:24] + ".json")


def write_session_records(derived_root: str, sessions: list[dict], trace: list[dict]):
    grouped = defaultdict(list)
    for record in trace:
        grouped[record.get("logicalSessionId")].append(record)
    records_root = os.path.join(derived_root, "records")
    os.makedirs(records_root, mode=0o700, exist_ok=True)
    for session in sessions:
        details = sorted(grouped.get(session["id"], []), key=lambda item: (item.get("timestamp") or "", item.get("id") or ""))
        completed = next((event for event in reversed(session["events"]) if event.get("kind") == "session.completed"), None)
        summary = {
            "status": session["status"],
            "outcome": (completed or {}).get("summary") or session.get("lastEvent"),
            "decisions": [],
            "followUps": [],
            "agents": session["agents"],
            "models": session["models"],
            "startedAt": session.get("startedAt"),
            "closedAt": session.get("updatedAt") if session["status"] == "completed" else None,
        }
        payload = {"summary": summary, "details": details}
        target = os.path.join(derived_root, session["record"])
        temp = target + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        os.chmod(temp, 0o600)
        os.replace(temp, target)


append_events = activity.append_events


OUTBOUND_LIFECYCLE = {
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
        if details.get("remove"):
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
    raw_root = os.path.join(data_root, "evidence", "sessions", "raw", "openclaw")
    derived_root = os.path.join(data_root, "generated", "sessions")
    state_path = os.path.join(derived_root, "state.json")
    state = read_json(state_path, {"schemaVersion": 1, "sources": {}, "runtimeByPath": {}})
    state.setdefault("sources", {})
    state.pop("titles", None)
    state.setdefault("runtimeByPath", {})
    trajectory_files, runtime_map, descriptors = registry_index(openclaw_root, state)
    seen, ledger = existing_events(events_root)
    full_seen, full_trace = existing_full_trace(raw_root)
    additions = []
    full_additions = []
    source_event_ids = set()
    source_latest_at = None

    state_root = pathlib.Path(openclaw_root).parent
    database_count = 0
    for agent in iter_agent_ids(state_root):
        database_count += 1
        for row in iter_trajectory_events(state_root, agent):
            runtime_id = str(row["sessionId"])
            logical_id = runtime_map.get(runtime_id, f"openclaw:{agent}:{runtime_id}")
            event = dict(row["event"])
            event.setdefault("sessionId", runtime_id)
            event.setdefault("runId", row.get("runId"))
            event.setdefault("seq", row["seq"])
            timestamp = event.get("ts") or event.get("timestamp") or iso_from_ms(row["createdAt"])
            event_id = f"openclaw:{agent}:{runtime_id}:{row['seq']}"
            source_event_ids.add(event_id)
            if timestamp and (not source_latest_at or timestamp > source_latest_at):
                source_latest_at = timestamp
            if event_id not in full_seen:
                full_seen.add(event_id)
                full_additions.append({
                    "schemaVersion": 1,
                    "id": event_id,
                    "timestamp": timestamp,
                    "type": event.get("type") or "unknown",
                    "agent": agent,
                    "runtimeSessionId": runtime_id,
                    "logicalSessionId": logical_id,
                    "runId": row.get("runId"),
                    "event": sanitize_trace(event),
                })
            raw = json.dumps(event, separators=(",", ":"))
            normalized = normalize(event, raw, row["sourcePath"], logical_id)
            if normalized and normalized["id"] not in seen:
                seen.add(normalized["id"])
                additions.append(normalized)

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
        with open(path, "rb") as source:
            source.seek(offset)
            committed_offset = offset
            for line in source:
                if not line.endswith(b"\n"):
                    break
                committed_offset += len(line)
        state["sources"][path] = {"inode": stat.st_ino, "offset": committed_offset, "mtimeNs": stat.st_mtime_ns}

    if source_event_ids - full_seen:
        raise RuntimeError("OpenClaw activity capture did not reach the canonical trajectory source")
    if full_additions and not dry_run:
        append_full_trace(raw_root, full_additions)
    full_trace.extend(full_additions)
    if additions and not dry_run:
        append_events(events_root, additions)
    ledger.extend(additions)
    ledger.extend(e for e in activity.evidence_records(data_root, ("memory",)) if activity.project(e) is not None)
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
            "inputTokens": 0, "outputTokens": 0, "slackUrl": None,
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
        title = (
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
            "spend": activity.read_model(events)[1]["spend"],
            "eventCount": len(events),
            "errors": errors,
            "lastEvent": projected_session_event(events[-1])["summary"] if events else None,
            "events": [projected_session_event(e) for e in events[-MAX_EVENTS_PER_SESSION:]],
            "traceTruncated": len(events) > MAX_EVENTS_PER_SESSION,
            "record": session_record_path(logical_id),
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
        "sources": [{
            "id": "openclaw",
            "label": "OpenClaw trajectory database",
            "databases": database_count,
            "events": len(source_event_ids),
            "latestAt": source_latest_at,
            "legacyFiles": len(trajectory_files),
        }],
        "tracePolicy": {
            "normal": "Actions, decisions, outcomes, and errors",
            "verbose": "Sanitized tool calls/results and provider-visible checkpoints",
            "forensic": "Normalized event types and source references; never hidden chain-of-thought",
        },
        "sessions": sessions,
    }
    if not dry_run:
        activity.rebuild(data_root)
        os.makedirs(derived_root, mode=0o700, exist_ok=True)
        write_session_records(derived_root, sessions, full_trace)
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
