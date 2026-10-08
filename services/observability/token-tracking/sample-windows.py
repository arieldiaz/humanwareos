#!/usr/bin/env python3
"""Sample Claude + Codex rate-limit window utilization (runs every 30 min).

The dashboard's per-day token charts come from `codexbar cost` (local logs).
The *pace* tracks come from a different feed: `codexbar usage`, which reports
each reset window's used-percent (5-hour block, weekly, and any per-model /
Opus split). That feed is point-in-time, so we sample it on a schedule and
append to a durable JSONL history; the dashboard renders the latest snapshot
(gauge + pace marker) and can trend the history.

Kept separate from build-dashboard.py on purpose: `codexbar usage` is slower
than the cheap local parsing done by `codexbar cost`. Isolating it in its own
low-frequency launchd job keeps the hourly dashboard build fast and reliable.

Output: data/windows.jsonl  (one JSON object per sample, appended)
Claude uses its existing authenticated CLI session; no browser-cookie or
macOS app-data permission is required. Scheduled runs begin only after a manual
`--authorize-claude` smoke test succeeds. Later failures are recorded while the
collector keeps retrying; the dashboard retains its last good bounded sample.

Usage:
  sample-windows.py [--dry-run]
  sample-windows.py --authorize-claude
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

CODEXBAR = "/opt/homebrew/bin/codexbar"

def _runtime_root():
    """HUMANWARE_RUNTIME_ROOT, else <runtime> derived from the framework layout
    (<runtime>/framework/services/observability/token-tracking/<this file>)."""
    env = os.environ.get("HUMANWARE_RUNTIME_ROOT")
    if env:
        return env
    parts = os.path.abspath(__file__).split(os.sep)
    if len(parts) > 5 and parts[-5] == "framework":
        return os.sep.join(parts[:-5])
    return None


def load_instance_config():
    """<runtime>/config/services/observability/token-tracking/config.json, or {}."""
    root = _runtime_root()
    if not root:
        return {}
    path = os.path.join(root, "config", "services", "observability",
                        "token-tracking", "config.json")
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


CONFIG = load_instance_config()
DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", "")
DATA_DIR = os.path.join(DATA_ROOT, "generated", "reports", "stats")
HISTORY = os.path.join(DATA_DIR, "windows.jsonl")
CLAUDE_AUTHORIZED = os.path.join(DATA_DIR, "claude-window-authorized")
ALERT_STATE = os.path.join(DATA_DIR, "alert-state.json")
OPENCLAW = "/opt/homebrew/bin/openclaw"
_ALERTS = CONFIG.get("alerts") or {}
ALERT_CHANNEL = _ALERTS.get("target")    # openclaw target, e.g. "channel:C..."
ALERT_ACCOUNT = _ALERTS.get("account")   # openclaw Slack account id
STATS_URL = _ALERTS.get("statsUrl")      # optional link appended to alerts
LOCAL_TZ = ZoneInfo(CONFIG.get("timezone") or "UTC")
# Usage notifications are paused. Keep sampling for the dashboard, but do not
# post threshold alerts to Slack until the owner explicitly asks to restore them.
ALERT_MILESTONES = ()

PROVIDERS = [("claude", "Claude"), ("codex", "Codex / ChatGPT")]


def load_alert_state():
    try:
        with open(ALERT_STATE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def progress_bar(percent):
    filled = min(10, max(0, int(percent) // 10))
    return "█" * filled + "░" * (10 - filled)


def pace_percent(win, now):
    raw = win.get("resetsAt")
    minutes = win.get("windowMinutes")
    if not raw or not minutes:
        return None
    try:
        end = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    start = end.timestamp() - minutes * 60
    return min(100, max(0, (now.timestamp() - start) / (minutes * 60) * 100))


def alert_messages(sample, state, now=None):
    now = now or datetime.now(timezone.utc)
    messages = []
    for provider, payload in sample.get("providers", {}).items():
        provider_name = "Claude" if provider == "claude" else "Codex"
        for win in payload.get("windows") or []:
            used = float(win.get("usedPercent") or 0)
            reset = str(win.get("resetsAt") or win.get("resetDescription") or "unknown")
            key = f"{provider}:{win.get('slot')}:{win.get('label')}:{reset}"
            record = state.setdefault(key, {})
            elapsed = pace_percent(win, now)
            reached = max((m for m in ALERT_MILESTONES if used >= m), default=0)
            if reached <= int(record.get("milestone") or 0):
                continue
            record["milestone"] = reached
            if win.get("resetsAt"):
                reset_at = datetime.fromisoformat(str(win["resetsAt"]).replace("Z", "+00:00")).astimezone(LOCAL_TZ)
                reset_text = reset_at.strftime("%a %-I:%M %p %Z")
            else:
                reset_text = win.get("resetDescription") or "unknown"
            pace_text = ""
            if elapsed is not None:
                delta = round(used - elapsed)
                pace_text = f" · {abs(delta)} pts {'ahead of' if delta > 0 else 'behind'} elapsed pace"
            messages.append(
                f"**{provider_name} · {win.get('label', 'usage block')}**\n"
                f"`{progress_bar(used)}` **{round(used)}% used** · {round(100-used)}% left{pace_text}\n"
                f"Resets {reset_text}" + (f" · [open stats]({STATS_URL})" if STATS_URL else "")
            )
    sampled_providers = set(sample.get("providers", {}))
    active_resets = {
        f"{provider}:{win.get('slot')}:{win.get('label')}:{str(win.get('resetsAt') or win.get('resetDescription') or 'unknown')}"
        for provider, payload in sample.get("providers", {}).items()
        for win in payload.get("windows") or []
    }
    # A transient provider failure must not erase its milestone history and
    # trigger duplicate alerts when that feed recovers.
    return messages, {
        key: value for key, value in state.items()
        if key.split(":", 1)[0] not in sampled_providers or key in active_resets
    }


def deliver_alerts(sample, dry_run=False):
    state = load_alert_state()
    messages, state = alert_messages(sample, state)
    if dry_run:
        return messages
    if messages and not (ALERT_CHANNEL and ALERT_ACCOUNT):
        raise RuntimeError("token-tracking config.json must set alerts.target and alerts.account")
    for message in messages:
        subprocess.run([
            OPENCLAW, "message", "send", "--channel", "slack",
            "--account", ALERT_ACCOUNT, "--target", ALERT_CHANNEL,
            "--message", message, "--json",
        ], check=True, capture_output=True, text=True, timeout=30)
    with open(ALERT_STATE, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    return messages


def window_label(win):
    minutes = win.get("windowMinutes")
    if not minutes:
        return "Current block"
    if minutes % 10080 == 0:
        weeks = minutes // 10080
        return "Weekly" if weeks == 1 else f"{weeks}-week"
    if minutes % 1440 == 0:
        return f"{minutes // 1440}-day"
    if minutes % 60 == 0:
        return f"{minutes // 60}-hour"
    return f"{minutes}-min"


def parse_reset(win):
    """Preserve CodexBar's absolute reset timestamp when it exposes one."""
    for key in ("resetsAt", "resetAt", "nextResetAt"):
        value = win.get(key)
        if value is not None:
            return value
    return None


def window_obj(label, win):
    pct = win.get("usedPercent")
    if pct is None:
        return None
    return {
        "label": label,
        "windowMinutes": win.get("windowMinutes"),
        "usedPercent": round(pct, 2),
        "resetDescription": win.get("resetDescription"),
        "resetsAt": parse_reset(win),
    }


def codexbar_usage(provider):
    # Both providers can use their signed-in CLI sessions. Claude's CLI source
    # exposes the real 5h / weekly / Fable windows without browser-cookie access;
    # it is slower than Codex, so give it a wider timeout.
    source = "cli"
    timeout = 90 if provider == "claude" else 45
    out = subprocess.run(
        [CODEXBAR, "usage", "--provider", provider, "--json",
         "--source", source, "--web-timeout", "30", "--no-credits"],
        capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0 or not out.stdout.strip():
        err = (out.stderr or out.stdout or "no output").strip().splitlines()[-1]
        raise RuntimeError(f"codexbar usage {provider} exited {out.returncode}: {err}")
    payload = json.loads(out.stdout)[0]
    if payload.get("error"):
        raise RuntimeError(f"{provider}: {payload['error'].get('message')}")
    return payload


def provider_windows(provider, data):
    usage = data.get("usage", {})
    windows = []
    for key in ("primary", "secondary", "tertiary"):
        win = usage.get(key)
        if win:
            label = window_label(win)
            if provider == "claude" and key == "tertiary":
                label = "Weekly · Fable"
            obj = window_obj(label, win)
            if obj:
                obj["slot"] = key
                windows.append(obj)
    for extra in usage.get("extraRateWindows") or []:
        win = extra.get("window") or {}
        obj = window_obj(extra.get("title") or window_label(win), win)
        if obj:
            obj["slot"] = "extra"
            windows.append(obj)
    result = {"loginMethod": usage.get("loginMethod"), "windows": windows}
    cost = usage.get("providerCost")
    if cost and cost.get("limit"):
        result["providerCost"] = {
            "period": cost.get("period"), "used": cost.get("used", 0),
            "limit": cost.get("limit"),
        }
    return result


def main():
    dry = "--dry-run" in sys.argv
    authorize_claude = "--authorize-claude" in sys.argv
    if not DATA_ROOT:
        raise SystemExit("HUMANWARE_DATA_ROOT is required")
    os.makedirs(DATA_DIR, exist_ok=True)
    sample = {"ts": datetime.now(timezone.utc).isoformat(), "providers": {}}
    failures = []
    if authorize_claude:
        providers = [("claude", "Claude")]
    else:
        providers = [p for p in PROVIDERS if p[0] != "claude" or os.path.exists(CLAUDE_AUTHORIZED)]

    for provider, _ in providers:
        try:
            sample["providers"][provider] = provider_windows(provider, codexbar_usage(provider))
            if provider == "claude":
                with open(CLAUDE_AUTHORIZED, "w") as f:
                    f.write(sample["ts"] + "\n")
        except Exception as exc:
            failures.append(f"{provider}: {exc}")
    if not authorize_claude and not os.path.exists(CLAUDE_AUTHORIZED):
        sample["claudeStatus"] = "authorization-required"
    if failures:
        sample["warnings"] = failures

    if dry:
        sample["alertPreviews"] = deliver_alerts(sample, dry_run=True)
        print(json.dumps(sample, indent=2))
        return 0 if not failures else 1

    if sample["providers"]:  # don't append an all-failed row
        with open(HISTORY, "a") as f:
            f.write(json.dumps(sample) + "\n")
        alerts = deliver_alerts(sample)
        print(f"sampled windows: {list(sample['providers'])}; alerts={len(alerts)}; warnings={failures or 'none'}")
    else:
        print(f"no window data; warnings={failures}", file=sys.stderr)
    return 0 if sample["providers"] else 1


if __name__ == "__main__":
    sys.exit(main())
