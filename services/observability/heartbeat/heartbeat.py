#!/usr/bin/env python3
"""OpenClaw agent heartbeat monitor + self-healer (runs on the gateway host via launchd).

Checks, in order of cost:
  1. gateway process alive + port listening
  2. dispatch suspicion: Slack inbound events with zero agent activity after them
  3. provider failure burst in the recent log window
  4. every CANARY_EVERY_N runs: a real agent turn per agent ("reply OK") through the gateway

Self-healing: only independently verified failures trigger an automatic gateway
restart, capped at RESTART_BUDGET per hour so a crash-loop escalates to a human
instead of flapping. Every actual restart gets a direct #ops lifecycle thread
from the gateway launcher, independent of this monitor. A restart is never attempted while a detectable agent run
is in flight — after MAX_RESTART_DEFERRALS cycles the monitor escalates instead,
because a kickstart mid-message-send corrupts the session transcript
(2026-07-24). A successful repair opens no second incident alert; the gateway
launcher records the restart and recovery in its own #ops thread. Failures a restart can't fix
(billing, expired OAuth, scope grants) skip remediation and DM a diagnosis with
the exact next command instead.

Silent-loss surfacing: each run incrementally scans the gateway log for the
three signatures that mean a reply was lost with no user-visible error
(stalled run, dropped reply payload, dead transcript) and reports the counts.
Detection only — restarts cause two of the three, so they never remediate.

Alerting follows the incident protocol agreed 2026-07-25 (severity, not volume):

  SILENT  self-healed, first strikes, anything with no human decision in it.
          Appended to the rollup log; never sent anywhere.
  NOTICE  a repeated or unresolved failure the monitor cannot fix. Opens ONE
          incident thread in #ops and posts every later update as a reply
          in that same thread, so an incident reads as one story instead of a
          stream of alerts. Resolution is posted to the thread and closes it.
  PAGE    the human personally has to act. Keep it in the same #ops incident
          thread, stating what failed, what the monitor already tried, the
          single action, and what breaks if they wait. If no action can be
          named, it is not a page.

Transport is deliberately independent of OpenClaw: direct Slack API via a bot
token pulled from Doppler at send time (configured project order), posted under a
distinct monitor identity so alerts read as machine telemetry rather than as a
message from an agent. #ops is the only alert surface. A check must fail twice
in a row to act (restarts cause
one-cycle blips) and re-alerts are throttled.

State lives in STATE_PATH (transient; safe to delete). Instance values
(incident channel, agents, Doppler projects, host paths) come from the instance
config.json; see README.md and config.example.json.
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

def _runtime_root():
    """HUMANWARE_RUNTIME_ROOT, else <runtime> derived from the framework layout
    (<runtime>/framework/services/observability/heartbeat/<this file>)."""
    env = os.environ.get("HUMANWARE_RUNTIME_ROOT")
    if env:
        return env
    parts = os.path.abspath(__file__).split(os.sep)
    if len(parts) > 5 and parts[-5] == "framework":
        return os.sep.join(parts[:-5])
    return None


def load_instance_config():
    """$HEARTBEAT_CONFIG, else <runtime>/config/services/observability/heartbeat/config.json.

    The instance owns every host- and workspace-specific value; see
    config.example.json for the schema. Missing file or missing required keys
    stop the monitor with a precise message instead of alerting a wrong channel.
    """
    path = os.environ.get("HEARTBEAT_CONFIG")
    if not path:
        root = _runtime_root()
        if not root:
            raise SystemExit("heartbeat: set HEARTBEAT_CONFIG or HUMANWARE_RUNTIME_ROOT")
        path = os.path.join(root, "config", "services", "observability",
                            "heartbeat", "config.json")
    try:
        with open(path) as f:
            config = json.load(f)
    except (OSError, ValueError) as error:
        raise SystemExit(f"heartbeat: cannot read instance config {path}: {error}")
    missing = [key for key in ("incidentChannel", "agents", "dopplerProjects")
               if not config.get(key)]
    if missing:
        raise SystemExit(f"heartbeat: {path} is missing {', '.join(missing)}")
    return config


CONFIG = load_instance_config()
DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT")
if not DATA_ROOT:
    raise SystemExit("heartbeat: HUMANWARE_DATA_ROOT is required")
INCIDENT_CHANNEL = CONFIG["incidentChannel"]      # the only alert surface
AGENTS = list(CONFIG["agents"])                   # canary targets, in order
DOPPLER_PROJECTS = list(CONFIG["dopplerProjects"])  # SLACK_BOT_TOKEN lookup order
DOPPLER_CONFIG = CONFIG.get("dopplerConfig", "prd")
MONITOR_NAME = CONFIG.get("monitorName", "humanware monitor")  # distinct identity, not an agent
MONITOR_ICON = CONFIG.get("monitorIcon", ":heartpulse:")
HOST_NAME = CONFIG.get("hostName", "the gateway host")  # named in page instructions
GATEWAY_LABEL = CONFIG.get("gatewayLabel", "ai.openclaw.gateway")
GATEWAY_PORT = int(CONFIG.get("gatewayPort", 18789))
LOG_DIR = CONFIG.get("gatewayLogDir", "/tmp/openclaw")
DOPPLER = CONFIG.get("dopplerBin", "/opt/homebrew/bin/doppler")
NODE = CONFIG.get("nodeBin", "/opt/homebrew/opt/node/bin/node")
OPENCLAW_JS = CONFIG.get("openclawJs",
                         "/opt/homebrew/lib/node_modules/openclaw/dist/index.js")
INCIDENT_TTL_H = 12      # after this, a still-failing check opens a fresh thread
CANARY_PAGE_AFTER = 4    # consecutive canary failures before a notice becomes a page
HEALTH_ROOT = os.path.join(DATA_ROOT, "generated", "reports", "health")
ROLLUP_PATH = os.path.join(HEALTH_ROOT, "heartbeat-rollup.jsonl")
ROLLUP_MAX_BYTES = 2_000_000  # ~one rotation of history; never fills the disk
GATEWAY_DOMAIN = f"gui/{os.getuid()}"
GATEWAY_SERVICE = f"{GATEWAY_DOMAIN}/{GATEWAY_LABEL}"
GATEWAY_PLIST = os.path.expanduser(f"~/Library/LaunchAgents/{GATEWAY_LABEL}.plist")
STATE_PATH = os.path.join(HEALTH_ROOT, "heartbeat-state.json")
WINDOW_MIN = 12          # log window for dispatch/provider checks
INBOUND_SETTLE_S = 90    # ignore inbounds younger than this (turn may be in flight)
CANARY_EVERY_N = 6       # full agent-turn canary every Nth run (6 x 5min = 30min)
CANARY_TIMEOUT_S = 150
REALERT_MIN = 30
RESTART_BUDGET = 2       # max auto-restarts per rolling hour
MAX_RESTART_DEFERRALS = 2  # cycles before escalating; never restart a detected active run
AGENT_NAMES = " and ".join(a.capitalize() for a in AGENTS)

# Checks strong enough to authorize a gateway restart. A missing log line is
# deliberately excluded: repeated weak evidence is still weak evidence.
RESTART_FIXABLE = {"gateway", "verified-runtime"}

# What a human should do when the monitor can't fix it. Shown in the DM.
NEXT_STEPS = {
    "gateway": (f"On {HOST_NAME}: launchctl kickstart -k {GATEWAY_SERVICE} ; "
                f"then check {LOG_DIR}/ logs"),
    "verified-runtime": (f"All agent canaries ({AGENT_NAMES}) failed repeatedly. "
                         f"Check {LOG_DIR}/ logs and provider status."),
    "provider": (f"Likely auth/billing, a restart won't help. On {HOST_NAME}: "
                 f"openclaw models status --agent {AGENTS[0]} — look for expired "
                 "OAuth or quota errors, then openclaw models auth login if needed"),
    "canary": (f"On {HOST_NAME}: openclaw agent --agent {{agent}} -m ping — read the "
               "error it prints; check openclaw models status --agent {agent}"),
    "silent-kill": (f"Replies may have been silently lost. On {HOST_NAME} grep "
                    f"{LOG_DIR}/openclaw-<today>.log for the signature, find "
                    "the sessionKey/thread, and check the thread + workspace "
                    "UNDELIVERED-*.md files. Dead transcripts need a fresh "
                    "mention to start a new session."),
}

# What it costs to wait. A page without a consequence is a notice in disguise.
WAIT_COST = {
    "gateway": f"Every Slack message to {AGENT_NAMES} is dropped until it is back.",
    "verified-runtime": "Agents look alive but answer nothing; messages are lost.",
    "provider": "All agent turns fail until the credential is renewed.",
    "canary": "{agent} cannot answer; the other agent still works.",
}

# Gateway log lines that mean an agent reply was (or is about to be) lost with
# no user-visible error. These never trigger remediation — a restart is what
# CAUSES two of them — they exist purely to surface the loss to a human.
SILENT_KILL_SIGNATURES = [
    ("stalled-run", "stalled session:"),
    ("dropped-reply", "no queued reply payloads"),
    ("dead-transcript", "transcript tail is not resumable"),
]


def now():
    return datetime.now().astimezone()


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {"checks": {}, "run": 0, "restarts": []}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=1)


# ---------- alert transports ----------

def doppler_get(project, name):
    try:
        out = subprocess.run(
            [DOPPLER, "secrets", "get", name, "--project", project,
             "--config", DOPPLER_CONFIG, "--plain"],
            capture_output=True, text=True, timeout=30)
        tok = out.stdout.strip()
        return tok if out.returncode == 0 and tok else None
    except Exception:
        return None


def slack_call(token, method, payload):
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def slack_post(token, channel, text, thread_ts=None):
    """Post as the monitor identity. Returns the message ts, or None.

    username/icon_emoji need chat:write.customize (granted on both agent apps)
    so heartbeat output does not wear an agent's face — it is a raw script, and
    a message from an agent invites a reply to it that nothing will ever read.
    """
    payload = {"channel": channel, "text": text,
               "username": MONITOR_NAME, "icon_emoji": MONITOR_ICON}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    posted = slack_call(token, "chat.postMessage", payload)
    return posted.get("ts") if posted.get("ok") else None


def slack_token():
    for project in DOPPLER_PROJECTS:
        tok = doppler_get(project, "SLACK_BOT_TOKEN")
        if tok:
            return tok
    return None


# ---------- severity + routing ----------

PAGE, NOTICE, SILENT = "page", "notice", "silent"


class Alert:
    """One thing the monitor observed, plus how loud it is allowed to be."""

    def __init__(self, severity, key, summary, tried=None, action=None,
                 resolves=False):
        self.severity = severity
        self.key = key
        self.summary = summary
        self.tried = tried
        self.action = action
        self.resolves = resolves

    def page_text(self):
        cost = WAIT_COST.get(
            "canary" if self.key.startswith("canary-") else self.key, "")
        if self.key.startswith("canary-"):
            cost = cost.format(agent=self.key.split("-", 1)[1])
        lines = [f"🔴 {self.key} — needs you.",
                 f"What failed: {self.summary}"]
        if self.tried:
            lines.append(f"Already tried: {self.tried}")
        lines.append(f"Your action: {self.action}")
        if cost:
            lines.append(f"If you wait: {cost}")
        return "\n".join(lines)

    def notice_text(self):
        mark = "✅" if self.resolves else "🟡"
        text = f"{mark} {self.summary}"
        if self.tried:
            text += f"\nAlready tried: {self.tried}"
        return text


def record(kind, key, summary, **extra):
    """Append one line to the durable rollup log.

    Everything the monitor observes lands here, including what was deliberately
    never sent and every failing check that never reached the two-strike
    threshold. Slack is a notification surface with a 90-day horizon; this file
    is the record. Rotated at ROLLUP_MAX_BYTES so it can never fill the disk.
    """
    entry = {"at": now().isoformat(), "kind": kind, "key": key,
             "summary": summary}
    entry.update(extra)
    try:
        os.makedirs(os.path.dirname(ROLLUP_PATH), exist_ok=True)
        if os.path.exists(ROLLUP_PATH) and os.path.getsize(ROLLUP_PATH) > ROLLUP_MAX_BYTES:
            os.replace(ROLLUP_PATH, ROLLUP_PATH + ".1")
        with open(ROLLUP_PATH, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def incident_thread(state, key, opening_text, token):
    """Return (ts, opened_now) for key's incident thread, opening one if needed.

    One thread per incident, not one message per observation: updates go back
    into the same story so the history stays readable. A thread older than
    INCIDENT_TTL_H is considered a closed chapter and a new one is opened.
    """
    incidents = state.setdefault("incidents", {})
    entry = incidents.get(key)
    if entry:
        age = now() - datetime.fromisoformat(entry["opened_at"])
        if age.total_seconds() / 3600 < INCIDENT_TTL_H:
            return entry["ts"], False
        incidents.pop(key, None)
    ts = slack_post(token, INCIDENT_CHANNEL, opening_text)
    if ts:
        incidents[key] = {"ts": ts, "opened_at": now().isoformat()}
    return ts, True


def deliver(state, alert):
    """Route one alert by severity, then record what actually happened to it."""
    label = route(state, alert)
    record("alert", alert.key, alert.summary, severity=alert.severity,
           delivery=label or "none")
    return label


def route(state, alert):
    """Send the alert. Returns a transport label, or None if nothing was sent."""
    if alert.severity == SILENT:
        return None
    if alert.resolves and alert.key not in state.get("incidents", {}):
        return None  # nothing was ever escalated; recovery needs no announcement
    posted = False
    token = slack_token()
    if token:
        try:
            ts, opened_now = incident_thread(
                state, alert.key,
                f"🫀 incident: *{alert.key}* — {alert.summary}", token)
            update_text = (alert.page_text() if alert.severity == PAGE else
                           alert.notice_text())
            posted = bool(ts) and (
                (opened_now and alert.severity != PAGE)
                or bool(slack_post(token, INCIDENT_CHANNEL,
                                   update_text, thread_ts=ts)))
            if alert.resolves:
                state.get("incidents", {}).pop(alert.key, None)
        except Exception as e:
            record("delivery-error", alert.key, repr(e))
    if posted:
        return f"thread:{INCIDENT_CHANNEL}"
    record("delivery-error", alert.key,
           f"Slack refused alert delivery to {INCIDENT_CHANNEL}")
    return None


# ---------- checks ----------

def check_gateway():
    proc = subprocess.run(["pgrep", "-f", "openclaw/dist/index.js gateway"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return "gateway process not running"
    try:
        with socket.create_connection(("127.0.0.1", GATEWAY_PORT), timeout=5):
            pass
    except OSError:
        return f"gateway port {GATEWAY_PORT} not accepting connections"
    return None


def read_log_window():
    """Return (inbound_times, activity_times, provider_error_lines) within WINDOW_MIN."""
    path = os.path.join(LOG_DIR, f"openclaw-{now():%Y-%m-%d}.log")
    cutoff = now() - timedelta(minutes=WINDOW_MIN)
    inbound, activity, provider_errors = [], [], []
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                m = re.search(r'"time":"([0-9T:.+-]+)"', line)
                if not m:
                    continue
                try:
                    ts = datetime.fromisoformat(m.group(1))
                except ValueError:
                    continue
                if ts < cutoff:
                    continue
                if '"message":"Inbound ' in line:
                    inbound.append(ts)
                elif ('cli exec:' in line or 'live session turn' in line
                      or 'Embedded run' in line or 'embedded run' in line):
                    activity.append(ts)
                if ('FailoverError' in line
                        or 'All model fallback candidates' in line
                        or 'MissingAgentHarnessError' in line):
                    provider_errors.append(line[:200])
    except FileNotFoundError:
        pass
    return inbound, activity, provider_errors


def check_dispatch(inbound, activity):
    settled = [t for t in inbound
               if (now() - t).total_seconds() > INBOUND_SETTLE_S]
    if not settled:
        return None
    latest_settled = max(settled)
    if any(a >= latest_settled - timedelta(seconds=5) for a in activity):
        return None
    return (f"{len(settled)} Slack event(s) arrived since "
            f"{min(settled):%H:%M} but no agent turn followed (dispatch dead?)")


def check_provider(provider_errors):
    if len(provider_errors) >= 3:
        return (f"{len(provider_errors)} provider errors in last "
                f"{WINDOW_MIN}m, e.g.: {provider_errors[-1][:150]}")
    return None


def check_canary(agent):
    try:
        out = subprocess.run(
            [NODE, OPENCLAW_JS, "agent", "--agent", agent,
             "-m", "Heartbeat check. Reply with exactly: OK"],
            capture_output=True, text=True, timeout=CANARY_TIMEOUT_S)
        reply = (out.stdout or "").strip().splitlines()
        if reply and "OK" in reply[-1]:
            return None
        tail = (out.stderr or out.stdout or "no output").strip()[-200:]
        return f"canary turn for {agent} did not return OK: {tail}"
    except subprocess.TimeoutExpired:
        return f"canary turn for {agent} timed out after {CANARY_TIMEOUT_S}s"
    except Exception as e:
        return f"canary for {agent} errored: {e}"


def scan_silent_kills(state):
    """Incrementally scan the gateway log for silent reply-loss signatures.

    Maintains a byte offset in state so each line is examined once. Handles
    rotation (new day = new path) and truncation (restarts can shrink the
    file). On first run the offset is baselined to EOF so deploying the check
    never alerts on old history. Returns {category: count} of NEW occurrences.
    """
    path = os.path.join(LOG_DIR, f"openclaw-{now():%Y-%m-%d}.log")
    scan = state.setdefault("logscan", {})
    counts = {}
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    previous = scan.get("path")
    if previous and previous != path:
        # Day rolled over. Drain the tail of yesterday's file before moving on,
        # or every loss between the last run and midnight is invisible forever
        # — the failure mode this whole check exists to prevent.
        count_signatures(previous, scan.get("offset", 0), counts)
    if size is None:
        return counts
    if previous != path:
        offset = 0 if previous else size  # first ever run: baseline at EOF
        scan["path"] = path
    else:
        offset = scan.get("offset", 0)
        if size < offset:  # truncated in place (e.g. hard restart)
            offset = 0
    scan["offset"] = count_signatures(path, offset, counts)
    return counts


def count_signatures(path, offset, counts):
    """Tally silent-kill signatures in path from offset. Returns the new offset."""
    try:
        with open(path, errors="ignore") as f:
            f.seek(offset)
            for line in f:
                for category, needle in SILENT_KILL_SIGNATURES:
                    if needle in line:
                        counts[category] = counts.get(category, 0) + 1
                        break
            return f.tell()
    except OSError:
        return offset


def process_silent_kills(state, counts):
    """Accumulate signature counts and alert, throttled, without recovery noise.

    These are discrete loss events, not a persistent up/down condition, so the
    two-strikes rule and the recovery message of process() don't apply: any new
    occurrence is already a lost (or dying) reply. Repeat alerts are throttled
    to REALERT_MIN with counts accumulating in between.

    Always a NOTICE, never a page: this check is detection-only by construction
    (a restart CAUSES two of the three signatures), so there is no action only
    the human can take. This is the exact alert that used to arrive as a DM.
    """
    c = state["checks"].setdefault(
        "silent-kill", {"pending": {}, "alerted_at": None})
    for category, n in counts.items():
        c["pending"][category] = c["pending"].get(category, 0) + n
    if not c["pending"]:
        return []
    last = (datetime.fromisoformat(c["alerted_at"])
            if c.get("alerted_at") else None)
    if last and (now() - last).total_seconds() < REALERT_MIN * 60:
        return []
    detail = ", ".join(f"{n}× {cat}" for cat, n in sorted(c["pending"].items()))
    c["pending"] = {}
    c["alerted_at"] = now().isoformat()
    return [Alert(NOTICE, "silent-kill",
                  f"silent-kill signatures in gateway log: {detail}",
                  tried=f"detection only. {NEXT_STEPS['silent-kill']}")]


def verify_dispatch_suspicion(suspicion):
    """Corroborate a weak dispatch signal without treating it as proof.

    The log heuristic cannot identify which event should map to which run, so
    it never authorizes remediation by itself. Only failure of both independent
    agent canaries upgrades the condition to a verified runtime failure.
    """
    if not suspicion:
        return None
    failures = [failure for agent in AGENTS
                if (failure := check_canary(agent)) is not None]
    if len(failures) != len(AGENTS):
        return None
    return f"{suspicion}; both agent canaries failed: {' | '.join(failures)}"


# ---------- remediation ----------

def active_agent_runs():
    """Count in-flight agent model runs the gateway spawned as child processes.

    claude-cli runs are `claude -p` subprocesses whose args reference the
    per-session MCP sidecar config (openclaw-cli-mcp-*). A kickstart while one
    is mid-message-send leaves a dangling tool call and a non-resumable
    transcript (2026-07-24: four agent threads died this way). In-process
    runs (ollama HTTP) are invisible to this check and die with the gateway
    regardless; claude-cli is the primary runtime and the one worth guarding.
    """
    proc = subprocess.run(["pgrep", "-f", "openclaw-cli-mcp"],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        return 0
    return len(proc.stdout.split())


def restart_budget_left(state):
    hour_ago = now() - timedelta(hours=1)
    state["restarts"] = [t for t in state.get("restarts", [])
                         if datetime.fromisoformat(t) > hour_ago]
    return RESTART_BUDGET - len(state["restarts"])


def gateway_service_registered():
    result = subprocess.run(
        ["launchctl", "print", GATEWAY_SERVICE],
        capture_output=True, text=True, timeout=30)
    return result.returncode == 0


def start_gateway_service():
    if gateway_service_registered():
        command = ["launchctl", "kickstart", "-k", GATEWAY_SERVICE]
    else:
        command = ["launchctl", "bootstrap", GATEWAY_DOMAIN, GATEWAY_PLIST]
    result = subprocess.run(
        command, capture_output=True, text=True, timeout=60)
    return result.returncode == 0


def restart_gateway(state, key):
    state.setdefault("restarts", []).append(now().isoformat())
    if not start_gateway_service():
        return False
    time.sleep(20)
    return check_gateway() is None


def next_steps_for(key):
    base = key.split("-")[0] if key.startswith("canary-") else key
    hint = NEXT_STEPS.get("canary" if key.startswith("canary-") else base, "")
    if key.startswith("canary-"):
        hint = hint.format(agent=key.split("-", 1)[1])
    return hint


# ---------- state machine ----------

def process(state, key, failure):
    """Track consecutive failures; on the 2nd, self-heal if verified.

    Returns Alerts, not strings: severity is decided here, at the only place
    that knows whether remediation was attempted, whether it worked, and
    whether anything is left for a human to do. Successful self-healing stays
    silent; a failure the monitor cannot fix becomes a NOTICE in the incident
    thread; only an exhausted-remediation state with a nameable action pages.
    Re-alerts for failures that remain broken are throttled to REALERT_MIN.
    The launcher announces every actual restart separately in #ops.
    """
    c = state["checks"].setdefault(
        key, {"fails": 0, "alerted_at": None, "alerting": False})
    alerts = []
    if failure:
        c["fails"] += 1
        last = (datetime.fromisoformat(c["alerted_at"])
                if c["alerted_at"] else None)
        due = (not last
               or (now() - last).total_seconds() >= REALERT_MIN * 60)
        if c["fails"] >= 2 and due:
            if key in RESTART_FIXABLE and restart_budget_left(state) > 0:
                runs = active_agent_runs()
                if runs:
                    c["deferrals"] = c.get("deferrals", 0) + 1
                    c["alerting"] = True
                    if c["deferrals"] <= MAX_RESTART_DEFERRALS:
                        # Do not start the re-alert throttle yet: check again
                        # next cycle and repair promptly if the runs finish.
                        # Nothing for a human to do while we wait — notice.
                        alerts.append(Alert(
                            NOTICE, key, failure,
                            tried=(f"restart needed but {runs} agent run(s) "
                                   f"still active; deferring "
                                   f"({c['deferrals']}/{MAX_RESTART_DEFERRALS}) "
                                   f"so a kickstart doesn't kill a turn "
                                   f"mid-send")))
                    else:
                        # A long run may be healthy. Never trade a verified
                        # gateway failure for a known transcript corruption;
                        # escalate and let a human inspect the run.
                        c["alerted_at"] = now().isoformat()
                        alerts.append(Alert(
                            PAGE, key, failure,
                            tried=(f"deferred {MAX_RESTART_DEFERRALS} cycles; "
                                   f"restart still blocked by {runs} active "
                                   f"agent run(s), refusing to restart"),
                            action=next_steps_for(key)))
                    return alerts
                c["deferrals"] = 0
                fixed = restart_gateway(state, key)
                if fixed:
                    c["fails"] = 0
                    c["alerted_at"] = None
                    was_alerting, c["alerting"] = c["alerting"], False
                    if was_alerting:
                        alerts.append(Alert(
                            NOTICE, key, f"{key} recovered after auto-restart",
                            resolves=True))
                    return alerts
                alerts.append(Alert(
                    PAGE, key, failure,
                    tried="auto-restart, which did NOT bring the gateway back",
                    action=next_steps_for(key)))
            elif key in RESTART_FIXABLE:
                alerts.append(Alert(
                    PAGE, key, failure,
                    tried=(f"auto-restart {RESTART_BUDGET}× in the last hour; "
                           f"budget exhausted, this is a crash-loop"),
                    action=next_steps_for(key)))
            elif key.startswith("canary-") and c["fails"] < CANARY_PAGE_AFTER:
                # One agent failing to answer is real but not yet urgent, and
                # the first cycles are often a provider blip that clears.
                alerts.append(Alert(NOTICE, key, failure,
                                    tried="nothing — a restart can't fix this class"))
            else:
                alerts.append(Alert(
                    PAGE, key, failure,
                    tried="nothing — a restart cannot fix this class",
                    action=next_steps_for(key)))
            c["alerted_at"] = now().isoformat()
            c["alerting"] = True
    else:
        if c["alerting"]:
            alerts.append(Alert(NOTICE, key, f"{key} recovered", resolves=True))
        c["fails"] = 0
        c["alerted_at"] = None
        c["alerting"] = False
        c["deferrals"] = 0
    return alerts


def observe(state, key, failure):
    """Record every failing observation, then decide what to do about it.

    The rollup gets the raw signal including first strikes, which never
    generate an alert: "it failed once and cleared" is exactly the pattern that
    is invisible in Slack and obvious in a log.
    """
    if failure:
        record("observation", key, failure,
               strike=state["checks"].get(key, {}).get("fails", 0) + 1)
    return process(state, key, failure)


def main():
    state = load_state()
    state["run"] = state.get("run", 0) + 1
    alerts = []

    gateway_failure = check_gateway()
    alerts += observe(state, "gateway", gateway_failure)

    if check_gateway() is None:  # re-check: remediation may just have fixed it
        inbound, activity, provider_errors = read_log_window()
        dispatch_suspicion = check_dispatch(inbound, activity)
        if dispatch_suspicion:
            record("weak-signal", "slack-dispatch", dispatch_suspicion)
        verified_runtime_failure = verify_dispatch_suspicion(dispatch_suspicion)
        alerts += observe(state, "verified-runtime", verified_runtime_failure)
        alerts += observe(state, "provider", check_provider(provider_errors))
        kills = scan_silent_kills(state)
        for category, n in sorted(kills.items()):
            record("silent-kill", category, f"{n} new in gateway log", count=n)
        alerts += process_silent_kills(state, kills)
        if state["run"] % CANARY_EVERY_N == 0:
            for agent in AGENTS:
                alerts += observe(state, f"canary-{agent}", check_canary(agent))

    for alert in alerts:
        via = deliver(state, alert)
        label = via or "silent"
        print(f"{now().isoformat()} [{alert.severity}/{label}] "
              f"{alert.key}: {alert.summary}")
    if not alerts:
        pending = [k for k, c in state["checks"].items() if c.get("fails")]
        status = (f"first strike pending: {', '.join(pending)}" if pending
                  else "all clear")
        print(f"{now().isoformat()} {status} (run {state['run']})")
    save_state(state)


if __name__ == "__main__":
    sys.exit(main())
