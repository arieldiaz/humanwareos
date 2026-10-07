#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
JQ=$(command -v jq)
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
[ -x "$RUNTIME/current/framework/scripts/runtime-restart-guard.sh" ]
[ -x "$RUNTIME/current/framework/scripts/apply-openclaw-patches.sh" ]
[ -x "$RUNTIME/current/framework/ops/openclaw/runtime/secret-exec.sh" ]
[ -x "$RUNTIME/current/framework/ops/openclaw/runtime/cursor-agent-launch.sh" ]
[ -f "$RUNTIME/current/framework/ops/openclaw/slack-spin-out.mjs" ]
[ -f "$RUNTIME/current/framework/scripts/openclaw-agent-entries.mjs" ]
[ -f "$RUNTIME/current/config/openclaw/openclaw.json" ]
[ -f "$RUNTIME/current/framework/ops/openclaw/patches/slack-plugin-root.mjs" ]
[ -f "$RUNTIME/current/framework/ops/openclaw/patches/slack-rich-text/markdown-to-rich-text.mjs" ]
[ -f "$RUNTIME/current/surface/activity/index.html" ]
[ -f "$RUNTIME/current/surface/sessions/index.html" ]
[ ! -e "$RUNTIME/current/framework/ops/openclaw/plugins/calendar" ]
[ -e "$RUNTIME/current/framework/ops/session-console" ]
[ -e "$RUNTIME/current/framework/ops/email-intake" ]
[ -f "$RUNTIME/current/framework/ops/artifacts/artifact_manager.py" ]
[ -d "$RUNTIME/current/framework/services" ]
[ ! -e "$RUNTIME/current/framework/services/agent-email/node_modules" ]
[ -f "$RUNTIME/current/surface/artifacts/artifact-shell.js" ]
[ ! -e "$RUNTIME/current/config/services" ]
[ ! -e "$RUNTIME/current/config/ops" ]
[ "$(grep -c 'fileURLToPath(import.meta.url)' "$RUNTIME/current/framework/ops/openclaw/patches/patch-2026.9.8-slack-rich-text.mjs")" -eq 1 ]
[ -f "$DATA/artifacts/manifests/data-plane.json" ]
[ -f "$DATA/operations/control/restart-freeze.json" ]
[ "$("$JQ" -r '.active' "$DATA/operations/control/restart-freeze.json")" = "true" ]
[ -d "$DATA/evidence/imports" ]
[ -f "$DATA/current/strategy/current.md" ]
[ "$(find "$DATA" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort | tr '\n' ' ')" = "artifacts current evidence generated operations working " ]
"$JQ" -e '.mutableStateIncluded == false and .dataRoot == $root' --arg root "$DATA" "$RUNTIME/current/manifest.json" >/dev/null
"$FRAMEWORK/scripts/validate-instance.sh" "$FRAMEWORK" "$INSTANCE" >/dev/null

# Local-server files retain their stable runtime paths. Legacy OpenClaw service
# wrappers and instance deployment scripts do not enter the runtime.
mkdir -p "$INSTANCE/services/runtime-fixture" "$INSTANCE/services/openclaw" "$INSTANCE/ops"
printf '%s\n' 'local server config' > "$INSTANCE/services/runtime-fixture/config"
printf '%s\n' 'must not enter the runtime' > "$INSTANCE/services/openclaw/gateway-launch.sh"
printf '%s\n' '{"enabled":true}' > "$INSTANCE/services/openclaw.json"
printf '%s\n' 'must not enter the runtime' > "$INSTANCE/ops/deploy.sh"
DEPENDENCY_OUTPUT=$("$FRAMEWORK/scripts/build-runtime.sh" "$FRAMEWORK" "$INSTANCE")
DEPENDENCY_BUILD=$(printf '%s\n' "$DEPENDENCY_OUTPUT" | sed -n 's/^build-runtime: built //p')
[ -d "$DEPENDENCY_BUILD" ]
[ -f "$DEPENDENCY_BUILD/config/services/runtime-fixture/config" ]
[ ! -e "$DEPENDENCY_BUILD/config/services/openclaw" ]
[ ! -e "$DEPENDENCY_BUILD/config/services/openclaw.json" ]
[ ! -e "$DEPENDENCY_BUILD/config/ops" ]

# Route declarations cannot make either trace feed public.
cp "$INSTANCE/surfaces/domain.json" "$TEST_ROOT/domain.json"
"$JQ" '(.routes[] | select(.id == "activity").visibility) = "public"' "$TEST_ROOT/domain.json" > "$INSTANCE/surfaces/domain.json"
if "$FRAMEWORK/scripts/validate-instance.sh" "$FRAMEWORK" "$INSTANCE" >/dev/null 2>&1; then
  printf '%s\n' "runtime-boundaries: public activity was not rejected" >&2
  exit 1
fi
cp "$TEST_ROOT/domain.json" "$INSTANCE/surfaces/domain.json"

mkdir -p "$INSTANCE/memory"
printf '%s\n' "must not be tracked" > "$INSTANCE/memory/example.md"
git -C "$INSTANCE" add memory/example.md
if "$FRAMEWORK/scripts/validate-instance.sh" "$FRAMEWORK" "$INSTANCE" >/dev/null 2>&1; then
  printf '%s\n' "runtime-boundaries: tracked data was not rejected" >&2
  exit 1
fi

printf '%s\n' "runtime-boundaries: OK"
