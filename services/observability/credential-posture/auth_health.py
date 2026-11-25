"""Bounded local Claude status and model-independent auth notifications."""
import json
import os
import subprocess
import urllib.request
from datetime import datetime, timezone


def check_claude(check, runner=subprocess.run, now=None):
    now = now or datetime.now(timezone.utc)
    result = {"id": check["id"], "provider": "claude-cli", "state": "unavailable"}
    try:
        run = runner([check["command"], "auth", "status", "--json"],
                     capture_output=True, text=True, timeout=20,
                     env={key: value for key, value in os.environ.items()
                          if not key.startswith(("ANTHROPIC_", "CLAUDE_CODE_OAUTH_"))
                          and key != "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR"})
        status = json.loads(run.stdout)
        if not isinstance(status, dict):
            return result
        if status.get("loggedIn") is False:
            return {**result, "state": "auth_failed"}
        if run.returncode or status.get("loggedIn") is not True:
            return result
        # Auth status proves local selection, not remote model acceptance.
        result["state"] = "locally_authenticated"
        expiry = status.get("loginExpiresAt")
        if expiry:
            if not isinstance(expiry, str):
                return {**result, "state": "unavailable"}
            end = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            if end.tzinfo is None:
                return {**result, "state": "unavailable"}
            result["loginExpiresAt"] = end.isoformat()
            seconds = (end - now).total_seconds()
            if seconds <= 0:
                result["state"] = "auth_failed"
            elif seconds <= check.get("warnDays", 7) * 86400:
                result["state"] = "expiring"
        else:
            result["state"] = "expiry_unknown"
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        result["state"] = "unavailable"
    return result


def auth_issues(checks):
    return sorted((row["id"], row["state"]) for row in checks
                  if row["state"] in {"auth_failed", "unavailable", "not_configured",
                                      "expiring", "expiry_unknown"})


def notify(config, checks, state_path, now=None, environ=os.environ,
           opener=urllib.request.urlopen):
    """Record dedupe only after Slack acknowledges; never expose response bodies."""
    now = now or datetime.now(timezone.utc)
    issues = auth_issues(checks)
    signature = json.dumps(issues)
    previous = {}
    try:
        with open(state_path) as handle:
            previous = json.load(handle)
    except FileNotFoundError:
        pass
    if not isinstance(previous, dict):
        raise RuntimeError("auth notification state is malformed")
    if not issues and not previous.get("active"):
        return
    elapsed = now.timestamp() - previous.get("sentAt", 0)
    if signature == previous.get("signature") and elapsed < config.get("repeatHours", 24) * 3600:
        return
    token = environ.get(config["tokenEnv"])
    if not token:
        raise RuntimeError("auth notification credential unavailable")
    text = ("Credential authentication attention: " + "; ".join(
        f"{name}: {state}" for name, state in issues)) if issues else "Credential authentication checks recovered. Local Claude status is not a remote model probe."
    body = {"channel": config["channel"], "text": text}
    if config.get("threadTs"):
        body["thread_ts"] = config["threadTs"]
    request = urllib.request.Request("https://slack.com/api/chat.postMessage",
        data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8"})
    try:
        with opener(request, timeout=15) as response:
            receipt = json.load(response)
        if not isinstance(receipt, dict) or receipt.get("ok") is not True or not receipt.get("ts"):
            raise RuntimeError("auth notification delivery not confirmed")
    except (OSError, ValueError) as error:
        raise RuntimeError("auth notification delivery unavailable") from error
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    temporary = state_path + ".tmp"
    with open(temporary, "w") as handle:
        json.dump({"signature": signature, "active": bool(issues),
                   "sentAt": now.timestamp()}, handle)
    os.replace(temporary, state_path)
