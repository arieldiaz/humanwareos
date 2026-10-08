#!/usr/bin/env python3
"""Single-use email magic links for private artifact and Grist shares."""

from __future__ import annotations

import hashlib
import html
import json
import os
import secrets
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

def _pairs(value: str) -> dict[str, str]:
    """Parse "key=value,key=value" configuration into a dict."""
    result = {}
    for item in (value or "").split(","):
        if "=" in item:
            key, val = item.split("=", 1)
            if key.strip():
                result[key.strip()] = val.strip()
    return result


def _db_path() -> Path:
    if os.environ.get("SHARE_AUTH_DB"):
        return Path(os.environ["SHARE_AUTH_DB"])
    if os.environ.get("HUMANWARE_DATA_ROOT"):
        return Path(os.environ["HUMANWARE_DATA_ROOT"]) / "operations" / "control" / "share-auth" / "auth.sqlite3"
    return None


DB_PATH = _db_path()
PUBLIC_ORIGIN = os.environ.get("SHARE_AUTH_ORIGIN", "").rstrip("/")
BIND = os.environ.get("SHARE_AUTH_BIND", "127.0.0.1:8792")
LINK_TTL = int(os.environ.get("SHARE_AUTH_LINK_TTL", "900"))
SESSION_TTL = int(os.environ.get("SHARE_AUTH_SESSION_TTL", "28800"))
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
MAIL_FROM = os.environ.get("SHARE_AUTH_MAIL_FROM", "")
MAIL_SUBJECT = os.environ.get("SHARE_AUTH_MAIL_SUBJECT", "Your private share")
# Path prefixes authorized by an exact grant, e.g. "/team-api/=/artifacts/team/dashboard/".
RESOURCE_ALIASES = _pairs(os.environ.get("SHARE_AUTH_RESOURCE_ALIASES", ""))
# Headers returned on a successful /auth/check, e.g. "X-Actor=private-share,X-Role=reader".
AUTHORIZED_HEADERS = _pairs(os.environ.get("SHARE_AUTH_AUTHORIZED_HEADERS", ""))
COOKIE_NAME = "__Host-share_session"
PUBLIC_ASSETS = {
    "/versioning/versioning.mjs", "/versioning/versioning.css", "/os-header.css", "/os-footer.css", "/os-footer.js",
    "/artifacts/artifact-shell.js", "/artifacts/artifact.css", "/artifacts/artifacts.css", "/artifacts/theme.css",
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_email(value: str) -> str:
    return value.strip().casefold()


def valid_resource(value: str) -> bool:
    return bool(re.fullmatch(r"/artifacts/[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*/", value))


class Store:
    def __init__(self, path: Path | None = None, aliases: dict[str, str] | None = None):
        path = path or DB_PATH
        if path is None:
            raise RuntimeError("share-auth: set SHARE_AUTH_DB or HUMANWARE_DATA_ROOT")
        self.path = Path(path)
        self.aliases = RESOURCE_ALIASES if aliases is None else aliases
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.setup()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def setup(self):
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS grants (
                    id INTEGER PRIMARY KEY, email TEXT NOT NULL, resource TEXT NOT NULL,
                    created_at INTEGER NOT NULL, revoked_at INTEGER,
                    UNIQUE(email, resource)
                );
                CREATE TABLE IF NOT EXISTS links (
                    token_hash TEXT PRIMARY KEY, grant_id INTEGER NOT NULL REFERENCES grants(id),
                    expires_at INTEGER NOT NULL, redeemed_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, grant_id INTEGER NOT NULL REFERENCES grants(id),
                    expires_at INTEGER NOT NULL, revoked_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY, occurred_at INTEGER NOT NULL, event TEXT NOT NULL,
                    grant_id INTEGER, detail TEXT
                );
                CREATE INDEX IF NOT EXISTS links_grant ON links(grant_id);
                CREATE INDEX IF NOT EXISTS sessions_grant ON sessions(grant_id);
            """)

    def invite(self, email: str, resource: str, now: int | None = None) -> tuple[int, str]:
        email = normalize_email(email)
        if not email or "@" not in email:
            raise ValueError("a valid recipient email is required")
        if not valid_resource(resource):
            raise ValueError("resource must be an artifact or Grist path")
        now = int(time.time()) if now is None else now
        token = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "INSERT INTO grants(email, resource, created_at, revoked_at) VALUES(?,?,?,NULL) "
                "ON CONFLICT(email,resource) DO UPDATE SET revoked_at=NULL",
                (email, resource, now),
            )
            grant_id = db.execute(
                "SELECT id FROM grants WHERE email=? AND resource=?", (email, resource)
            ).fetchone()["id"]
            db.execute("DELETE FROM links WHERE grant_id=? AND redeemed_at IS NULL", (grant_id,))
            db.execute(
                "INSERT INTO links(token_hash, grant_id, expires_at) VALUES(?,?,?)",
                (digest(token), grant_id, now + LINK_TTL),
            )
            db.execute(
                "INSERT INTO audit(occurred_at,event,grant_id) VALUES(?,?,?)",
                (now, "link_issued", grant_id),
            )
            db.commit()
        return grant_id, token

    def redeem(self, token: str, now: int | None = None) -> tuple[str, str] | None:
        now = int(time.time()) if now is None else now
        session = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT l.token_hash,l.grant_id,g.resource FROM links l JOIN grants g ON g.id=l.grant_id "
                "WHERE l.token_hash=? AND l.redeemed_at IS NULL AND l.expires_at>=? AND g.revoked_at IS NULL",
                (digest(token), now),
            ).fetchone()
            if row is None:
                db.rollback()
                return None
            changed = db.execute(
                "UPDATE links SET redeemed_at=? WHERE token_hash=? AND redeemed_at IS NULL",
                (now, row["token_hash"]),
            ).rowcount
            if changed != 1:
                db.rollback()
                return None
            db.execute(
                "INSERT INTO sessions(token_hash,grant_id,expires_at) VALUES(?,?,?)",
                (digest(session), row["grant_id"], now + SESSION_TTL),
            )
            db.execute(
                "INSERT INTO audit(occurred_at,event,grant_id) VALUES(?,?,?)",
                (now, "link_redeemed", row["grant_id"]),
            )
            db.commit()
        return session, row["resource"]

    def authorized(self, session: str, resource: str, now: int | None = None) -> bool:
        if resource in PUBLIC_ASSETS:
            return True
        for prefix, target in self.aliases.items():
            if resource.startswith(prefix):
                resource = target
                break
        now = int(time.time()) if now is None else now
        with self.connect() as db:
            row = db.execute(
                "SELECT g.resource FROM sessions s JOIN grants g ON g.id=s.grant_id "
                "WHERE s.token_hash=? AND s.expires_at>=? AND s.revoked_at IS NULL AND g.revoked_at IS NULL",
                (digest(session), now),
            ).fetchone()
        return bool(row and (resource == row["resource"].rstrip("/") or resource.startswith(row["resource"])))

    def revoke(self, grant_id: int, now: int | None = None) -> bool:
        now = int(time.time()) if now is None else now
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now, grant_id)
            ).rowcount
            db.execute("UPDATE sessions SET revoked_at=? WHERE grant_id=?", (now, grant_id))
            if changed:
                db.execute(
                    "INSERT INTO audit(occurred_at,event,grant_id) VALUES(?,?,?)",
                    (now, "grant_revoked", grant_id),
                )
            db.commit()
        return changed == 1


def send_link(email: str, token: str):
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY is not configured")
    if not PUBLIC_ORIGIN or not MAIL_FROM:
        raise RuntimeError("SHARE_AUTH_ORIGIN and SHARE_AUTH_MAIL_FROM are required to send links")
    link = f"{PUBLIC_ORIGIN}/auth/redeem?{urllib.parse.urlencode({'token': token})}"
    body = json.dumps({
        "from": MAIL_FROM, "to": [email], "subject": MAIL_SUBJECT,
        "html": f'<p>Open your private share:</p><p><a href="{html.escape(link)}">View shared item</a></p><p>This link expires in 15 minutes and works once.</p>',
    }).encode()
    request = urllib.request.Request(
        "https://api.resend.com/emails", data=body, method="POST",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status >= 300:
            raise RuntimeError(f"email provider returned {response.status}")


def cookie_token(header: str) -> str:
    jar = cookies.SimpleCookie()
    jar.load(header or "")
    return jar[COOKIE_NAME].value if COOKIE_NAME in jar else ""


class Handler(BaseHTTPRequestHandler):
    store: Store

    def reply(self, status: int, body: dict | str = "", headers: dict | None = None):
        encoded = json.dumps(body).encode() if isinstance(body, dict) else body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if isinstance(body, dict) else "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self) -> dict:
        length = min(int(self.headers.get("Content-Length", "0")), 8192)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.reply(200, {"ok": True, "mailConfigured": bool(RESEND_API_KEY)})
            return
        if parsed.path == "/auth/redeem":
            token = urllib.parse.parse_qs(parsed.query).get("token", [""])[0]
            result = self.store.redeem(token)
            if not result:
                self.reply(410, "This link is invalid, expired, or already used.")
                return
            session, resource = result
            self.reply(303, "", {
                "Location": resource,
                "Set-Cookie": f"{COOKIE_NAME}={session}; Path=/; Max-Age={SESSION_TTL}; Secure; HttpOnly; SameSite=Lax",
            })
            return
        if parsed.path == "/auth/check":
            resource = urllib.parse.urlparse(self.headers.get("X-Original-URI", "")).path
            session = cookie_token(self.headers.get("Cookie", ""))
            allowed = self.store.authorized(session, resource)
            self.reply(204 if allowed else 401, headers=AUTHORIZED_HEADERS if allowed else {})
            return
        self.reply(404, "Not found")

    def do_POST(self):
        if self.path == "/admin/invite":
            try:
                payload = self.read_json()
                email = normalize_email(str(payload.get("email", "")))
                resource = str(payload.get("resource", ""))
                grant_id, token = self.store.invite(email, resource)
                send_link(email, token)
                self.reply(201, {"ok": True, "grant_id": grant_id})
            except (ValueError, RuntimeError, urllib.error.URLError, json.JSONDecodeError) as error:
                self.reply(400, {"ok": False, "error": str(error)})
            return
        if self.path.startswith("/admin/revoke/"):
            try:
                grant_id = int(self.path.rsplit("/", 1)[1])
            except ValueError:
                self.reply(400, {"ok": False})
                return
            revoked = self.store.revoke(grant_id)
            self.reply(200 if revoked else 404, {"ok": revoked})
            return
        self.reply(404, "Not found")

    def log_message(self, pattern, *args):
        # Never log request paths, query parameters, cookies or response credentials.
        pass


if __name__ == "__main__":
    os.umask(0o077)
    missing = [name for name in ("SHARE_AUTH_ORIGIN", "SHARE_AUTH_MAIL_FROM") if not os.environ.get(name)]
    if missing or DB_PATH is None:
        raise SystemExit(f"share-auth: missing required configuration: {', '.join(missing or ['SHARE_AUTH_DB or HUMANWARE_DATA_ROOT'])}")
    host, port = BIND.rsplit(":", 1)
    Handler.store = Store()
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()
