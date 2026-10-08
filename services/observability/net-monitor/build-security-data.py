#!/usr/bin/env python3
"""Aggregate the network sampler + host audit into the security page feed.

Output: $HUMANWARE_DATA_ROOT/generated/reports/security/current.json

Split from sample-traffic.py on purpose (same shape as ops/token-tracking): the
sampler is dumb, frequent and append-only, so a slow reverse-DNS lookup or a
change to the page can never cost us history. This is the only thing that reads
the history, and it is safe to re-run at any time — it derives everything and
owns no state.

Windows:
  daily  = trailing 24h, bucketed hourly
  weekly = trailing 7d,  bucketed daily

First-seen is the highest-signal panel on the page and the easiest to poison. A
destination is "first seen" only if its earliest appearance across the ENTIRE
history falls inside the window. That means for the first BASELINE_HOURS of a
fresh install, everything is technically new and the panel is pure noise, so it
is suppressed and the page says so rather than crying wolf.

Usage:
  build-security-data.py [--window daily|weekly|both] [--audit] [--stdout]

  --audit  run the narrative rubric pass through the LOCAL model. Never a cloud
           model: process names, ports and remote endpoints are a precise map of
           this host's attack surface. See docs/security-page-spec.md.
"""

import argparse
import json
import os
import socket
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

DATA_ROOT = os.environ.get("HUMANWARE_DATA_ROOT", "")
SECURITY_DATA = os.path.join(DATA_ROOT, "generated", "reports", "security")
HISTORY = os.path.join(SECURITY_DATA, "connections.jsonl")
OUT = os.path.join(SECURITY_DATA, "current.json")
# Same location host-audit.py writes to.
AUDIT_DIR = os.environ.get("HUMANWARE_SECURITY_AUDIT_DIR",
                           os.path.expanduser("~/Library/Logs/humanware-security"))

BASELINE_HOURS = 48
TOP_N = 25
AUDIT_ROWS = 15  # rows per table handed to the local model; keeps the prompt inside num_ctx

OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
LOCAL_MODEL = "llama3.3:70b"

# host-audit.py emits finding ids and severities only. Titles live here so the
# page reads as prose; unmapped ids fall back to the id itself rather than
# being dropped, because a finding we forgot to name is still a finding.
AUDIT_TITLES = {
    "firewall-disabled": "macOS application firewall is disabled",
    "filevault-off": "FileVault is off",
    "stealth-mode-off": "Firewall stealth mode is off",
    "unexpected-public-listener": "Services listening on non-loopback interfaces",
    "duplicate-ollama": "Two Ollama launch jobs, one bound publicly",
}


def parse_ts(s):
    return datetime.fromisoformat(s)


def load_history():
    """Yield samples oldest-first. Tolerates a truncated final line: the
    sampler appends while we read, so a partial write is expected, not a bug."""
    if not os.path.exists(HISTORY):
        return []
    samples = []
    with open(HISTORY) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                s = json.loads(line)
                s["_ts"] = parse_ts(s["ts"])
                samples.append(s)
            except (ValueError, KeyError):
                continue
    samples.sort(key=lambda s: s["_ts"])
    return samples


def latest_audit():
    path = os.path.join(AUDIT_DIR, "latest.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def previous_audit(latest):
    """The newest versioned report that is not `latest`, for the weekly diff."""
    try:
        names = sorted(n for n in os.listdir(AUDIT_DIR)
                       if n.startswith("host-audit-") and n.endswith(".json"))
    except OSError:
        return None
    for name in reversed(names):
        try:
            with open(os.path.join(AUDIT_DIR, name)) as f:
                d = json.load(f)
        except (OSError, ValueError):
            continue
        if not latest or d.get("timestamp") != latest.get("timestamp"):
            return d
    return None


def dest_key(conn):
    """Group by hostname when we have one, IP otherwise. Cloud endpoints rotate
    IPs constantly; grouping on IP would report a new destination every hour for
    the same service."""
    return conn.get("host") or conn.get("ip")


def build_window(samples, hours, bucket_hours, first_seen_index, span_hours):
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    window = [s for s in samples if s["_ts"] >= start]

    series = defaultdict(int)
    by_dest = defaultdict(lambda: {"count": 0, "owner": "unknown", "ip": None})
    by_proc = defaultdict(lambda: {"count": 0, "peers": set()})

    for s in window:
        bucket = s["_ts"].replace(minute=0, second=0, microsecond=0)
        if bucket_hours >= 24:
            bucket = bucket.replace(hour=0)
        else:
            bucket = bucket.replace(hour=(bucket.hour // bucket_hours) * bucket_hours)
        series[bucket.isoformat()] += s.get("connCount", 0)

        for c in s.get("connections", []):
            k = dest_key(c)
            d = by_dest[k]
            d["count"] += 1
            d["ip"] = c.get("ip")
            if c.get("owner") and c["owner"] != "unknown":
                d["owner"] = c["owner"]
            p = by_proc[c["process"]]
            p["count"] += 1
            p["peers"].add(k)

    # Suppressed rather than wrong: with less than a baseline of history every
    # destination looks new, and a first-seen panel full of Apple and Slack
    # teaches you to ignore the panel.
    if span_hours < BASELINE_HOURS:
        first_seen = []
        baseline_pending = round(BASELINE_HOURS - span_hours, 1)
    else:
        baseline_pending = None
        first_seen = sorted(
            (v for v in first_seen_index.values() if v["_first"] >= start),
            key=lambda v: v["_first"], reverse=True)
        first_seen = [{k: v for k, v in r.items() if not k.startswith("_")}
                      | {"first_seen": r["_first"].isoformat()}
                      for r in first_seen[:TOP_N]]

    return {
        "samples": len(window),
        "baseline_pending_hours": baseline_pending,
        "series": [{"t": t, "count": c} for t, c in sorted(series.items())],
        "first_seen": first_seen,
        "by_destination": sorted(
            ({"host": k, "ip": v["ip"], "owner": v["owner"], "count": v["count"]}
             for k, v in by_dest.items()),
            key=lambda r: r["count"], reverse=True)[:TOP_N],
        "by_process": sorted(
            ({"process": k, "count": v["count"], "peers": len(v["peers"])}
             for k, v in by_proc.items()),
            key=lambda r: r["count"], reverse=True)[:TOP_N],
    }


def build_first_seen_index(samples):
    """Earliest observation of every (destination, process) pair, over all
    history — not over the window, or every window boundary invents novelty."""
    index = {}
    for s in samples:
        for c in s.get("connections", []):
            k = (dest_key(c), c["process"])
            if k not in index:
                index[k] = {
                    "host": c.get("host"), "ip": c.get("ip"),
                    "process": c["process"], "owner": c.get("owner", "unknown"),
                    "_first": s["_ts"],
                }
    return index


def build_posture(samples, audit):
    newest = samples[-1] if samples else None
    posture = {
        "peers": 0,
        "unknown": 0,
        "public_listeners": None,
        "firewall": None,
        "filevault": None,
    }
    if newest:
        posture["peers"] = len({dest_key(c) for c in newest.get("connections", [])})
        posture["unknown"] = newest.get("unknownCount", 0)
    if audit:
        posture["public_listeners"] = sum(
            1 for l in audit.get("listeners", [])
            if l.get("public_bind") and not l.get("expected_public"))
        # host-audit stores these as the raw `defaults`/`fdesetup` strings.
        posture["firewall"] = "disabled" not in audit.get("posture", {}).get("firewall", "").lower()
        posture["filevault"] = "off" not in audit.get("posture", {}).get("filevault", "").lower()
    return posture


def audit_findings(audit):
    """Collapse the host audit's per-instance findings into one row per kind.

    host-audit.py emits one finding per offending object, so a machine with 14
    unexpected public listeners produces 14 identically-titled rows. Rendered
    straight, that is a wall the eye slides off, and the two critical findings
    underneath it disappear. Group by id and put the instances in the detail.
    """
    groups = defaultdict(list)
    for f in (audit or {}).get("findings", []):
        groups[f.get("id", "unknown")].append(f)

    out = []
    for fid, items in groups.items():
        sev = "high" if any(i.get("severity") in ("critical", "high")
                            for i in items) else items[0].get("severity", "low")
        instances = []
        for i in items:
            ev = i.get("evidence") or {}
            label = ev.get("endpoint") or ev.get("label") or ev.get("path")
            proc = ev.get("process")
            if label:
                instances.append(f"{label}{f' ({proc})' if proc else ''}")
        detail = f"{len(items)} instances: " + ", ".join(instances[:8]) if instances else \
            "Reported by the weekly host audit."
        if len(instances) > 8:
            detail += f", +{len(instances) - 8} more"
        out.append({
            "severity": sev,
            "title": AUDIT_TITLES.get(fid, fid.replace("-", " ").capitalize()),
            "detail": detail,
            "action": "See docs/mac-mini-security-hardening-spec.md.",
            "count": len(items),
        })
    return out


def audit_diff(latest, previous):
    """What changed in the host's shape since the previous audit. Launch items
    and listeners are the two places persistence actually shows up."""
    if not latest or not previous:
        return None
    def labels(d, key, field):
        return {i.get(field) for i in d.get(key, [])}
    diff = {}
    for key, field in (("launch_items", "label"), ("listeners", "endpoint")):
        now, before = labels(latest, key, field), labels(previous, key, field)
        added, removed = sorted(now - before), sorted(before - now)
        if added or removed:
            diff[key] = {"added": added, "removed": removed}
    return diff or None


def run_local_audit(window, posture, label):
    """Narrative rubric pass on the LOCAL model. Receives the aggregated rollup
    only, never the raw JSONL. Returns [] on any failure — a dashboard that
    breaks because a model was down is worse than one without commentary."""
    rubric = (
        "You are auditing one machine's own network telemetry. Answer only from "
        "the data given.\n"
        "1. Any destination with no plausible owner for the process that reached it?\n"
        "2. Any process making external connections that has no business doing so?\n"
        "3. Any new listener, launch item, or destination since the last run?\n"
        "4. Any drift from a hardened posture (firewall on, no public listeners)?\n"
        "5. Any volume anomaly against the process's own baseline?\n\n"
        "Reply with ONLY a JSON array. Each element: "
        '{"severity":"high|medium|low","title":"...","detail":"...","action":"..."}. '
        "Empty array if nothing is worth the owner's attention. Do not invent rows "
        "that are not in the data.\n\n"
        f"Window: {label}\nPosture: {json.dumps(posture)}\n"
        f"Data: {json.dumps({k: window[k][:AUDIT_ROWS] for k in ('first_seen', 'by_destination', 'by_process')})}"
    )
    payload = json.dumps({
        "model": LOCAL_MODEL, "prompt": rubric, "stream": False,
        # num_ctx must be explicit. Ollama's default window for a 32B model on
        # this box is large enough that the runner gets OOM-killed mid-request
        # and returns {"error": "model runner has unexpectedly stopped"} — which
        # looks like the model is broken rather than the request being too big.
        "options": {"temperature": 0.2, "num_ctx": 8192},
    })
    try:
        out = subprocess.run(
            ["/usr/bin/curl", "-s", "--max-time", "300", OLLAMA_URL,
             "-H", "Content-Type: application/json", "-d", payload],
            capture_output=True, text=True, timeout=330)
        resp = json.loads(out.stdout)
        if "error" in resp:
            raise RuntimeError(resp["error"])
        body = resp["response"]
        start, end = body.find("["), body.rfind("]")
        if start < 0 or end < 0:
            return []
        found = json.loads(body[start:end + 1])
        return [f for f in found if isinstance(f, dict) and f.get("title")]
    except Exception as exc:
        print(f"local audit pass skipped: {exc}", file=sys.stderr)
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", choices=["daily", "weekly", "both"], default="both")
    ap.add_argument("--audit", action="store_true",
                    help="run the local-model narrative pass")
    ap.add_argument("--stdout", action="store_true")
    args = ap.parse_args()
    if not DATA_ROOT:
        print("HUMANWARE_DATA_ROOT is required", file=sys.stderr)
        return 2

    samples = load_history()
    if not samples:
        print("no samples yet; run sample-traffic.py first", file=sys.stderr)
        return 1

    span_hours = (samples[-1]["_ts"] - samples[0]["_ts"]).total_seconds() / 3600
    index = build_first_seen_index(samples)
    audit = latest_audit()

    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "host": samples[-1].get("host") or socket.gethostname(),
        "history_hours": round(span_hours, 1),
        "posture": build_posture(samples, audit),
        "audit_diff": audit_diff(audit, previous_audit(audit)),
    }

    base = audit_findings(audit)
    for label, hours, bucket in (("daily", 24, 1), ("weekly", 168, 24)):
        if args.window not in (label, "both"):
            continue
        w = build_window(samples, hours, bucket, index, span_hours)
        w["findings"] = base + (
            run_local_audit(w, data["posture"], label) if args.audit else [])
        data[label] = w

    if args.stdout:
        print(json.dumps(data, indent=2))
        return 0

    tmp = OUT + ".tmp"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, OUT)  # atomic: the page must never fetch a half-written file
    print(f"wrote {OUT} from {len(samples)} samples "
          f"({data['history_hours']}h history)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
