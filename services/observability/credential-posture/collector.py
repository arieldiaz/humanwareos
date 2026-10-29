#!/usr/bin/env python3
"""Build a metadata-only credential and spending-control posture snapshot."""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone


PROVIDER_SECRET_NAMES = {
    "OPENAI_API_KEY": "openai",
    "ANTHROPIC_API_KEY": "anthropic",
    "OPENROUTER_API_KEY": "openrouter",
    "GEMINI_API_KEY": "gemini",
    "GOOGLE_API_KEY": "gemini",
    "XAI_API_KEY": "xai",
}
RESERVED_DOPPLER_NAMES = {"DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"}
ALLOWED_BUDGET_KINDS = {"hard_cap", "prepaid", "alert_only", "none", "unknown"}
ALLOWED_STATUSES = {"active", "rotating", "disabled", "retired", "unknown"}
DEFAULT_STALE_HOURS = 26
DEFAULT_BUDGET_REVIEW_DAYS = 31


def utcnow():
    return datetime.now(timezone.utc)


def parse_time(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def load_json(path, required=True):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError) as error:
        if required:
            raise RuntimeError(f"cannot read {path}: {error}") from error
        return None


def validate_config(config):
    if config.get("schemaVersion") != 1:
        raise RuntimeError("config schemaVersion must be 1")
    if not isinstance(config.get("doppler", {}).get("scopes"), list):
        raise RuntimeError("config doppler.scopes must be a list")
    for check in config.get("checks", []):
        missing = [key for key in ("id", "provider", "credentialEnv") if not check.get(key)]
        if missing:
            raise RuntimeError(f"provider check is missing {', '.join(missing)}")
        if check["provider"] not in {"openai", "anthropic", "openrouter", "gemini", "xai"}:
            raise RuntimeError(f"unsupported provider {check['provider']}")


def validate_register(register):
    if register.get("schemaVersion") != 1:
        raise RuntimeError("register schemaVersion must be 1")
    entries = register.get("credentials")
    if not isinstance(entries, list):
        raise RuntimeError("register credentials must be a list")
    ids = set()
    for entry in entries:
        missing = [key for key in ("id", "provider", "doppler", "status") if not entry.get(key)]
        if missing:
            raise RuntimeError(f"register entry is missing {', '.join(missing)}")
        if entry["id"] in ids:
            raise RuntimeError(f"duplicate register id {entry['id']}")
        ids.add(entry["id"])
        locator = entry["doppler"]
        if any(not locator.get(key) for key in ("project", "config", "secret")):
            raise RuntimeError(f"register entry {entry['id']} has an incomplete Doppler locator")
        if entry["status"] not in ALLOWED_STATUSES:
            raise RuntimeError(f"register entry {entry['id']} has invalid status")
        budget = entry.get("budget", {"kind": "unknown"})
        if budget.get("kind", "unknown") not in ALLOWED_BUDGET_KINDS:
            raise RuntimeError(f"register entry {entry['id']} has invalid budget kind")
        for field in ("amountUsd", "autoRechargeMonthlyMaxUsd"):
            if field in budget and not isinstance(budget[field], (int, float)):
                raise RuntimeError(f"register entry {entry['id']} has invalid {field}")


def locator_key(locator):
    return (locator.get("project"), locator.get("config"), locator.get("secret"))


def budget_is_bounded(budget):
    """A label alone is not a boundary: require a finite amount.

    Prepaid credit is bounded only when automatic recharge is explicitly off or
    itself has a finite monthly maximum.
    """
    if budget.get("kind") == "hard_cap":
        return budget.get("amountUsd") is not None
    if budget.get("kind") == "prepaid":
        return budget.get("amountUsd") is not None and (
            budget.get("autoRecharge") is False
            or budget.get("autoRechargeMonthlyMaxUsd") is not None)
    return False


def discover_doppler(config, runner=subprocess.run):
    doppler = config["doppler"]
    binary = doppler.get("bin", "doppler")
    discoveries, sources = [], []
    for scope in doppler.get("scopes", []):
        project = scope.get("project")
        for name in scope.get("configs", []):
            source = {"project": project, "config": name, "state": "unavailable"}
            try:
                completed = runner(
                    [binary, "secrets", "--project", project, "--config", name,
                     "--only-names", "--json", "--silent", "--no-check-version"],
                    capture_output=True, text=True, timeout=30)
                if completed.returncode != 0:
                    source["error"] = f"Doppler exited {completed.returncode}"
                else:
                    payload = json.loads(completed.stdout)
                    names = payload.keys() if isinstance(payload, dict) else payload
                    for secret in sorted(set(names) - RESERVED_DOPPLER_NAMES):
                        provider = PROVIDER_SECRET_NAMES.get(secret)
                        if provider:
                            discoveries.append({
                                "provider": provider,
                                "doppler": {"project": project, "config": name, "secret": secret},
                            })
                    source.update({"state": "current", "credentialNames": sum(
                        1 for secret in names if secret in PROVIDER_SECRET_NAMES)})
                    source.pop("error", None)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                source["error"] = type(error).__name__
            sources.append(source)
    return discoveries, sources


def request_json(url, headers, timeout=15, opener=urllib.request.urlopen):
    request = urllib.request.Request(url, headers=headers)
    try:
        with opener(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def check_provider(check, environ=os.environ, opener=urllib.request.urlopen):
    provider = check["provider"]
    credential = environ.get(check["credentialEnv"])
    base = {"id": check["id"], "provider": provider, "state": "not_configured"}
    if not credential:
        return base

    headers = {"User-Agent": "humanware-credential-posture/1"}
    if provider == "openai":
        url = "https://api.openai.com/v1/models"
        headers["Authorization"] = f"Bearer {credential}"
    elif provider == "anthropic":
        url = "https://api.anthropic.com/v1/models?limit=1"
        headers.update({"x-api-key": credential, "anthropic-version": "2023-06-01"})
    elif provider == "openrouter":
        url = "https://openrouter.ai/api/v1/key"
        headers["Authorization"] = f"Bearer {credential}"
    elif provider == "gemini":
        url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
        headers["x-goog-api-key"] = credential
    elif provider == "xai":
        url = "https://api.x.ai/v1/models"
        headers["Authorization"] = f"Bearer {credential}"
    else:
        return base

    try:
        status, payload = request_json(url, headers, opener=opener)
    except (OSError, ValueError, urllib.error.URLError):
        return {**base, "state": "unavailable"}
    if status in (401, 403):
        return {**base, "state": "auth_failed", "httpStatus": status}
    if status < 200 or status >= 300:
        return {**base, "state": "unavailable", "httpStatus": status}

    result = {**base, "state": "verified", "httpStatus": status}
    if provider == "openrouter" and isinstance(payload, dict):
        data = payload.get("data") or {}
        result["usage"] = {
            key: data.get(key) for key in
            ("usage", "usage_daily", "usage_weekly", "usage_monthly")
            if data.get(key) is not None
        }
        if data.get("limit") is not None:
            result["budget"] = {
                "kind": "hard_cap",
                "amountUsd": data.get("limit"),
                "remainingUsd": data.get("limit_remaining"),
                "reset": data.get("limit_reset"),
                "source": "provider-api",
            }
    return result


def finding(severity, code, title, detail, credential_id=None, action=None):
    row = {"severity": severity, "code": code, "title": title, "detail": detail}
    if credential_id:
        row["credentialId"] = credential_id
    if action:
        row["action"] = action
    return row


def build_snapshot(config, register, discoveries, doppler_sources, checks, now=None):
    now = now or utcnow()
    entries = register.get("credentials", [])
    registered = {locator_key(entry["doppler"]): entry for entry in entries}
    discovered = {locator_key(item["doppler"]): item for item in discoveries}
    check_by_id = {item["id"]: item for item in checks}
    current_scopes = {
        (source.get("project"), source.get("config"))
        for source in doppler_sources if source.get("state") == "current"
    }
    findings, credentials = [], []

    locator_counts = Counter(locator_key(entry["doppler"]) for entry in entries)
    for key, count in locator_counts.items():
        if count > 1:
            findings.append(finding(
                "high", "duplicate-locator", "One secret is registered more than once",
                f"{key[0]}/{key[1]}/{key[2]} appears in {count} register entries.",
                action="Keep one stable credential record for this Doppler locator."))

    for key, item in discovered.items():
        entry = registered.get(key)
        if not entry:
            synthetic_id = "/".join(key)
            credentials.append({
                "id": synthetic_id, "provider": item["provider"], "doppler": item["doppler"],
                "status": "unregistered", "validation": "not_configured",
                "budget": {"kind": "unknown"},
            })
            findings.append(finding(
                "high", "unregistered-credential", "Provider credential is not registered",
                f"{key[0]}/{key[1]}/{key[2]} exists in Doppler without an owner or spending-control record.",
                synthetic_id, "Identify its consumer and confirm its provider-side cap."))

    for entry in entries:
        key = locator_key(entry["doppler"])
        check = check_by_id.get(entry["id"], {"state": "not_configured"})
        budget = dict(entry.get("budget") or {"kind": "unknown"})
        observed_budget = check.get("budget")
        row = {
            "id": entry["id"], "provider": entry["provider"], "doppler": entry["doppler"],
            "consumer": entry.get("consumer"), "environment": entry.get("environment"),
            "owner": entry.get("owner"), "status": entry["status"],
            "validation": check.get("state", "not_configured"), "budget": budget,
        }
        if check.get("usage"):
            row["usage"] = check["usage"]
        if observed_budget:
            row["observedBudget"] = observed_budget
        credentials.append(row)

        if entry["status"] in {"disabled", "retired"}:
            continue
        if key not in discovered and key[:2] in current_scopes:
            findings.append(finding(
                "high", "missing-secret", "Registered credential is absent from Doppler",
                f"{entry['id']} points to a secret name that was not discovered.",
                entry["id"], "Confirm whether the credential was removed or the scope failed."))
        if not entry.get("consumer") or not entry.get("owner"):
            findings.append(finding(
                "medium", "missing-ownership", "Credential ownership is incomplete",
                f"{entry['id']} needs both a named consumer and owner.", entry["id"],
                "Record the workload and accountable owner."))
        if not budget_is_bounded(budget):
            findings.append(finding(
                "high", "unbounded-spend", "No enforced spending boundary is confirmed",
                f"{entry['id']} records budget kind {budget.get('kind', 'unknown')} without a finite confirmed boundary.",
                entry["id"], "Confirm a hard cap or prepaid boundary in the provider console."))
        confirmed = parse_time(budget.get("confirmedAt"))
        if confirmed and (now - confirmed).days > config.get("budgetReviewDays", DEFAULT_BUDGET_REVIEW_DAYS):
            findings.append(finding(
                "medium", "stale-budget-confirmation", "Budget confirmation is stale",
                f"{entry['id']} was last confirmed {budget['confirmedAt']}.", entry["id"],
                "Recheck the provider control and update confirmedAt."))
        state = check.get("state", "not_configured")
        if state == "auth_failed":
            findings.append(finding(
                "high", "provider-auth-failed", "Provider rejected the credential",
                f"The non-billable {entry['provider']} metadata check returned {check.get('httpStatus')}.",
                entry["id"], "Verify or rotate the credential through its consuming workload."))
        elif state in {"not_configured", "unavailable"}:
            findings.append(finding(
                "medium", "provider-unverified", "Provider verification is unavailable",
                f"{entry['id']} has validation state {state}.", entry["id"],
                "Configure a read-only metadata check or confirm it manually."))
        if observed_budget and budget.get("amountUsd") is not None:
            if float(observed_budget["amountUsd"]) != float(budget["amountUsd"]):
                findings.append(finding(
                    "high", "budget-drift", "Observed provider limit differs from the register",
                    f"{entry['id']} records ${budget['amountUsd']} but the provider reports ${observed_budget['amountUsd']}.",
                    entry["id"], "Reconcile the provider limit and canonical register."))

    for source in doppler_sources:
        if source["state"] != "current":
            findings.append(finding(
                "medium", "doppler-scope-unavailable", "A Doppler scope could not be inventoried",
                f"{source['project']}/{source['config']} is unavailable ({source.get('error', 'unknown error')}).",
                action="Restore read access and rerun the collector."))

    severity = Counter(item["severity"] for item in findings)
    status = "critical" if severity["high"] else "attention" if severity["medium"] else "healthy"
    summary = {
        "status": status,
        "discovered": len(discovered),
        "registered": len(entries),
        "unregistered": sum(1 for row in credentials if row["status"] == "unregistered"),
        "verified": sum(1 for row in credentials if row.get("validation") == "verified"),
        "bounded": sum(1 for row in credentials if budget_is_bounded(row.get("budget", {}))),
        "highFindings": severity["high"],
        "mediumFindings": severity["medium"],
    }
    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat(),
        "staleAfterHours": config.get("staleAfterHours", DEFAULT_STALE_HOURS),
        "summary": summary,
        "sources": {
            "register": {"state": "current", "updatedAt": register.get("updatedAt")},
            "doppler": doppler_sources,
            "providers": checks,
        },
        "credentials": sorted(credentials, key=lambda row: (row["provider"], row["id"])),
        "findings": findings,
    }


def atomic_write(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--register")
    parser.add_argument("--output")
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()

    data_root = os.environ.get("HUMANWARE_DATA_ROOT")
    if not data_root:
        print("credential-posture: HUMANWARE_DATA_ROOT is required", file=sys.stderr)
        return 2
    register_path = args.register or os.path.join(
        data_root, "working", "security", "api-credential-audit", "register.json")
    output = args.output or os.path.join(
        data_root, "generated", "reports", "security", "credentials-current.json")
    try:
        config = load_json(args.config)
        validate_config(config)
        register = load_json(register_path)
        validate_register(register)
        discoveries, sources = discover_doppler(config)
        checks = [check_provider(check) for check in config.get("checks", [])]
        snapshot = build_snapshot(config, register, discoveries, sources, checks)
    except RuntimeError as error:
        print(f"credential-posture: {error}", file=sys.stderr)
        return 2

    if args.stdout:
        print(json.dumps(snapshot, indent=2))
    else:
        atomic_write(output, snapshot)
        print(f"credential-posture: wrote {output} ({snapshot['summary']['status']})")
    # Findings are observed posture, not collector failure. The scheduled job
    # succeeds when it produced a complete atomic snapshot; the dashboard owns
    # the critical/attention state.
    return 0


if __name__ == "__main__":
    sys.exit(main())
