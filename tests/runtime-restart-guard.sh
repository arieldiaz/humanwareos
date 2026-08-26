#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
GUARD="$ROOT/scripts/runtime-restart-guard.sh"
JQ=$(command -v jq)
TEST_ROOT=$(mktemp -d)
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
CONTROL="$TEST_ROOT/control"
PENDING="$CONTROL/restart-approvals/pending"
REPORT="$TEST_ROOT/restart-approval.json"
mkdir -p "$PENDING"
cp "$ROOT/templates/data/operations/control/restart-freeze.json" "$CONTROL/restart-freeze.json"
chmod 600 "$CONTROL/restart-freeze.json"

write_approval() {
  id=$1
  allow_active=$2
  approved_at=$(/bin/date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)
  expires_at=$(/bin/date -u -v+10M +%Y-%m-%dT%H:%M:%SZ)
  "$JQ" -n \
    --arg id "$id" \
    --arg approvedAt "$approved_at" \
    --arg expiresAt "$expires_at" \
    --argjson allowActive "$allow_active" \
    '{schemaVersion: 1, approvalId: $id, decision: "approve", action: "gateway-restart", instanceId: "test-instance", approvedBy: "Test Operator", approvedAt: $approvedAt, expiresAt: $expiresAt, reason: "test cutover", allowActiveSessions: $allowActive, provenance: {initiatingSession: "test-session", initiatingThread: "test-thread", pullRequest: "https://example.invalid/pull/1"}}' > "$PENDING/$id.json"
  chmod 600 "$PENDING/$id.json"
}

write_approval frozen false
if "$GUARD" verify "$CONTROL" "$PENDING/frozen.json" test-instance 0 2>/dev/null; then
  echo "active restart freeze unexpectedly allowed an approval" >&2
  exit 1
fi
"$JQ" '.active = false | .updatedAt = "2026-08-26T18:00:00Z" | .updatedBy = "Test Operator" | .reason = "test window"' "$CONTROL/restart-freeze.json" > "$CONTROL/restart-freeze.json.tmp"
mv "$CONTROL/restart-freeze.json.tmp" "$CONTROL/restart-freeze.json"
chmod 600 "$CONTROL/restart-freeze.json"

"$GUARD" verify "$CONTROL" "$PENDING/frozen.json" test-instance 0 >/dev/null
if "$GUARD" verify "$CONTROL" "$PENDING/frozen.json" test-instance 1 2>/dev/null; then
  echo "active session unexpectedly passed without an override" >&2
  exit 1
fi

write_approval override true
consumed=$("$GUARD" consume "$CONTROL" "$PENDING/override.json" test-instance 2 "$REPORT")
test -f "$consumed"
test ! -e "$PENDING/override.json"
"$JQ" -e '.approvalId == "override" and .activeSessionCount == 2 and (.consumedAt | type == "string") and .provenance.initiatingSession == "test-session" and .provenance.initiatingThread == "test-thread" and .provenance.pullRequest == "https://example.invalid/pull/1"' "$REPORT" >/dev/null
if "$GUARD" verify "$CONTROL" "$PENDING/override.json" test-instance 0 2>/dev/null; then
  echo "consumed approval unexpectedly remained reusable" >&2
  exit 1
fi

echo "runtime restart guard: OK"
