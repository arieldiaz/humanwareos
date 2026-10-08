#!/usr/bin/env python3
"""Read-only macOS host security audit with stable, diffable JSON output."""

from __future__ import annotations

import json
import os
import platform
import plistlib
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
OUTPUT_DIR = Path(os.environ.get(
    "HUMANWARE_SECURITY_AUDIT_DIR",
    HOME / "Library/Logs/humanware-security",
))
EXPECTED_PUBLIC = {
    ("caddy", "80"),
    ("caddy", "443"),
}


def run(argv: list[str], timeout: int = 30) -> tuple[int, str]:
    try:
        result = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
        return result.returncode, (result.stdout + result.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)


def node_processes() -> list[dict]:
    code, text = run(["/usr/bin/pgrep", "-x", "node"])
    if code != 0:
        return []
    rows = []
    for value in text.split():
        pid = value.strip()
        _, ps = run([
            "/bin/ps", "-ww", "-o", "pid=,ppid=,comm=", "-p", pid
        ])
        _, files = run([
            "/usr/sbin/lsof", "-a", "-p", pid, "-d", "txt,cwd", "-Fn"
        ])
        paths = [
            line[1:] for line in files.splitlines()
            if line.startswith("n") and line[1:].startswith("/")
        ]
        rows.append({
            "pid": int(pid),
            "process": " ".join(ps.split()),
            "paths": sorted(set(paths)),
        })
    return rows


def listeners() -> list[dict]:
    _, text = run(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"])
    rows = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 9:
            continue
        endpoint = parts[-2] if parts[-1] == "(LISTEN)" else parts[-1]
        match = re.search(r":(\d+)$", endpoint)
        port = match.group(1) if match else "unknown"
        public = endpoint.startswith("*:") or endpoint.startswith("[::]:")
        rows.append({
            "process": parts[0],
            "pid": int(parts[1]),
            "endpoint": endpoint,
            "public_bind": public,
            "expected_public": (parts[0], port) in EXPECTED_PUBLIC,
        })
    return rows


def launch_items() -> list[dict]:
    roots = [
        HOME / "Library/LaunchAgents",
        Path("/Library/LaunchAgents"),
        Path("/Library/LaunchDaemons"),
    ]
    rows = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.glob("*.plist")):
            try:
                with path.open("rb") as handle:
                    data = plistlib.load(handle)
            except (OSError, plistlib.InvalidFileException):
                continue
            args = data.get("ProgramArguments") or []
            program = data.get("Program") or (args[0] if args else None)
            rows.append({
                "label": data.get("Label"),
                "path": str(path),
                "program": program,
                "run_at_load": bool(data.get("RunAtLoad")),
                "keep_alive": bool(data.get("KeepAlive")),
            })
    return rows


def posture() -> dict:
    checks = {
        "firewall": ["/usr/libexec/ApplicationFirewall/socketfilterfw",
                     "--getglobalstate"],
        "stealth_mode": ["/usr/libexec/ApplicationFirewall/socketfilterfw",
                         "--getstealthmode"],
        "filevault": ["/usr/bin/fdesetup", "status"],
        "updates": ["/usr/sbin/softwareupdate", "--schedule"],
        "backup": ["/usr/bin/tmutil", "status"],
    }
    return {name: run(argv)[1] for name, argv in checks.items()}


def main() -> int:
    audit = {
        "schema": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": platform.node(),
        "os": platform.platform(),
        "posture": posture(),
        "node_processes": node_processes(),
        "listeners": listeners(),
        "launch_items": launch_items(),
    }
    findings = []
    if "disabled" in audit["posture"]["firewall"].lower():
        findings.append({"severity": "critical", "id": "firewall-disabled"})
    if "off" in audit["posture"]["filevault"].lower():
        findings.append({"severity": "critical", "id": "filevault-off"})
    for item in audit["listeners"]:
        if item["public_bind"] and not item["expected_public"]:
            findings.append({
                "severity": "high",
                "id": "unexpected-public-listener",
                "evidence": item,
            })
    audit["findings"] = findings
    audit["summary"] = {
        "critical": sum(f["severity"] == "critical" for f in findings),
        "high": sum(f["severity"] == "high" for f in findings),
    }

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    report = OUTPUT_DIR / f"host-audit-{stamp}.json"
    latest = OUTPUT_DIR / "latest.json"
    payload = json.dumps(audit, indent=2, sort_keys=True) + "\n"
    report.write_text(payload)
    latest.write_text(payload)
    print(json.dumps({
        "report": str(report),
        "summary": audit["summary"],
        "finding_count": len(findings),
    }))
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
