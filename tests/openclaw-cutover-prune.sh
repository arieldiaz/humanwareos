#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CUTOVER="$ROOT/scripts/openclaw-cutover.sh"
TEST_ROOT=$(mktemp -d)
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
RUNTIME_ROOT="$TEST_ROOT/runtime-root"
DATA="$TEST_ROOT/data"
PENDING="$DATA/operations/control/restart-approvals/pending"
mkdir -p "$RUNTIME_ROOT/runtime" "$DATA/operations/cutovers" "$PENDING"
for i in 1 2 3 4 5 6; do
  mkdir -p "$RUNTIME_ROOT/runtime/2026100${i}T000000Z-build" "$DATA/operations/cutovers/openclaw-2026100${i}T000000Z-build"
done
mkdir -p "$DATA/operations/cutovers/unrelated"
ln -s "$RUNTIME_ROOT/runtime/20261002T000000Z-build" "$RUNTIME_ROOT/current"
printf '{}\n' > "$PENDING/fresh.json"
printf '{}\n' > "$PENDING/expired.json"
touch -t 202601010000 "$PENDING/expired.json"

"$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3

test "$(ls "$RUNTIME_ROOT/runtime" | sort | tr '\n' ' ')" = "20261002T000000Z-build 20261004T000000Z-build 20261005T000000Z-build 20261006T000000Z-build "
test "$(ls "$DATA/operations/cutovers" | sort | tr '\n' ' ')" = "openclaw-20261004T000000Z-build openclaw-20261005T000000Z-build openclaw-20261006T000000Z-build unrelated "
test -f "$PENDING/fresh.json"
test ! -e "$PENDING/expired.json"
test -L "$RUNTIME_ROOT/current"

echo "openclaw cutover prune: OK"
