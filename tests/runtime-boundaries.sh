#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/humanware-runtime-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

FRAMEWORK="$TEST_ROOT/framework"
INSTANCE="$TEST_ROOT/instance"
DATA="$TEST_ROOT/data"
RUNTIME="$TEST_ROOT/runtime"
WORKTREES="$TEST_ROOT/worktrees"

mkdir -p "$FRAMEWORK"
rsync -a --exclude=.git "$ROOT/" "$FRAMEWORK/"
git -C "$FRAMEWORK" init -b main >/dev/null
git -C "$FRAMEWORK" config user.name "Humanware Test"
git -C "$FRAMEWORK" config user.email "test@humanware.invalid"
git -C "$FRAMEWORK" add .
git -C "$FRAMEWORK" commit -m "test framework" >/dev/null

"$FRAMEWORK/install.sh" "$INSTANCE" \
  --framework-dir "$FRAMEWORK" \
  --data-root "$DATA" \
  --runtime-root "$RUNTIME" \
  --worktree-root "$WORKTREES" \
  --instance-id test-instance \
  --name "Test Instance" >/dev/null

[ -L "$RUNTIME/current" ]
[ -f "$RUNTIME/current/manifest.json" ]
[ -x "$RUNTIME/current/framework/scripts/runtime-cutover-lease.sh" ]
[ -f "$DATA/manifests/data-plane.json" ]
[ -d "$DATA/imports" ]
/usr/bin/jq -e '.mutableStateIncluded == false and .dataRoot == $root' --arg root "$DATA" "$RUNTIME/current/manifest.json" >/dev/null
"$FRAMEWORK/scripts/validate-instance.sh" "$FRAMEWORK" "$INSTANCE" >/dev/null

mkdir -p "$INSTANCE/memory"
printf '%s\n' "must not be tracked" > "$INSTANCE/memory/example.md"
git -C "$INSTANCE" add memory/example.md
if "$FRAMEWORK/scripts/validate-instance.sh" "$FRAMEWORK" "$INSTANCE" >/dev/null 2>&1; then
  printf '%s\n' "runtime-boundaries: tracked data was not rejected" >&2
  exit 1
fi

printf '%s\n' "runtime-boundaries: OK"
