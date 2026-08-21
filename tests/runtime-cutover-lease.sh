#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
LEASE="$ROOT/scripts/runtime-cutover-lease.sh"
TEST_ROOT=$(mktemp -d)
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
LOCK="$TEST_ROOT/runtime-cutover"

"$LEASE" assert-external
if HUMANWARE_GATEWAY_PROCESS=1 "$LEASE" assert-external 2>/dev/null; then
  echo "gateway descendant unexpectedly received control-plane authority" >&2
  exit 1
fi

"$LEASE" acquire "$LOCK" "$$" test-owner
test "$(cat "$LOCK/pid")" = "$$"
test "$(cat "$LOCK/label")" = "test-owner"
if "$LEASE" acquire "$LOCK" "$$" duplicate 2>/dev/null; then
  echo "second active lease unexpectedly succeeded" >&2
  exit 1
fi
"$LEASE" release "$LOCK" "$$"
test ! -e "$LOCK"

mkdir "$LOCK"
printf '%s\n' 99999999 > "$LOCK/pid"
"$LEASE" acquire "$LOCK" "$$" recovered-owner
test "$(cat "$LOCK/pid")" = "$$"
test -n "$(find "$TEST_ROOT" -maxdepth 1 -type d -name 'runtime-cutover.stale-*' -print -quit)"
"$LEASE" release "$LOCK" "$$"

echo "runtime cutover lease: OK"
