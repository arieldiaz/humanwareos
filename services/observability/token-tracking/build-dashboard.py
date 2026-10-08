#!/usr/bin/env python3
"""Build the static stats dashboard data feed (runs hourly via launchd).

Reads per-day, per-model token + cost usage from CodexBar's LOCAL cost logs
(`codexbar cost --provider claude|codex --json`) and merges it into a durable
rollup so history survives past CodexBar's ~30-day window. Emits a single
`current.json` that the instance's static stats page renders client-side
(month cycling + weekly view are sliced in the browser from the daily series).

Inputs:
  - $HUMANWARE_DATA_ROOT/generated/reports/stats/daily.json   durable rollup
  - <instance config>/budgets.json   editable monthly pace budgets per sub
  - <instance config>/config.json    owner/agents/Slack workspace (see README)
  - $HUMANWARE_DATA_ROOT/generated/observability/buzz-baseline.json (optional)

<instance config> = $HUMANWARE_RUNTIME_ROOT/config/services/observability/
token-tracking; the runtime root is derived from this file's location
(<runtime>/framework/services/observability/token-tracking/) when unset.

Output: $HUMANWARE_DATA_ROOT/generated/reports/stats/current.json

Notes that keep this working headless (same gotchas as post-usage.py):
  - codexbar must be called by full path; not on the launchd/ssh PATH.
  - codexbar logs a non-fatal Keychain cache error (-25308) on stderr under
    launchd/ssh; ignored unless the call actually fails.

Usage: build-dashboard.py [--dry-run]   (--dry-run skips writing webroot)
"""

import json
import importlib.util
import os
import pathlib
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from glob import glob
from zoneinfo import ZoneInfo

CODEXBAR = "/opt/homebrew/bin/codexbar"
HERE = pathlib.Path(os.path.abspath(__file__)).parent
SERVICE = "token-tracking"


def runtime_root():
    """HUMANWARE_RUNTIME_ROOT, else <runtime> derived from the framework layout."""
    env = os.environ.get("HUMANWARE_RUNTIME_ROOT")
    if env:
        return pathlib.Path(env)
    parents = HERE.parents  # [observability, services, framework, runtime]
    if len(parents) > 3 and parents[2].name == "framework":
        return parents[3]
    return None


def instance_config_dir():
    root = runtime_root()
    return root / "config" / "services" / "observability" / SERVICE if root else None


def load_instance_config():
    cfg_dir = instance_config_dir()
    if not cfg_dir:
        return {}
    try:
        with open(cfg_dir / "config.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", "")
DATA_DIR = os.path.join(DATA_ROOT, "generated", "reports", "stats")
STORE = os.path.join(DATA_DIR, "daily.json")
_CFG_DIR = instance_config_dir()
BUDGETS = str(_CFG_DIR / "budgets.json") if _CFG_DIR else ""
BUZZ_BASELINE = os.path.join(DATA_ROOT, "generated", "observability", "buzz-baseline.json")
OUT = os.path.join(DATA_DIR, "current.json")
CONFIG = load_instance_config()

PROVIDERS = [("claude", "Claude"), ("codex", "Codex / ChatGPT")]

# Self-hosted models have no metering feed (they're free/local via ollama);
# surfaced as zero rows "for curiosity" so they show up when we start using them.
LOCAL_MODELS = [
    {"id": "ollama/llama3.3:70b", "name": "llama3.3:70b", "alias": "llama"},
]

WINDOWS = os.path.join(DATA_DIR, "windows.jsonl")
LOCAL_USAGE = os.path.join(DATA_DIR, "local-usage.jsonl")
OPENCLAW_STATE_ROOT = pathlib.Path(os.environ.get("OPENCLAW_STATE_DIR", os.path.expanduser("~/.openclaw")))
OPENCLAW_AGENTS = str(OPENCLAW_STATE_ROOT / "agents")
_OWNER = CONFIG.get("owner") or {}
# The owner key names the human's column in data.json (e.g. messages.<key>).
OWNER_KEY = _OWNER.get("key")
OWNER_NAME = (_OWNER.get("name") or OWNER_KEY or "").lower()
OWNER_SLACK_ID = _OWNER.get("slackUserId")
SLACK_AGENTS = tuple(CONFIG.get("slackAgents") or ())
SLACK_TEAM_ID = CONFIG.get("slackTeamId")
SLACK_WORKSPACE_DOMAIN = CONFIG.get("slackWorkspaceDomain")  # e.g. example.slack.com
# Channels whose activity is not counted (social/shared spaces).
EXCLUDED_SLACK_CHANNELS = {c.upper() for c in CONFIG.get("excludedSlackChannels") or ()}
WORD_RE = re.compile(r"\b[\w’'-]+\b", re.UNICODE)
LINK_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)
TOPIC_RE = re.compile(r'topic_id\\?"\s*:\s*\\?"([0-9]+\.[0-9]+)')
TIMEZONE = CONFIG.get("timezone") or "UTC"
LOCAL_TZ = ZoneInfo(TIMEZONE)
# Lifecycle states per docs/status-framework.md. The generic "blocked" state was
# retired 2026-07-26 and split into clarify/approve/act; no_entry_sign is kept
# only so threads reacted before that date still parse.
LIFECYCLE = {
    "arrows_counterclockwise": "in_process",
    "question": "clarify",
    "arrow_forward": "approve",
    "raised_hand": "act",
    "calendar": "scheduled",
    "no_entry_sign": "blocked",
    "white_check_mark": "done",
}
HARNESSES = {
    "claude-cli": "Claude Code",
    "openai": "Codex",
    "opencode": "OpenCode",
    "ollama": "Native",
}


def buzz_activity():
    """Read aggregate-only adoption telemetry from the local Buzz relay.

    Message bodies and identities never leave Postgres. The explicit baseline
    excludes the Slack seed so this series measures native Buzz activity.
    """
    baseline = load_json(BUZZ_BASELINE, {})
    started_at = baseline.get("startedAt")
    if not started_at:
        raise RuntimeError("Buzz baseline has no startedAt")
    sql = f"""
WITH raw_messages AS (
  SELECT e.received_at, e.pubkey, e.channel_id, u.agent_type
  FROM events e LEFT JOIN users u USING (community_id, pubkey)
  WHERE e.kind = 9 AND e.deleted_at IS NULL
    AND e.received_at >= '{started_at}'::timestamptz
), messages AS (
  SELECT (received_at AT TIME ZONE '{TIMEZONE}')::date AS day,
         count(*) AS messages,
         count(DISTINCT pubkey) AS active_authors,
         count(DISTINCT channel_id) FILTER (WHERE channel_id IS NOT NULL) AS active_channels,
         count(*) FILTER (WHERE agent_type IS NOT NULL) AS agent_messages,
         count(*) FILTER (WHERE agent_type IS NULL) AS human_messages
  FROM raw_messages
  GROUP BY 1
), raw_reactions AS (
  SELECT created_at FROM reactions
  WHERE removed_at IS NULL AND created_at >= '{started_at}'::timestamptz
), reactions_by_day AS (
  SELECT (created_at AT TIME ZONE '{TIMEZONE}')::date AS day,
         count(*) AS reactions
  FROM raw_reactions
  GROUP BY 1
), combined AS (
  SELECT coalesce(m.day, r.day) AS day,
         coalesce(messages, 0) AS messages,
         coalesce(active_authors, 0) AS active_authors,
         coalesce(active_channels, 0) AS active_channels,
         coalesce(agent_messages, 0) AS agent_messages,
         coalesce(human_messages, 0) AS human_messages,
         coalesce(reactions, 0) AS reactions
  FROM messages m FULL JOIN reactions_by_day r USING (day)
)
SELECT json_build_object(
  'days', (SELECT coalesce(json_agg(json_build_object(
    'date', day, 'messages', messages, 'activeAuthors', active_authors,
    'activeChannels', active_channels, 'agentMessages', agent_messages,
    'humanMessages', human_messages, 'reactions', reactions
  ) ORDER BY day), '[]'::json) FROM combined),
  'totals', (SELECT json_build_object(
    'messages', count(*), 'activeAuthors', count(DISTINCT pubkey),
    'activeChannels', count(DISTINCT channel_id) FILTER (WHERE channel_id IS NOT NULL),
    'agentMessages', count(*) FILTER (WHERE agent_type IS NOT NULL),
    'humanMessages', count(*) FILTER (WHERE agent_type IS NULL),
    'reactions', (SELECT count(*) FROM raw_reactions)
  ) FROM raw_messages)
);
"""
    out = subprocess.run(
        ["/opt/homebrew/bin/docker", "exec", "-i", "buzz-prod-postgres-1",
         "sh", "-lc", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
        input=sql, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        err = (out.stderr or out.stdout or "no output").strip().splitlines()[-1]
        raise RuntimeError(f"Buzz aggregate query failed: {err}")
    activity = json.loads(out.stdout.strip() or '{}')
    return {
        "startedAt": started_at,
        "baseline": {k: v for k, v in baseline.items() if k.startswith("seed")},
        "days": activity.get("days", []),
        "totals": activity.get("totals", {}),
        "source": "Local Buzz relay aggregate event counts",
    }


def text_from_content(content):
    """Flatten OpenClaw message content without retaining any message text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return " ".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def word_count(text):
    return len(WORD_RE.findall(text or ""))


def link_count(text):
    return len(LINK_RE.findall(text or ""))


def preview_text(text, limit=140):
    """Return a short opening preview for the private stats dashboard."""
    clean = re.sub(r"<@[A-Z0-9]+>", "", text or "")
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) <= limit:
        return clean
    clipped = clean[:limit].rsplit(" ", 1)[0].rstrip(" ,.;:-")
    return clipped + "…"


def artifact_count(content):
    if not isinstance(content, list):
        return 0
    artifact_types = {"image", "audio", "video", "file", "document", "attachment"}
    return sum(
        1 for part in content
        if isinstance(part, dict) and part.get("type") in artifact_types
    )


def each_jsonl(path):
    try:
        with open(path) as f:
            for line in f:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    except OSError:
        return


def codex_usage_index(agent):
    """Index native Codex cumulative counters once, keyed by Slack thread."""
    root = os.path.join(OPENCLAW_AGENTS, agent, "agent", "codex-home", "sessions")
    index = defaultdict(lambda: {
        "input": 0, "output": 0, "days": defaultdict(lambda: {"input": 0, "output": 0})
    })
    for path in glob(os.path.join(root, "*", "*", "*", "rollout-*.jsonl")):
        try:
            text = open(path, errors="ignore").read()
        except OSError:
            continue
        topics = TOPIC_RE.findall(text)
        if not topics:
            continue
        thread = Counter(topics).most_common(1)[0][0]
        final = None
        for line in text.splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = entry.get("payload") or {}
            if entry.get("type") == "event_msg" and payload.get("type") == "token_count":
                usage = (payload.get("info") or {}).get("total_token_usage")
                if usage:
                    final = usage
        if not final:
            continue
        input_tokens = final.get("input_tokens", 0)
        output_tokens = final.get("output_tokens", 0)
        day = pathlib.Path(path).parts[-4:-1]
        date = "-".join(day) if len(day) == 3 else None
        index[thread]["input"] += input_tokens
        index[thread]["output"] += output_tokens
        if date:
            index[thread]["days"][date]["input"] += input_tokens
            index[thread]["days"][date]["output"] += output_tokens
    return index


def lifecycle_statuses(excluded_message_ids=None):
    """Reconstruct each Slack root's latest lifecycle reaction from traces."""
    excluded_message_ids = excluded_message_ids or set()
    events = []
    pattern = os.path.join(OPENCLAW_AGENTS, "*", "sessions", "*.trajectory.jsonl")
    for path in glob(pattern):
        for record in each_jsonl(path):
            if record.get("type") != "tool.call":
                continue
            data = record.get("data") or {}
            args = data.get("arguments") or {}
            emoji = args.get("emoji")
            if data.get("name") != "message" or args.get("action") != "react" or emoji not in LIFECYCLE:
                continue
            message_id = str(args.get("messageId") or args.get("message_id") or "")
            if message_id and message_id not in excluded_message_ids:
                events.append((record.get("ts") or "", message_id, emoji, bool(args.get("remove"))))
    current = {}
    completed = {}
    for ts, message_id, emoji, remove in sorted(events):
        if remove:
            if current.get(message_id, {}).get("emoji") == emoji:
                current.pop(message_id, None)
            continue
        current[message_id] = {
            "status": LIFECYCLE[emoji],
            "emoji": emoji,
            "changedAt": ts,
        }
        if emoji == "white_check_mark":
            completed[message_id] = ts
    return current, completed


def openclaw_session_reader():
    """Use the framework reader shipped with this immutable instance runtime."""
    # This file lives at <framework>/services/observability/token-tracking/.
    framework = pathlib.Path(os.environ.get("HUMANWARE_FRAMEWORK_ROOT") or HERE.parents[2])
    path = framework / "ops/lib/openclaw_sessions.py"
    if not path.is_file():
        raise RuntimeError(f"OpenClaw session reader is missing: {path}")
    spec = importlib.util.spec_from_file_location("humanware_openclaw_sessions", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def transcript_trajectory(records):
    """Project canonical assistant usage/tools onto the dashboard's local accumulator."""
    for record in records:
        if record.get("type") != "message":
            continue
        message = record.get("message") or {}
        if message.get("role") != "assistant":
            continue
        timestamp = record.get("timestamp") or message.get("timestamp")
        if isinstance(timestamp, (int, float)):
            timestamp = datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()
        usage = message.get("usage")
        if isinstance(usage, dict):
            inputs = usage.get("input") or usage.get("inputTokens") or 0
            outputs = usage.get("output") or usage.get("outputTokens") or 0
            cache_read = usage.get("cacheRead") or 0
            cache_write = usage.get("cacheWrite") or 0
            yield {"type": "model.completed", "ts": timestamp, "modelId": message.get("model"), "data": {"usage": {
                "input": inputs, "output": outputs, "cacheRead": cache_read, "cacheWrite": cache_write,
                "total": usage.get("totalTokens") or inputs + outputs + cache_read + cache_write,
            }}}
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    yield {"type": "tool.call", "ts": timestamp, "data": {
                        "name": part.get("name"), "arguments": part.get("arguments") or {},
                    }}


def slack_activity():
    """Aggregate Slack sessions/messages/words from OpenClaw's local logs.

    Only counts Slack-backed sessions of the configured agents. Owner messages
    are read from inbound session records. Agent replies prefer explicit message-tool sends
    (the current delivery contract), falling back to final assistant text for
    older sessions. Raw text never leaves this function.
    """
    if not OWNER_KEY or not SLACK_AGENTS:
        raise RuntimeError(
            "token-tracking config.json must set owner.key and slackAgents "
            f"(looked in {instance_config_dir()})")
    owner = OWNER_KEY

    def per_agent():
        return {agent: 0 for agent in SLACK_AGENTS}

    def per_person():
        return {owner: 0, **per_agent()}

    daily = defaultdict(lambda: {
        "sessions": {"total": 0, **per_agent(), "shared": 0},
        "messages": per_person(),
        "words": per_person(),
        "toolCalls": per_agent(),
        "tokens": per_agent(),
        "inputTokens": per_agent(),
        "outputTokens": per_agent(),
        "completed": 0,
    })
    seen_user = set()
    seen_native_usage = set()
    seen_transcript_events = set()
    threads = {}
    channel_names = {}
    registries = {}
    excluded_thread_ids = set()
    reader = openclaw_session_reader()

    for agent in SLACK_AGENTS:
        registry = list(reader.iter_sessions(OPENCLAW_STATE_ROOT, agent, include_history=True))
        registries[agent] = registry
        for _, meta in registry:
            if not isinstance(meta, dict):
                continue
            channel_id = str(meta.get("groupId") or (meta.get("origin") or {}).get("nativeChannelId") or "").upper()
            if channel_id in EXCLUDED_SLACK_CHANNELS:
                thread_id = str(meta.get("lastThreadId") or (meta.get("route") or {}).get("thread", {}).get("id") or "")
                if thread_id:
                    excluded_thread_ids.add(thread_id)
                continue
            label = meta.get("groupChannel") or (meta.get("origin") or {}).get("label")
            if channel_id and isinstance(label, str) and label.startswith("#"):
                candidate = (meta.get("updatedAt") or 0, label)
                if candidate[0] >= channel_names.get(channel_id, (0, ""))[0]:
                    channel_names[channel_id] = candidate

    statuses, completions = lifecycle_statuses(excluded_thread_ids)

    for agent in SLACK_AGENTS:
        registry = registries[agent]
        native_codex = codex_usage_index(agent)
        slack_sessions = {}

        for key, meta in registry:
            if ":slack:" not in key or not isinstance(meta, dict):
                continue
            session_id = meta.get("sessionId")
            session_file = meta.get("sessionFile")
            if not session_id or not session_file:
                continue
            slack_sessions[session_id] = meta

        for session_id, meta in slack_sessions.items():
            session_file = meta["sessionFile"]
            thread_id = str(meta.get("lastThreadId") or (meta.get("route") or {}).get("thread", {}).get("id") or "")
            channel_id = str(meta.get("groupId") or (meta.get("origin") or {}).get("nativeChannelId") or "").upper()
            if channel_id in EXCLUDED_SLACK_CHANNELS:
                continue
            thread_key = f"{channel_id}:{thread_id}" if channel_id and thread_id else session_id
            records = []
            for record in reader.iter_transcript_records(OPENCLAW_STATE_ROOT, agent, meta):
                event_id = record.get("id") if session_file.startswith("sqlite:") else None
                event_key = (agent, thread_key, event_id)
                if event_id and event_key in seen_transcript_events:
                    continue
                if event_id:
                    seen_transcript_events.add(event_key)
                records.append(record)
            started = meta.get("sessionStartedAt") or meta.get("createdAt") or meta.get("updatedAt")
            started_iso = datetime.fromtimestamp(started / 1000, LOCAL_TZ).isoformat() if started else None
            thread = threads.setdefault(thread_key, {
                "id": thread_id or session_id,
                "channelId": channel_id or None,
                "channel": channel_names.get(channel_id, (0, None))[1]
                    or meta.get("groupChannel") or (meta.get("origin") or {}).get("label"),
                "startedAt": started_iso,
                "preview": None,
                "agents": [],
                "models": [],
                "harnesses": [],
                "tokens": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "toolCalls": 0,
                "messages": per_person(),
                "words": per_person(),
                "outputs": per_agent(),
                "links": 0,
                "artifacts": 0,
            })
            if agent not in thread["agents"]:
                thread["agents"].append(agent)
            model = meta.get("model")
            if model and model not in thread["models"]:
                thread["models"].append(model)
            harness = HARNESSES.get(meta.get("modelProvider"))
            if harness and harness not in thread["harnesses"]:
                thread["harnesses"].append(harness)

            for record in records:
                if record.get("type") != "message":
                    continue
                msg = record.get("message") or {}
                if msg.get("role") != "user" or msg.get("sourceChannel") != "slack":
                    continue
                sender_name = (msg.get("senderName") or "").lower()
                sender_id = msg.get("senderId")
                if sender_name != OWNER_NAME and (not OWNER_SLACK_ID or sender_id != OWNER_SLACK_ID):
                    continue
                ts = record.get("timestamp") or msg.get("timestamp")
                if not ts:
                    continue
                # idempotency is stable across duplicate delivery to several agents.
                dedupe = msg.get("idempotencyKey") or f"{ts}:{word_count(text_from_content(msg.get('content')))}"
                text = text_from_content(msg.get("content"))
                words = word_count(text)
                if not thread["preview"]:
                    thread["preview"] = preview_text(text)
                if thread["messages"][owner] == 0 or dedupe not in seen_user:
                    thread["messages"][owner] += 1
                    thread["words"][owner] += words
                    thread["links"] += link_count(text)
                    thread["artifacts"] += artifact_count(msg.get("content"))
                if dedupe not in seen_user:
                    seen_user.add(dedupe)
                    date = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ).date().isoformat()
                    daily[date]["messages"][owner] += 1
                    daily[date]["words"][owner] += words

            explicit = []
            if session_file.startswith("sqlite:"):
                trajectory_records = list(transcript_trajectory(records))
            else:
                trajectory = session_file.removesuffix(".jsonl") + ".trajectory.jsonl"
                trajectory_records = list(each_jsonl(trajectory))
            for record in trajectory_records:
                trajectory_model = record.get("modelId")
                if trajectory_model and trajectory_model not in thread["models"]:
                    thread["models"].append(trajectory_model)
            metered_tokens = sum(
                ((record.get("data") or {}).get("usage") or {}).get("total") or 0
                for record in trajectory_records
                if record.get("type") == "model.completed"
            )
            native_usage = native_codex.get(thread_id) if meta.get("modelProvider") == "openai" else None
            if native_usage:
                native_key = (agent, thread_id)
                if native_key in seen_native_usage:
                    native_usage = {"input": 0, "output": 0, "days": {}}
                else:
                    seen_native_usage.add(native_key)
            session_tokens = (
                native_usage["input"] + native_usage["output"]
                if native_usage else metered_tokens or meta.get("totalTokens") or 0
            )
            thread["tokens"] += session_tokens
            session_input = native_usage["input"] if native_usage else sum(
                (((record.get("data") or {}).get("usage") or {}).get("input") or 0)
                + (((record.get("data") or {}).get("usage") or {}).get("cacheRead") or 0)
                + (((record.get("data") or {}).get("usage") or {}).get("cacheWrite") or 0)
                for record in trajectory_records if record.get("type") == "model.completed"
            )
            session_output = native_usage["output"] if native_usage else sum(
                ((record.get("data") or {}).get("usage") or {}).get("output") or 0
                for record in trajectory_records if record.get("type") == "model.completed"
            )
            thread["inputTokens"] += session_input
            thread["outputTokens"] += session_output
            if native_usage:
                for date, usage in native_usage["days"].items():
                    daily[date]["inputTokens"][agent] += usage["input"]
                    daily[date]["outputTokens"][agent] += usage["output"]
                    daily[date]["tokens"][agent] += usage["input"] + usage["output"]
            trajectory_tool_calls = sum(
                1 for record in trajectory_records if record.get("type") == "tool.call"
            )
            # Some external harnesses report only their final response through
            # the OpenClaw trajectory. Their OpenClaw session transcript still
            # carries any surfaced toolCall content, so use it only when the
            # trajectory has no native tool.call events.
            transcript_tool_calls = 0
            if not trajectory_tool_calls:
                for record in records:
                    if record.get("type") != "message":
                        continue
                    content = (record.get("message") or {}).get("content")
                    if isinstance(content, list):
                        transcript_tool_calls += sum(
                            1 for part in content
                            if isinstance(part, dict) and part.get("type") == "toolCall"
                        )
                thread["toolCalls"] += transcript_tool_calls
                if transcript_tool_calls and started_iso:
                    daily[started_iso[:10]]["toolCalls"][agent] += transcript_tool_calls
            if not native_usage and not metered_tokens and session_tokens and started_iso:
                daily[started_iso[:10]]["tokens"][agent] += session_tokens
            for record in trajectory_records:
                record_type = record.get("type")
                if record_type == "model.completed" and not native_usage:
                    ts = record.get("ts")
                    if ts:
                        date = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ).date().isoformat()
                        usage = (record.get("data") or {}).get("usage") or {}
                        daily[date]["tokens"][agent] += usage.get("total") or 0
                        daily[date]["inputTokens"][agent] += (
                            (usage.get("input") or 0) + (usage.get("cacheRead") or 0)
                            + (usage.get("cacheWrite") or 0)
                        )
                        daily[date]["outputTokens"][agent] += usage.get("output") or 0
                if record_type != "tool.call":
                    continue
                thread["toolCalls"] += 1
                ts = record.get("ts")
                if ts:
                    date = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ).date().isoformat()
                    daily[date]["toolCalls"][agent] += 1
                data = record.get("data") or {}
                args = data.get("arguments") or {}
                if data.get("name") == "message" and args.get("action") == "send":
                    text = args.get("message") or args.get("caption") or ""
                    if text:
                        artifacts = len(args.get("attachments") or [])
                        artifacts += int(bool(args.get("media") or args.get("image") or args.get("fileId")))
                        explicit.append((record.get("ts"), text, artifacts))

            outbound = explicit
            if not outbound:
                outbound = []
                for record in records:
                    if record.get("type") != "message":
                        continue
                    msg = record.get("message") or {}
                    if msg.get("role") != "assistant" or msg.get("stopReason") != "stop":
                        continue
                    text = text_from_content(msg.get("content"))
                    if text:
                        outbound.append((
                            record.get("timestamp") or msg.get("timestamp"),
                            text,
                            artifact_count(msg.get("content")),
                        ))

            for ts, text, artifacts in outbound:
                if not ts:
                    continue
                date = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ).date().isoformat()
                daily[date]["messages"][agent] += 1
                daily[date]["words"][agent] += word_count(text)
                thread["messages"][agent] += 1
                thread["words"][agent] += word_count(text)
                thread["outputs"][agent] += 1
                thread["links"] += link_count(text)
                thread["artifacts"] += artifacts

    for thread in threads.values():
        if not thread["startedAt"]:
            continue
        date = thread["startedAt"][:10]
        agents = set(thread["agents"])
        bucket = "shared" if len(agents) > 1 else next(iter(agents), SLACK_AGENTS[0])
        daily[date]["sessions"]["total"] += 1
        daily[date]["sessions"][bucket] += 1

    session_rows = []
    for thread in threads.values():
        thread["agents"].sort()
        thread["models"].sort()
        thread["harnesses"].sort()
        thread["words"]["total"] = sum(thread["words"].values())
        thread["messages"]["total"] = sum(thread["messages"].values())
        if thread["channelId"] and thread["id"].replace(".", "").isdigit():
            thread["url"] = (
                f"https://{SLACK_WORKSPACE_DOMAIN}/archives/{thread['channelId']}/p{thread['id'].replace('.', '')}"
                if SLACK_WORKSPACE_DOMAIN else None
            )
            thread["appUrl"] = (
                f"slack://channel?team={SLACK_TEAM_ID}"
                f"&id={thread['channelId']}&message={thread['id']}"
                if SLACK_TEAM_ID else None
            )
        else:
            thread["url"] = None
            thread["appUrl"] = None
        status = statuses.get(thread["id"])
        thread["status"] = status["status"] if status else "unknown"
        thread["statusEmoji"] = status["emoji"] if status else None
        thread["statusChangedAt"] = status["changedAt"] if status else None
        session_rows.append(thread)
    session_rows.sort(key=lambda row: row.get("startedAt") or "", reverse=True)

    for thread_id, ts in completions.items():
        if not ts:
            continue
        date = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ).date().isoformat()
        daily[date]["completed"] += 1

    return {
        "coverageStart": min(daily) if daily else None,
        "days": dict(sorted(daily.items())),
        "sessions": session_rows,
        "source": "OpenClaw local Slack session storage",
    }


def local_usage():
    """Aggregate metered ollama usage (from run-local.py) by model -> {days, total}."""
    agg = {}
    try:
        with open(LOCAL_USAGE) as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                r = json.loads(ln)
                m = agg.setdefault(r.get("model"), {"days": {}, "totalTokens": 0})
                tok = r.get("totalTokens", 0)
                m["days"][r.get("date")] = m["days"].get(r.get("date"), 0) + tok
                m["totalTokens"] += tok
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return agg


def detect_token_jubilees(samples):
    """Find unscheduled usage replenishments in the sampled window history.

    A normal reset happens at the previously advertised reset timestamp. A
    jubilee is a material utilization drop while that old window was still
    active, paired with the provider moving the reset timestamp later.
    """
    previous = {}
    events = []
    for sample in samples:
        sample_ts = datetime.fromisoformat(sample["ts"])
        for provider, payload in (sample.get("providers") or {}).items():
            for win in payload.get("windows") or []:
                key = (provider, win.get("slot"), win.get("label"))
                prior = previous.get(key)
                previous[key] = (sample_ts, win)
                if not prior:
                    continue
                _, old = prior
                old_pct, new_pct = old.get("usedPercent"), win.get("usedPercent")
                old_reset, new_reset = old.get("resetsAt"), win.get("resetsAt")
                if None in (old_pct, new_pct) or not old_reset or not new_reset:
                    continue
                old_reset_dt = datetime.fromisoformat(old_reset.replace("Z", "+00:00"))
                new_reset_dt = datetime.fromisoformat(new_reset.replace("Z", "+00:00"))
                if (
                    old_pct - new_pct >= 5
                    and sample_ts < old_reset_dt
                    and new_reset_dt > old_reset_dt + timedelta(hours=6)
                ):
                    events.append({
                        "provider": provider,
                        "label": win.get("label") or "Usage window",
                        "detectedAt": sample["ts"],
                        "fromUsedPercent": old_pct,
                        "toUsedPercent": new_pct,
                        "previousResetAt": old_reset,
                        "newResetAt": new_reset,
                    })
    return events


def latest_windows():
    """Merge fresh windows without letting a transient omission erase one.

    CodexBar's Claude CLI source occasionally omits extraRateWindows (notably
    the Fable-only weekly limit) on an otherwise successful read. Keep each
    distinct window from the newest sample that reported it, bounded to two
    hours so genuinely removed limits do not linger indefinitely.
    """
    try:
        with open(WINDOWS) as f:
            samples = [json.loads(ln) for ln in f if ln.strip()]
        if not samples:
            return None
        merged = {
            "ts": None,
            "providers": {},
            "jubilees": detect_token_jubilees(samples),
        }
        newest_ts = None
        for sample in reversed(samples):
            if merged["ts"] is None:
                merged["ts"] = sample.get("ts")
                newest_ts = datetime.fromisoformat(merged["ts"])
            sample_ts = datetime.fromisoformat(sample.get("ts"))
            if (newest_ts - sample_ts).total_seconds() > 7200:
                break
            for provider, payload in (sample.get("providers") or {}).items():
                if provider not in merged["providers"]:
                    merged["providers"][provider] = {
                        **payload,
                        "windows": list(payload.get("windows") or []),
                    }
                    continue
                current = merged["providers"][provider]
                seen = {
                    (win.get("slot"), win.get("label"))
                    for win in current.get("windows") or []
                }
                for win in payload.get("windows") or []:
                    key = (win.get("slot"), win.get("label"))
                    if key not in seen:
                        current.setdefault("windows", []).append(win)
                        seen.add(key)
        return merged
    except (FileNotFoundError, IndexError, json.JSONDecodeError):
        return None

# Seed budgets (editable in budgets.json). Monthly pace targets per sub; the
# dashed line = budget spread evenly across the billing cycle. cycleAnchorDay =
# day-of-month the subscription renews (1 = calendar month until confirmed).
# planPriceUSD = flat monthly plan cost, retained as plan metadata even though
# the dashboard's subscription value card now leads with API list-price
# equivalent spend for the selected billing cycle.
DEFAULT_BUDGETS = {
    "claude": {"cycleAnchorDay": 1, "planPriceUSD": 0, "monthlyCostUSD": 0},
    "codex": {"cycleAnchorDay": 1, "planPriceUSD": 0, "monthlyCostUSD": 0},
}


def codexbar_cost(provider):
    out = subprocess.run(
        [CODEXBAR, "cost", "--provider", provider, "--format", "json"],
        capture_output=True, text=True, timeout=180)
    if out.returncode != 0 or not out.stdout.strip():
        err = (out.stderr or out.stdout or "no output").strip().splitlines()[-1]
        raise RuntimeError(f"codexbar cost {provider} exited {out.returncode}: {err}")
    payload = json.loads(out.stdout)
    return payload[0] if payload else {}


def day_record(day):
    """Normalize one CodexBar daily[] entry into our stored shape."""
    models = {}
    for mb in day.get("modelBreakdowns") or []:
        name = mb.get("modelName") or "unknown"
        models[name] = {
            "tokens": mb.get("totalTokens", 0),
            "cost": round(mb.get("cost", 0), 6),
        }
    return {
        "input": day.get("inputTokens", 0),
        "output": day.get("outputTokens", 0),
        "cacheRead": day.get("cacheReadTokens", 0),
        "cacheCreation": day.get("cacheCreationTokens", 0),
        "total": day.get("totalTokens", 0),
        "cost": round(day.get("totalCost", 0), 6),
        "models": models,
    }


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main():
    dry = "--dry-run" in sys.argv
    if not DATA_ROOT:
        raise SystemExit("HUMANWARE_DATA_ROOT is required")
    os.makedirs(DATA_DIR, exist_ok=True)

    store = load_json(STORE, {})
    budgets = load_json(BUDGETS, {})
    changed = False
    for sub, defaults in DEFAULT_BUDGETS.items():
        cur = budgets.setdefault(sub, {})
        for k, v in defaults.items():
            if k not in cur:  # fill missing keys (e.g. cycleAnchorDay) without clobbering edits
                cur[k] = v
                changed = True
    if changed:
        failures = ["budgets: source config omitted default keys; in-memory defaults applied"]
    else:
        failures = []

    for provider, _ in PROVIDERS:
        try:
            data = codexbar_cost(provider)
        except Exception as exc:  # keep last-known history on a bad pull
            failures.append(f"{provider}: {exc}")
            continue
        pstore = store.setdefault(provider, {})
        for day in data.get("daily") or []:
            date = day.get("date")
            if date:
                pstore[date] = day_record(day)  # refresh; today grows, past finalize

    with open(STORE, "w") as f:
        json.dump(store, f, indent=2, sort_keys=True)

    local = local_usage()
    buzz = {"status": "paused", "startedAt": load_json(BUZZ_BASELINE, {}).get("startedAt"), "days": []}
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "budgets": budgets,
        "providers": {
            provider: {"displayName": name, "days": store.get(provider, {})}
            for provider, name in PROVIDERS
        },
        "localModels": [
            {**m, "usage": local.get(m["name"], {"days": {}, "totalTokens": 0})}
            for m in LOCAL_MODELS
        ],
        "windows": latest_windows(),
        "slack": slack_activity(),
        "buzz": buzz,
        # Third-column sources, filled in as they come online:
        "metered": [],  # OpenRouter / opencode via OpenRouter (Phase 2/3)
        "directApi": {  # business API-key spend; needs admin-scoped keys in Doppler
            "status": "pending-admin-key",
            "note": "Needs ANTHROPIC_ADMIN_KEY (sk-ant-admin) + OPENAI_ADMIN_KEY (api.usage.read) in Doppler.",
        },
    }
    if failures:
        out["warnings"] = failures

    if dry:
        print(json.dumps(out, indent=2)[:2000])
        print(f"\n[dry-run] {len(store.get('claude', {}))} claude days, "
              f"{len(store.get('codex', {}))} codex days; "
              f"warnings={failures or 'none'}")
        return 0 if not failures else 1

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT}; warnings={failures or 'none'}")
    return 0 if len(failures) < len(PROVIDERS) else 1


if __name__ == "__main__":
    sys.exit(main())
