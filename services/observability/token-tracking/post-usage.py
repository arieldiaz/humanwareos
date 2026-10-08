#!/usr/bin/env python3
"""Post subscription usage blocks to a Slack channel (weekly, via launchd).

Phase 1 of docs/token-tracking-spec.md: reads the Claude Max and Codex/ChatGPT
rate-window percentages via the CodexBar CLI (which rides the machine's
already-signed-in CLI sessions — no GUI, no extra auth) and posts one
mrkdwn snapshot to the configured channel. The over-time view accrues from
the posted history.

Notes that keep this working headless:
  - codexbar must be called by full path; it is not on launchd/ssh PATH.
  - codexbar prints a non-fatal Keychain cache error (-25308) on stderr when
    the login keychain is locked (SSH/launchd). Ignored unless the call fails.
  - Slack bot token is fetched from Doppler at send time
    (weeklyPost.dopplerProject / SLACK_BOT_TOKEN in the instance config.json).

Usage: post-usage.py [--dry-run]   (--dry-run prints the message, no post)
"""

import json
import os
import subprocess
import sys
import urllib.request

CODEXBAR = "/opt/homebrew/bin/codexbar"
DOPPLER = "/opt/homebrew/bin/doppler"
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


CONFIG = load_instance_config().get("weeklyPost") or {}
CHANNEL = CONFIG.get("channel")                 # Slack channel id
DOPPLER_PROJECT = CONFIG.get("dopplerProject")  # holds SLACK_BOT_TOKEN
DOPPLER_CONFIG = CONFIG.get("dopplerConfig") or "prd"
PROVIDERS = [("claude", "Claude"), ("codex", "Codex / ChatGPT")]


def codexbar_usage(provider):
    out = subprocess.run(
        [CODEXBAR, "usage", "--provider", provider, "--json"],
        capture_output=True, text=True, timeout=180)
    if out.returncode != 0 or not out.stdout.strip():
        err = (out.stderr or out.stdout or "no output").strip().splitlines()[-1]
        raise RuntimeError(f"codexbar exited {out.returncode}: {err}")
    return json.loads(out.stdout)[0]


def window_label(win):
    minutes = win.get("windowMinutes")
    if not minutes:
        return "Current block"
    if minutes % 10080 == 0:
        weeks = minutes // 10080
        return "Weekly" if weeks == 1 else f"{weeks}-week window"
    if minutes % 1440 == 0:
        return f"{minutes // 1440}-day window"
    if minutes % 60 == 0:
        return f"{minutes // 60}-hour block"
    return f"{minutes}-min block"


def window_line(label, win):
    pct = win.get("usedPercent")
    if pct is None:
        return None
    line = f"• {label}: {round(pct)}% used"
    reset = win.get("resetDescription")
    if reset:
        line += f" · resets {reset}"
    return line


def provider_section(display_name, data):
    usage = data.get("usage", {})
    login = usage.get("loginMethod")
    title = f"*{display_name}*" + (f" ({login})" if login else "")
    lines = [title]
    for key in ("primary", "secondary", "tertiary"):
        win = usage.get(key)
        if win:
            line = window_line(window_label(win), win)
            if line:
                lines.append(line)
    for extra in usage.get("extraRateWindows") or []:
        win = extra.get("window") or {}
        line = window_line(extra.get("title") or window_label(win), win)
        if line:
            lines.append(line)
    cost = usage.get("providerCost")
    if cost and cost.get("limit"):
        lines.append(f"• {cost.get('period', 'Cost')}: "
                     f"${cost.get('used', 0):g} / ${cost['limit']:g}")
    credits = data.get("credits") or {}
    if credits.get("remaining"):
        lines.append(f"• Credits remaining: {credits['remaining']:g}")
    if len(lines) == 1:
        lines.append("• no usage windows reported")
    return "\n".join(lines)


def build_message():
    sections = [":bar_chart: *Subscription usage — weekly snapshot*"]
    failures = []
    for provider, display_name in PROVIDERS:
        try:
            sections.append(provider_section(display_name,
                                             codexbar_usage(provider)))
        except Exception as exc:
            failures.append(f":warning: {display_name}: {exc}")
    sections.extend(failures)
    ok = len(failures) < len(PROVIDERS)
    return "\n\n".join(sections), ok


def doppler_get(project, name):
    out = subprocess.run(
        [DOPPLER, "secrets", "get", name, "--project", project,
         "--config", DOPPLER_CONFIG, "--plain"],
        capture_output=True, text=True, timeout=30)
    tok = out.stdout.strip()
    if out.returncode != 0 or not tok:
        raise RuntimeError(f"doppler get {project}/{name} failed")
    return tok


def post_to_slack(text):
    if not (CHANNEL and DOPPLER_PROJECT):
        raise RuntimeError("token-tracking config.json must set weeklyPost.channel "
                           "and weeklyPost.dopplerProject")
    token = doppler_get(DOPPLER_PROJECT, "SLACK_BOT_TOKEN")
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({"channel": CHANNEL, "text": text,
                         "unfurl_links": False}).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=utf-8"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.load(resp)
    if not result.get("ok"):
        raise RuntimeError(f"chat.postMessage failed: {result.get('error')}")


def main():
    message, ok = build_message()
    if "--dry-run" in sys.argv:
        print(message)
        return 0 if ok else 1
    if not ok:
        print(message, file=sys.stderr)
        return 1
    post_to_slack(message)
    print(f"posted usage snapshot to {CHANNEL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
