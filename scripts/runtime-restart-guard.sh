#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 verify|consume CONTROL_DIR APPROVAL_FILE INSTANCE_ID ACTIVE_SESSION_COUNT [REPORT_FILE]" >&2
  exit 2
}

JQ=${JQ:-}
if [ -z "$JQ" ]; then
  JQ=$(command -v jq 2>/dev/null) || { echo "Restart approval refused: jq is required" >&2; exit 2; }
fi

fail() {
  echo "Restart approval refused: $1" >&2
  exit "${2:-77}"
}

[ "$#" -ge 5 ] && [ "$#" -le 6 ] || usage
ACTION=$1
CONTROL_DIR=$2
APPROVAL_FILE=$3
INSTANCE_ID=$4
ACTIVE_SESSION_COUNT=$5
REPORT_FILE=${6:-}

case "$ACTION" in
  verify) [ "$#" -eq 5 ] || usage ;;
  consume) [ "$#" -eq 6 ] || usage ;;
  *) usage ;;
esac

case "$CONTROL_DIR" in
  /*) ;;
  *) fail "control directory must be absolute" ;;
esac
case "$APPROVAL_FILE" in
  /*) ;;
  *) fail "approval file must be absolute" ;;
esac
case "$ACTIVE_SESSION_COUNT" in
  ''|*[!0-9]*) fail "active session count must be a non-negative integer" ;;
esac

[ -d "$CONTROL_DIR" ] || fail "control directory is missing: $CONTROL_DIR" 78
[ ! -L "$CONTROL_DIR" ] || fail "control directory cannot be a symlink: $CONTROL_DIR" 78
FREEZE_FILE="$CONTROL_DIR/restart-freeze.json"
PENDING_DIR="$CONTROL_DIR/restart-approvals/pending"
CONSUMED_DIR="$CONTROL_DIR/restart-approvals/consumed"
[ -f "$FREEZE_FILE" ] || fail "shared freeze state is missing: $FREEZE_FILE" 78
[ ! -L "$FREEZE_FILE" ] || fail "shared freeze state cannot be a symlink" 78
[ -d "$PENDING_DIR" ] || fail "pending approval directory is missing: $PENDING_DIR"
[ ! -L "$PENDING_DIR" ] || fail "pending approval directory cannot be a symlink"

if ! "$JQ" -e '.schemaVersion == 1 and (.active | type == "boolean") and (.updatedBy | type == "string") and (.reason | type == "string")' "$FREEZE_FILE" >/dev/null; then
  fail "shared freeze state is invalid: $FREEZE_FILE" 78
fi
if [ "$("$JQ" -r '.active' "$FREEZE_FILE")" = "true" ]; then
  reason=$("$JQ" -r '.reason' "$FREEZE_FILE")
  fail "the shared restart freeze is active: $reason" 78
fi

[ -f "$APPROVAL_FILE" ] || fail "approval file is missing: $APPROVAL_FILE"
[ ! -L "$APPROVAL_FILE" ] || fail "approval file cannot be a symlink"
approval_dir=$(CDPATH= cd -- "$(dirname "$APPROVAL_FILE")" && pwd -P)
pending_dir=$(CDPATH= cd -- "$PENDING_DIR" && pwd -P)
[ "$approval_dir" = "$pending_dir" ] || fail "approval must be inside $PENDING_DIR"

owner=$(/usr/bin/stat -f '%u' "$APPROVAL_FILE")
[ "$owner" = "$(/usr/bin/id -u)" ] || fail "approval file must be owned by the invoking operator"
mode=$(/usr/bin/stat -f '%Lp' "$APPROVAL_FILE")
if (( (8#$mode & 077) != 0 )); then
  fail "approval file permissions must not grant group or other access"
fi

now=$(/bin/date -u +%s)
if ! "$JQ" -e --arg instance "$INSTANCE_ID" --argjson now "$now" '
  .schemaVersion == 1 and
  (.approvalId | type == "string" and length > 0) and
  .decision == "approve" and
  .action == "gateway-restart" and
  .instanceId == $instance and
  (.approvedBy | type == "string" and length > 0) and
  (.reason | type == "string" and length > 0) and
  (.allowActiveSessions | type == "boolean") and
  (.provenance.initiatingSession | type == "string" and length > 0) and
  (.provenance.initiatingThread | type == "string" and length > 0) and
  (.provenance.pullRequest | type == "string" and length > 0) and
  ((.approvedAt | fromdateiso8601) <= ($now + 60)) and
  ((.expiresAt | fromdateiso8601) > $now) and
  (((.expiresAt | fromdateiso8601) - (.approvedAt | fromdateiso8601)) <= 1800)
' "$APPROVAL_FILE" >/dev/null; then
  fail "approval is invalid, expired, too broad, or for another instance"
fi

approval_id=$("$JQ" -r '.approvalId' "$APPROVAL_FILE")
case "$approval_id" in
  *[!A-Za-z0-9._-]*|'') fail "approvalId contains unsupported characters" ;;
esac
[ "$(basename "$APPROVAL_FILE")" = "$approval_id.json" ] || fail "approval filename must match approvalId"

if [ "$ACTIVE_SESSION_COUNT" -gt 0 ] && [ "$("$JQ" -r '.allowActiveSessions' "$APPROVAL_FILE")" != "true" ]; then
  fail "$ACTIVE_SESSION_COUNT active session(s) must drain, or the operator must explicitly approve the active-session override" 79
fi

if [ "$ACTION" = "verify" ]; then
  printf 'restart approval verified: %s\n' "$approval_id"
  exit 0
fi

case "$REPORT_FILE" in
  /*) ;;
  *) fail "report file must be absolute" ;;
esac
[ -d "$(dirname "$REPORT_FILE")" ] || fail "report directory is missing: $(dirname "$REPORT_FILE")"
/bin/mkdir -p "$CONSUMED_DIR"
/bin/chmod 700 "$CONSUMED_DIR"
consumed_at=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)
stamp=$(/bin/date -u +%Y%m%dT%H%M%SZ)
CONSUMED_FILE="$CONSUMED_DIR/$approval_id-$stamp.json"
[ ! -e "$CONSUMED_FILE" ] || fail "consumed approval destination already exists"
/bin/mv "$APPROVAL_FILE" "$CONSUMED_FILE"
"$JQ" --arg consumedAt "$consumed_at" --argjson activeSessionCount "$ACTIVE_SESSION_COUNT" \
  '. + {consumedAt: $consumedAt, activeSessionCount: $activeSessionCount}' "$CONSUMED_FILE" > "$REPORT_FILE.tmp"
/bin/chmod 600 "$REPORT_FILE.tmp"
/bin/mv "$REPORT_FILE.tmp" "$REPORT_FILE"
printf '%s\n' "$CONSUMED_FILE"
