#!/usr/bin/env python3
"""HumanwareOS capture ingest — the menu bar app's only backend.

The macOS menu bar app never speaks to Slack directly. It POSTs a capture to
this service over Tailscale; the service owns the Slack bot token, posts the
capture into #inbox, and writes a durable local copy. This is the same shape as
the voice-journal pipeline: Slack is the human view, a local file is the
durability layer. Designed to later fold into the OpenClaw gateway; kept as a
sibling service for M1 so it stays inside the app's own paths.

Stdlib only. The instance's run script hydrates SLACK_BOT_TOKEN (and optional
OAuth/user tokens) from its secret provider into the environment and execs this
file; no secret value is written to disk.

Captures post as the capturing *user* (their name, no APP badge) when that
user has authorized the capture Slack app — a user-scope OAuth install, one
authorize click per user, token stored in Doppler and hydrated at launch. The
bot token remains the fallback so capture never breaks: no authorized user, or
a dead user token, degrades to a bot post instead of a 5xx.

Environment (required values fail at startup when missing):
  HUMANWARE_DATA_ROOT    required — instance data root; captures default to
                         <root>/working/inbox/recordings, usage reads
                         <root>/generated/stats/windows.jsonl
  SLACK_BOT_TOKEN        required — bot token (hydrated by the run script)
  SLACK_BOT_TOKENS       optional — space-separated bot tokens used to index
                         Slack thread roots (default: SLACK_BOT_TOKEN)
  MENUBAR_INBOX_CHANNEL  required — Slack channel id captures post into
  MENUBAR_SLACK_TEAM_ID  required — Slack workspace id for native deep links
                         (falls back to HUMANWARE_SLACK_TEAM_ID)
  HUMANWARE_SLACK_WORKSPACE_DOMAIN
                         required — Slack workspace subdomain for thread URLs
                         (https://<domain>.slack.com/archives/...)
  MENUBAR_INGEST_BIND    host:port to bind (default 127.0.0.1:8899)
  MENUBAR_INGEST_TOKEN   optional shared bearer secret; if set, capture POSTs
                         must send Authorization: Bearer <it>
  MENUBAR_BOT_LABEL      name recorded in posted_as for bot posts (default bot)
  MENUBAR_CAPTURE_DIR    durable copy root (default
                         <data-root>/working/inbox/recordings)
  MENUBAR_SESSIONS_PATH  session-console ledger (default
                         <data-root>/generated/sessions/current.json)
  MENUBAR_USER_TOKEN_<SLACK_USER_ID>
                         optional — a user's xoxp token (user scope chat:write);
                         captures from that user post as them
  MENUBAR_CAPTURE_CLIENT_ID / MENUBAR_CAPTURE_CLIENT_SECRET /
  MENUBAR_OAUTH_REDIRECT optional — the capture app's OAuth creds and redirect
                         URL; without all three the /oauth/* endpoints report
                         themselves unconfigured
  MENUBAR_USER_TOKEN_DOPPLER_PROJECT / MENUBAR_USER_TOKEN_DOPPLER_CONFIG
                         optional — Doppler project/config the OAuth callback
                         writes user tokens to; unset → token shown once for
                         manual storage
  MENUBAR_DOPPLER_BIN    Doppler CLI (default: doppler on PATH)
  HUMANWARE_FRAMEWORK_OPS
                         framework ops dir (default derived from this file:
                         <framework>/services/ingest/server → <framework>/ops)
"""

from __future__ import annotations

import json
import os
import re
import secrets as pysecrets
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRAMEWORK_OPS = Path(os.environ.get("HUMANWARE_FRAMEWORK_OPS") or Path(__file__).resolve().parents[3] / "ops")
sys.path.insert(0, str(FRAMEWORK_OPS / "menubar"))
from thread_status import (  # noqa: E402
    render_groups as render_thread_groups_for_team,
    snapshot_from_sessions,
)

SLACK_API = "https://slack.com/api"
DEFAULT_BIND = "127.0.0.1:8899"
USER_TOKEN_ENV_PREFIX = "MENUBAR_USER_TOKEN_"
# Doppler home for user tokens — written via the host's personal CLI login
# (write-capable), read back at launch by the run script via a read-only
# service token. Key name goes to Doppler; the value only ever transits memory.
DOPPLER_BIN = os.environ.get("MENUBAR_DOPPLER_BIN", "doppler")
DOPPLER_PROJECT = os.environ.get("MENUBAR_USER_TOKEN_DOPPLER_PROJECT", "")
DOPPLER_CONFIG = os.environ.get("MENUBAR_USER_TOKEN_DOPPLER_CONFIG", "")
BOT_LABEL = os.environ.get("MENUBAR_BOT_LABEL", "bot")

# user id → xoxp token, seeded from env at startup and updated in place by the
# OAuth callback so a fresh authorize works without a service restart.
USER_TOKENS: dict[str, str] = {
    key[len(USER_TOKEN_ENV_PREFIX):]: value
    for key, value in os.environ.items()
    if key.startswith(USER_TOKEN_ENV_PREFIX) and value
}
USER_TOKENS_LOCK = threading.Lock()

# OAuth CSRF states: state → issued-at. Ten-minute expiry, single use.
OAUTH_STATES: dict[str, float] = {}
OAUTH_STATE_TTL = 600.0
_DATA_ROOT_ENV = os.environ.get("HUMANWARE_DATA_ROOT", "")
DATA_ROOT = Path(_DATA_ROOT_ENV) if _DATA_ROOT_ENV else None
DEFAULT_CAPTURE_DIR = DATA_ROOT / "working" / "inbox" / "recordings" if DATA_ROOT else None
# Rate-limit window utilization feed — same source that drives the stats page
# pace gauges. The menu bar app's usage module reads the latest sample via GET /usage.
WINDOWS_PATH = DATA_ROOT / "generated" / "stats" / "windows.jsonl" if DATA_ROOT else None
_SESSIONS_ENV = os.environ.get("MENUBAR_SESSIONS_PATH", "")
SESSIONS_PATH = (
    Path(_SESSIONS_ENV) if _SESSIONS_ENV
    else DATA_ROOT / "generated" / "sessions" / "current.json" if DATA_ROOT else None
)
SLACK_TEAM_ID = os.environ.get("MENUBAR_SLACK_TEAM_ID") or os.environ.get("HUMANWARE_SLACK_TEAM_ID", "")
SLACK_WORKSPACE_DOMAIN = os.environ.get("HUMANWARE_SLACK_WORKSPACE_DOMAIN", "")
INBOX_CHANNEL = os.environ.get("MENUBAR_INBOX_CHANNEL", "")


def missing_required_config() -> list[str]:
    """Names of required settings with no generic default that are unset."""
    missing = []
    if DATA_ROOT is None:
        missing.append("HUMANWARE_DATA_ROOT")
    if not INBOX_CHANNEL:
        missing.append("MENUBAR_INBOX_CHANNEL")
    if not SLACK_TEAM_ID:
        missing.append("MENUBAR_SLACK_TEAM_ID (or HUMANWARE_SLACK_TEAM_ID)")
    if not SLACK_WORKSPACE_DOMAIN:
        missing.append("HUMANWARE_SLACK_WORKSPACE_DOMAIN")
    return missing


THREAD_CACHE_TTL = 120.0
THREAD_CACHE: dict = {"at": 0.0, "snapshot": None, "refreshing": False}
THREAD_CACHE_LOCK = threading.Lock()


def latest_usage() -> dict:
    """Return the most recent Claude/Codex window sample, normalized for the app.

    Reads the last non-empty line of windows.jsonl and passes through only the
    fields the app renders: per-provider windows with label, usedPercent and the
    ISO reset timestamp (the app formats reset time in the viewer's local tz).
    Never fabricates: if the feed is missing/unreadable, returns ok=False so the
    app can show an honest "no usage data" state instead of zeros.
    """
    try:
        last = ""
        with open(WINDOWS_PATH, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    last = line
        if not last:
            return {"ok": False, "error": "no_samples"}
        sample = json.loads(last)
    except (OSError, ValueError) as error:
        return {"ok": False, "error": f"windows_read: {error}"}

    providers = {}
    for name in ("claude", "codex"):
        windows = []
        for win in (sample.get("providers", {}).get(name, {}) or {}).get("windows") or []:
            windows.append(
                {
                    "label": win.get("label"),
                    "slot": win.get("slot"),
                    "windowMinutes": win.get("windowMinutes"),
                    "usedPercent": win.get("usedPercent"),
                    "resetsAt": win.get("resetsAt"),
                }
            )
        providers[name] = {"windows": windows}
    return {"ok": True, "sampledAt": sample.get("ts"), "providers": providers}


def render_thread_groups(snapshot: dict) -> dict:
    return render_thread_groups_for_team(snapshot, SLACK_TEAM_ID)


def slack_api_get(token: str, method: str, **params) -> dict:
    query = urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})
    request = urllib.request.Request(
        f"{SLACK_API}/{method}?{query}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('error', 'unknown error')}")
    return data


def slack_pages(token: str, method: str, key: str, **params):
    cursor = None
    while True:
        data = slack_api_get(token, method, limit=200, cursor=cursor, **params)
        yield from data.get(key) or []
        cursor = (data.get("response_metadata") or {}).get("next_cursor") or None
        if not cursor:
            return


def slack_root_index(tokens: list[str], days: int = 90) -> dict:
    """Index Slack root titles and links, never lifecycle state."""
    oldest = str(time.time() - days * 86400)
    roots = {}
    conversations = {}
    for token in tokens:
        for conversation in slack_pages(
            token,
            "conversations.list",
            "channels",
            types="public_channel,private_channel",
            exclude_archived="true",
        ):
            if conversation.get("is_member"):
                conversations.setdefault(conversation.get("id"), (conversation, token))
    for conversation, token in conversations.values():
        channel_id = conversation.get("id")
        for message in slack_pages(
            token,
            "conversations.history",
            "messages",
            channel=channel_id,
            oldest=oldest,
            inclusive="true",
        ):
            if message.get("thread_ts") and message.get("thread_ts") != message.get("ts"):
                continue
            thread_ts = message.get("ts")
            roots[(channel_id, thread_ts)] = {
                "root_text": message.get("text") or "Untitled thread",
                "channel_name": conversation.get("name") or channel_id,
                "channel_id": channel_id,
                "thread_ts": thread_ts,
                "thread_url": f"https://{SLACK_WORKSPACE_DOMAIN}.slack.com/archives/{channel_id}/p{str(thread_ts).replace('.', '')}",
                "last_activity_at": datetime.fromtimestamp(
                    float(message.get("latest_reply") or thread_ts), timezone.utc
                ).isoformat().replace("+00:00", "Z"),
            }
    return roots


def enrich_session_snapshot(snapshot: dict, roots: dict) -> dict:
    """Enrich presentation metadata without changing ledger lifecycle state."""
    enriched = []
    for thread in snapshot.get("threads") or []:
        root = roots.get((thread.get("channel_id"), thread.get("thread_ts")))
        if root and re.match(r"^Parent thread:\s+[A-Z0-9]+\s+\d+(?:\.\d+)?(?:\s+<@[A-Z0-9]+>)?\s*$", root.get("root_text") or ""):
            root = {key: value for key, value in root.items() if key != "root_text"}
        metadata = {key: value for key, value in (root or {}).items()
                    if key in {"root_text", "channel_name", "thread_url", "last_activity_at"}}
        enriched.append({**thread, **metadata})
    return {**snapshot, "source": "session-ledger+slack-roots", "threads": enriched}


def refresh_thread_cache(tokens: list[str]) -> None:
    try:
        roots = slack_root_index(tokens)
        with THREAD_CACHE_LOCK:
            THREAD_CACHE.update(at=time.time(), snapshot=roots)
    except (OSError, ValueError, TypeError, RuntimeError):
        pass
    finally:
        with THREAD_CACHE_LOCK:
            THREAD_CACHE["refreshing"] = False


def latest_threads() -> dict:
    """Return current non-closed Slack threads grouped by lifecycle state.

    The session ledger is authoritative for lifecycle state. Slack roots enrich
    titles and links so the menu never displays a latest-reply session title.
    """
    try:
        data = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
        snapshot = snapshot_from_sessions(data)
    except (OSError, ValueError, TypeError) as error:
        return {"ok": False, "error": f"threads_read: {error}"}
    tokens = (os.environ.get("SLACK_BOT_TOKENS") or os.environ.get("SLACK_BOT_TOKEN") or "").split()
    if tokens:
        cached_roots = None
        start_refresh = False
        with THREAD_CACHE_LOCK:
            cached_roots = THREAD_CACHE["snapshot"]
            if time.time() - THREAD_CACHE["at"] >= THREAD_CACHE_TTL and not THREAD_CACHE["refreshing"]:
                THREAD_CACHE["refreshing"] = True
                start_refresh = True
        if start_refresh:
            threading.Thread(target=refresh_thread_cache, args=(tokens,), daemon=True).start()
        if cached_roots:
            snapshot = enrich_session_snapshot(snapshot, cached_roots)
    return render_thread_groups(snapshot)


def slack_post_message(token: str, channel: str, text: str) -> dict:
    payload = json.dumps({"channel": channel, "text": text}).encode()
    request = urllib.request.Request(
        f"{SLACK_API}/chat.postMessage",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise RuntimeError(f"chat.postMessage: {data.get('error', 'unknown error')}")
    return data


def oauth_exchange(code: str) -> tuple[str, str]:
    """Exchange an OAuth code for (user_id, xoxp_token) via oauth.v2.access."""
    payload = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": os.environ["MENUBAR_CAPTURE_CLIENT_ID"],
            "client_secret": os.environ["MENUBAR_CAPTURE_CLIENT_SECRET"],
            "redirect_uri": os.environ["MENUBAR_OAUTH_REDIRECT"],
        }
    ).encode()
    request = urllib.request.Request(
        f"{SLACK_API}/oauth.v2.access",
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    if not data.get("ok"):
        raise RuntimeError(f"oauth.v2.access: {data.get('error', 'unknown error')}")
    authed = data.get("authed_user") or {}
    user_id, token = authed.get("id"), authed.get("access_token")
    if not user_id or not token:
        raise RuntimeError("oauth.v2.access: response missing authed_user id/token")
    return user_id, token


def doppler_store_user_token(user_id: str, token: str) -> str | None:
    """Persist a user token to Doppler; value goes over stdin, never argv/disk.

    Returns None on success, else the error text. Uses the host's personal
    Doppler CLI login (the per-agent service tokens are read-only), so the
    subprocess env must not carry a DOPPLER_TOKEN override.
    """
    if not (DOPPLER_PROJECT and DOPPLER_CONFIG):
        return "MENUBAR_USER_TOKEN_DOPPLER_PROJECT / MENUBAR_USER_TOKEN_DOPPLER_CONFIG are not set"
    env = {k: v for k, v in os.environ.items() if k != "DOPPLER_TOKEN"}
    try:
        result = subprocess.run(
            [
                DOPPLER_BIN, "secrets", "set", f"{USER_TOKEN_ENV_PREFIX}{user_id}",
                "--project", DOPPLER_PROJECT, "--config", DOPPLER_CONFIG,
                "--no-check-version", "--silent",
            ],
            input=token.encode(),
            capture_output=True,
            timeout=30,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return str(error)
    if result.returncode != 0:
        return result.stderr.decode(errors="replace").strip() or f"exit {result.returncode}"
    return None


def pick_post_token(requested_user: str) -> tuple[str, str, str]:
    """Choose the posting identity: (token, kind, user_id).

    A capture names its user explicitly, or inherits the sole authorized user
    (the single-user install that is the normal case today). No match → the
    bot token, so capture never depends on OAuth state.
    """
    with USER_TOKENS_LOCK:
        if requested_user and requested_user in USER_TOKENS:
            return USER_TOKENS[requested_user], "user", requested_user
        if not requested_user and len(USER_TOKENS) == 1:
            user_id, token = next(iter(USER_TOKENS.items()))
            return token, "user", user_id
    return os.environ.get("SLACK_BOT_TOKEN", ""), "bot", ""


def slugify(text: str, limit: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:limit] or "capture"


def write_durable_copy(
    capture_dir: Path,
    *,
    text: str,
    is_task: bool,
    source: str,
    slack_channel: str,
    slack_ts: str,
    posted_as: str,
    created: datetime,
) -> Path:
    day_dir = capture_dir / created.strftime("%Y") / created.strftime("%m") / created.strftime("%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    name = f"{created.strftime('%Y%m%d-%H%M%S')}-{slugify(text)}.md"
    path = day_dir / name
    frontmatter = (
        "---\n"
        f"type: {'task' if is_task else 'note'}\n"
        f"source: {source}\n"
        f"created: {created.isoformat()}\n"
        f"slack_channel: {slack_channel}\n"
        f"slack_ts: {slack_ts}\n"
        f"posted_as: {posted_as}\n"
        "---\n\n"
    )
    path.write_text(frontmatter + text.rstrip() + "\n")
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "HumanwareOSIngest/1"

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:  # quieter, one line to stderr
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")

    def _authorized(self) -> bool:
        required = os.environ.get("MENUBAR_INGEST_TOKEN")
        if not required:
            return True
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {required}"

    def _html(self, status: int, body: str) -> None:
        page = (
            "<!doctype html><meta charset=utf-8>"
            "<title>HumanwareOS Capture</title>"
            "<body style='font: 16px/1.5 -apple-system, sans-serif; max-width: 34em;"
            " margin: 4em auto; padding: 0 1em'>" + body
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def _oauth_creds_missing(self) -> bool:
        return not (
            os.environ.get("MENUBAR_CAPTURE_CLIENT_ID")
            and os.environ.get("MENUBAR_CAPTURE_CLIENT_SECRET")
            and os.environ.get("MENUBAR_OAUTH_REDIRECT")
        )

    def _oauth_start(self) -> None:
        if self._oauth_creds_missing():
            self._html(500, "<p>OAuth not configured: MENUBAR_CAPTURE_CLIENT_ID / "
                            "MENUBAR_CAPTURE_CLIENT_SECRET / MENUBAR_OAUTH_REDIRECT are not set.</p>")
            return
        state = pysecrets.token_urlsafe(24)
        now = time.monotonic()
        OAUTH_STATES[state] = now
        for key in [k for k, t in OAUTH_STATES.items() if now - t > OAUTH_STATE_TTL]:
            OAUTH_STATES.pop(key, None)
        query = urllib.parse.urlencode(
            {
                "client_id": os.environ["MENUBAR_CAPTURE_CLIENT_ID"],
                "user_scope": "chat:write",
                "redirect_uri": os.environ["MENUBAR_OAUTH_REDIRECT"],
                "state": state,
            }
        )
        self.send_response(302)
        self.send_header("Location", f"https://slack.com/oauth/v2/authorize?{query}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _oauth_callback(self) -> None:
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        state = (params.get("state") or [""])[0]
        code = (params.get("code") or [""])[0]
        if params.get("error"):
            self._html(400, f"<p>Slack returned <code>{params['error'][0]}</code> — "
                            "nothing was changed.</p>")
            return
        if OAUTH_STATES.pop(state, None) is None:
            self._html(400, "<p>Stale or unknown OAuth state — start again from "
                            "<code>/capture/oauth/start</code>.</p>")
            return
        if not code or self._oauth_creds_missing():
            self._html(400, "<p>Missing code or OAuth credentials.</p>")
            return
        try:
            user_id, token = oauth_exchange(code)
        except Exception as error:  # noqa: BLE001 — report the exact failure
            self._html(502, f"<p>Token exchange failed: <code>{error}</code></p>")
            return
        with USER_TOKENS_LOCK:
            USER_TOKENS[user_id] = token
        store_error = doppler_store_user_token(user_id, token)
        if store_error:
            # Live in memory (works until restart) but not durable — surface the
            # value once, in the browser only, for a manual Doppler web-UI paste.
            self._html(
                200,
                f"<p>Connected as <code>{user_id}</code> — captures now post as you, "
                "but the Doppler write failed, so this dies at the next service "
                f"restart.</p><p>Doppler error: <code>{store_error}</code></p>"
                f"<p>Paste this into Doppler ({DOPPLER_PROJECT}/{DOPPLER_CONFIG}) as "
                f"<code>{USER_TOKEN_ENV_PREFIX}{user_id}</code>:</p>"
                f"<p><code>{token}</code></p>",
            )
            return
        self._html(
            200,
            f"<p>Connected as <code>{user_id}</code>. Captures now post as you; "
            f"token stored in Doppler as "
            f"<code>{USER_TOKEN_ENV_PREFIX}{user_id}</code>. You can close this tab.</p>",
        )

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "humanwareos-ingest"})
        elif self.path == "/usage":
            if not self._authorized():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, latest_usage())
        elif self.path == "/threads":
            if not self._authorized():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, latest_threads())
        elif self.path.startswith("/oauth/start"):
            self._oauth_start()
        elif self.path.startswith("/oauth/callback"):
            self._oauth_callback()
        else:
            self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/capture":
            self._json(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"ok": False, "error": "bad_json"})
            return

        text = (body.get("text") or "").strip()
        source = (body.get("source") or "menubar").strip()
        if not text:
            self._json(400, {"ok": False, "error": "empty_capture"})
            return

        is_task = text.startswith("!")
        content = text[1:].strip() if is_task else text
        if not content:
            self._json(400, {"ok": False, "error": "empty_capture"})
            return

        requested_user = (body.get("user") or "").strip()
        token, token_kind, token_user = pick_post_token(requested_user)
        if not token:
            self._json(500, {"ok": False, "error": "no_slack_token"})
            return

        channel = INBOX_CHANNEL
        if not channel:
            self._json(500, {"ok": False, "error": "MENUBAR_INBOX_CHANNEL not set"})
            return
        slack_text = f"🗂️ *Task* · {content}" if is_task else content
        posted_as = f"user:{token_user}" if token_kind == "user" else f"bot:{BOT_LABEL}"
        try:
            posted = slack_post_message(token, channel, slack_text)
        except Exception as error:  # noqa: BLE001
            # A dead/revoked user token must not lose the capture — fall back to
            # the bot identity and report which one actually posted.
            bot_token = os.environ.get("SLACK_BOT_TOKEN")
            if token_kind != "user" or not bot_token:
                self._json(502, {"ok": False, "error": f"slack: {error}"})
                return
            sys.stderr.write(f"capture: user token post failed ({error}); bot fallback\n")
            posted_as = f"bot:{BOT_LABEL}-fallback"
            try:
                posted = slack_post_message(bot_token, channel, slack_text)
            except Exception as bot_error:  # noqa: BLE001 — report the exact failure
                self._json(502, {"ok": False, "error": f"slack: {bot_error}"})
                return

        created = datetime.now(timezone.utc).astimezone()
        capture_dir = Path(os.environ.get("MENUBAR_CAPTURE_DIR") or str(DEFAULT_CAPTURE_DIR))
        try:
            durable = write_durable_copy(
                capture_dir,
                text=content,
                is_task=is_task,
                source=source,
                slack_channel=channel,
                slack_ts=posted.get("ts", ""),
                posted_as=posted_as,
                created=created,
            )
        except OSError as error:
            # Slack already has it; report the durability failure but don't lose the capture.
            self._json(
                207,
                {
                    "ok": True,
                    "slack_ts": posted.get("ts"),
                    "is_task": is_task,
                    "posted_as": posted_as,
                    "durable_error": str(error),
                },
            )
            return

        self._json(
            200,
            {
                "ok": True,
                "slack_ts": posted.get("ts"),
                "channel": channel,
                "is_task": is_task,
                "posted_as": posted_as,
                "durable_path": str(durable),
            },
        )


def main() -> int:
    bind = os.environ.get("MENUBAR_INGEST_BIND", DEFAULT_BIND)
    host, _, port = bind.rpartition(":")
    missing = missing_required_config()
    if missing:
        sys.stderr.write("humanwareos-ingest: missing required configuration: " + ", ".join(missing) + "\n")
        return 2
    if not os.environ.get("SLACK_BOT_TOKEN"):
        sys.stderr.write("warning: SLACK_BOT_TOKEN not set — captures will 500 until hydrated\n")
    server = ThreadingHTTPServer((host or "127.0.0.1", int(port)), Handler)
    sys.stderr.write(f"humanwareos-ingest listening on {host}:{port}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
