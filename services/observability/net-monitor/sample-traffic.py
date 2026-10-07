#!/usr/bin/env python3
"""Sample outbound network connections on this host (the "Lulu" exhaust feed).

This is the *tracking* half of the Lulu network-monitor project. LuLu itself
(Objective-See's outbound firewall) is the *control* half and lives only on the
MacBook, where a human is present to answer its GUI prompts. On the headless
mini we skip enforcement and just observe: who is this machine talking to, and
(best effort) how much.

Design mirrors ops/token-tracking: a low-frequency launchd sampler appends to a
durable JSONL history; a separate builder aggregates the latest window into the
dashboard's data.json. Kept apart so a slow reverse-DNS lookup never stalls the
page build.

Source of truth:
  - `lsof` for the process -> remote endpoint mapping (established TCP + UDP).
  - `nettop` for best-effort per-process byte volume (optional; guarded).
Loopback, link-local, and private-LAN peers are dropped as noise. Remote IPs are
reverse-resolved (cached) and tagged against a known-endpoints map so the
dashboard can separate "expected infra" from "unknown / phoning home".

Output: $HUMANWARE_DATA_ROOT/generated/reports/security/connections.jsonl  (one JSON object per sample, appended)

Usage:
  sample-traffic.py [--dry-run]
"""

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone

LSOF = "/usr/sbin/lsof"
NETTOP = "/usr/bin/nettop"
DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", "")
DATA_DIR = os.path.join(DATA_ROOT, "generated", "reports", "security")
HISTORY = os.path.join(DATA_DIR, "connections.jsonl")
DNS_CACHE = os.path.join(DATA_DIR, "dns-cache.json")

# Substring -> owner tag. First match wins. Reverse-DNS name is checked first,
# then falls back to IP-range hints for the big clouds. "unknown" is the
# security-interesting bucket the dashboard should surface loudly.
KNOWN = [
    ("apple.com", "Apple"), ("icloud.com", "Apple"), ("aaplimg.com", "Apple"),
    ("mzstatic.com", "Apple"), ("push.apple", "Apple"),
    ("anthropic.com", "Anthropic"), ("claude.ai", "Anthropic"),
    ("openai.com", "OpenAI"), ("oaistatic.com", "OpenAI"), ("chatgpt.com", "OpenAI"),
    ("slack.com", "Slack"), ("slack-edge", "Slack"), ("slack-msgs", "Slack"),
    ("github.com", "GitHub"), ("githubusercontent", "GitHub"),
    ("githubcopilot", "GitHub"), ("actions.githubusercontent", "GitHub"),
    ("google.com", "Google"), ("googleapis.com", "Google"), ("gstatic.com", "Google"),
    ("1e100.net", "Google"), ("googleusercontent", "Google"),
    ("dropbox.com", "Dropbox"), ("dropbox-dns", "Dropbox"),
    ("cloudflare.com", "Cloudflare"), ("cloudflare-dns", "Cloudflare"),
    ("amazonaws.com", "AWS"), ("tailscale.com", "Tailscale"), ("ts.net", "Tailscale"),
    ("doppler.com", "Doppler"), ("ollama", "Ollama (local)"),
    ("notion.so", "Notion"), ("notionusercontent", "Notion"),
]

# Network -> owner, for endpoints with no reverse DNS. Most IPv6 destinations
# have none, so without this nearly everything tags "unknown" and the bucket
# that is supposed to mean "look at this" becomes wallpaper.
#
# Only ranges whose registration is verifiable go here. Guessing an owner is
# worse than "unknown": it hides a connection instead of flagging it. Unknowns
# get classified during the weekly review, and this list grows from that.
KNOWN_NETS = [
    ("162.125.0.0/16", "Dropbox"),
    ("2620:100:6000::/44", "Dropbox"),
    ("2606:4700::/32", "Cloudflare"),
    ("104.16.0.0/12", "Cloudflare"),
    ("17.0.0.0/8", "Apple"),
    ("160.79.104.0/23", "Anthropic"),
    ("100.64.0.0/10", "Tailscale"),
]
KNOWN_NETS = [(ipaddress.ip_network(n), o) for n, o in KNOWN_NETS]


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def is_local(ip):
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (addr.is_loopback or addr.is_link_local or addr.is_private
            or addr.is_multicast or addr.is_unspecified)


def split_hostport(field):
    """lsof NAME like '192.168.68.78:51498->34.224.147.117:443' -> remote (ip,port)."""
    if "->" not in field:
        return None
    remote = field.split("->", 1)[1]
    # IPv6 form: [addr]:port ; IPv4 form: addr:port
    m = re.match(r"\[(.+)\]:(\d+|\*)$", remote) or re.match(r"(.+):(\d+|\*)$", remote)
    if not m:
        return None
    return m.group(1), m.group(2)


def resolve(ip, cache):
    if ip in cache:
        return cache[ip]
    name = None
    try:
        socket.setdefaulttimeout(1.5)
        name = socket.gethostbyaddr(ip)[0].lower()
    except (socket.herror, socket.gaierror, OSError):
        name = None
    cache[ip] = name
    return name


def tag(name, ip):
    hay = (name or "") + " " + ip
    for needle, owner in KNOWN:
        if needle in hay:
            return owner
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "unknown"
    for net, owner in KNOWN_NETS:
        if addr.version == net.version and addr in net:
            return owner
    return "unknown"


def process_names():
    """pid -> command name, from ps.

    lsof's COMMAND column is unreliable for attribution: it truncates
    ("DropboxFi", "sshd-sess") and for some processes reports a fragment of the
    argv instead of the name — the `claude` CLI shows up as "2.1.195". On a page
    whose entire job is "which process talked to whom", a truncated or wrong
    process name is the failure mode that matters most, so ask ps.
    """
    try:
        out = subprocess.run(["/bin/ps", "-axo", "pid=,comm="],
                             capture_output=True, text=True, timeout=20)
    except Exception:
        return {}
    names = {}
    for line in out.stdout.splitlines():
        pid, _, comm = line.strip().partition(" ")
        comm = comm.strip()
        if not (pid.isdigit() and comm):
            continue
        # sshd reports "sshd-session: admin@ttys000", which would split one
        # daemon into a new "process" per login. Keep the executable only.
        names[pid] = os.path.basename(comm).split(":")[0].split(" ")[0]
    return names


def collect_connections(cache):
    """Return list of {process, pid, ip, port, host, owner} for remote peers."""
    out = subprocess.run(
        [LSOF, "-nP", "-i", "-sTCP:ESTABLISHED"],
        capture_output=True, text=True, timeout=30)
    names = process_names()
    rows = []
    seen = set()
    for line in out.stdout.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 9:
            continue
        # The NAME column is not the last field: lsof appends a parenthesised
        # connection state, e.g. "1.2.3.4:80->5.6.7.8:443 (ESTABLISHED)". Take
        # the field that actually holds the arrow.
        name_field = next((p for p in reversed(parts) if "->" in p), None)
        if not name_field:
            continue
        pid = parts[1]
        proc = names.get(pid, parts[0])
        hp = split_hostport(name_field)
        if not hp:
            continue
        ip, port = hp
        if is_local(ip):
            continue
        key = (proc, ip, port)
        if key in seen:
            continue
        seen.add(key)
        host = resolve(ip, cache)
        rows.append({
            "process": proc, "pid": pid, "ip": ip, "port": port,
            "host": host, "owner": tag(host, ip),
        })
    return rows


def collect_bytes():
    """Best-effort per-process bytes this interval via nettop. Guarded: any
    parse issue returns {} rather than failing the whole sample."""
    try:
        out = subprocess.run(
            [NETTOP, "-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out"],
            capture_output=True, text=True, timeout=20)
        totals = {}
        for line in out.stdout.splitlines():
            cols = [c.strip() for c in line.split(",")]
            if len(cols) < 3 or not cols[1].isdigit():
                continue
            proc = cols[0].rsplit(".", 1)[0]
            try:
                totals[proc] = totals.get(proc, 0) + int(cols[1]) + int(cols[2])
            except ValueError:
                continue
        return totals
    except Exception:
        return {}


def main():
    dry = "--dry-run" in sys.argv
    if not DATA_ROOT:
        print("HUMANWARE_DATA_ROOT is required", file=sys.stderr)
        return 2
    os.makedirs(DATA_DIR, exist_ok=True)
    cache = load_json(DNS_CACHE, {})
    warnings = []

    try:
        conns = collect_connections(cache)
    except Exception as exc:
        print(f"lsof failed: {exc}", file=sys.stderr)
        return 1

    bytes_by_proc = collect_bytes()
    if not bytes_by_proc:
        warnings.append("nettop byte volume unavailable")

    # Roll up by owner for the at-a-glance view; keep raw conns for detail page.
    by_owner = {}
    for c in conns:
        by_owner[c["owner"]] = by_owner.get(c["owner"], 0) + 1

    sample = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "host": socket.gethostname(),
        "connCount": len(conns),
        "byOwner": by_owner,
        "unknownCount": by_owner.get("unknown", 0),
        "connections": conns,
        "bytesByProcess": bytes_by_proc,
    }
    if warnings:
        sample["warnings"] = warnings

    if dry:
        print(json.dumps(sample, indent=2))
        return 0

    with open(DNS_CACHE, "w") as f:
        json.dump(cache, f)
    with open(HISTORY, "a") as f:
        f.write(json.dumps(sample) + "\n")
    print(f"sampled {len(conns)} conns; owners={by_owner}; warnings={warnings or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
