#!/bin/bash
# Builds the service app ad hoc in a temp folder and exercises its launcher for real.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD="$ROOT/surfaces/macos/service-app/build.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/humanware-service-app.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Test Services.app"
LAUNCHER="$APP/Contents/MacOS/Test Services"

fail() { printf 'service-app: %s\n' "$*" >&2; exit 1; }
status_of() { set +e; "$@" >/dev/null 2>&1; local status=$?; set -e; printf '%s' "$status"; }

# Bundle: identity, name, launcher, strict signature, hardened runtime.
"$BUILD" "Test Services" org.example.services - "$APP" >/dev/null 2>&1
codesign --verify --strict "$APP"
[ "$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" = org.example.services ] || fail "bundle identifier"
[ "$(plutil -extract CFBundleName raw -o - "$APP/Contents/Info.plist")" = "Test Services" ] || fail "bundle name"
[ -x "$LAUNCHER" ] || fail "launcher missing"
signature=$(codesign -dv "$APP" 2>&1)
[[ "$signature" == *"flags="*"runtime"* ]] || fail "hardened runtime off"

# An unchanged rebuild leaves the bundle alone; a changed input rebuilds it.
before=$(codesign -dv "$APP" 2>&1)
[[ "$("$BUILD" "Test Services" org.example.services - "$APP")" == *"up to date"* ]] || fail "unchanged rebuild was not skipped"
[ "$(codesign -dv "$APP" 2>&1)" = "$before" ] || fail "unchanged rebuild changed the signature"
[[ "$("$BUILD" "Test Services" org.example.other - "$APP" 2>/dev/null)" == *"built"* ]] || fail "changed input did not rebuild"
[ "$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" = org.example.other ] || fail "rebuild kept old identifier"
[ "$(status_of "$BUILD" "Test Services" org.example.services "" "$APP")" -ne 0 ] || fail "missing identity was accepted"
[ -z "$(find "$WORK" -maxdepth 1 -name '.*.build.*')" ] || fail "build left scratch beside the output"

# Launcher: exit status, signal death, usage and a missing command.
[ "$(status_of "$LAUNCHER" run t -- /usr/bin/true)" -eq 0 ] || fail "exit 0"
[ "$(status_of "$LAUNCHER" run t -- /bin/sh -c 'exit 7')" -eq 7 ] || fail "exit 7"
[ "$(status_of "$LAUNCHER" run t -- /bin/sh -c 'kill -KILL $$')" -eq 137 ] || fail "SIGKILL is not 128+9"
[ "$(status_of "$LAUNCHER")" -eq 64 ] || fail "usage"
[ "$(status_of "$LAUNCHER" run t /usr/bin/true)" -eq 64 ] || fail "missing -- accepted"
set +e
"$LAUNCHER" run web -- "$WORK/no such command" 2>"$WORK/missing.err"
missing=$?
set -e
[ "$missing" -ne 0 ] || fail "missing command exited 0"
grep -q 'service web: cannot start .*no such command' "$WORK/missing.err" || fail "unclear missing-command message: $(cat "$WORK/missing.err")"

# Arguments with spaces and empty arguments pass through intact.
"$LAUNCHER" run t -- /bin/sh -c 'for a in "$@"; do printf "[%s]\n" "$a"; done' sh "a b" "  c  " "" > "$WORK/args"
[ "$(cat "$WORK/args")" = "$(printf '[a b]\n[  c  ]\n[]')" ] || fail "arguments changed: $(cat "$WORK/args")"

# SIGTERM to the launcher reaches the child, and the launcher exits only after
# the child has finished a slow clean shutdown, with the child's status.
"$LAUNCHER" run t -- /bin/sh -c 'trap "sleep 1; echo clean > \"$1/cleaned\"; exit 3" TERM; echo ready > "$1/ready"; while :; do sleep 0.1; done' sh "$WORK" &
pid=$!
for _ in $(seq 50); do [ -f "$WORK/ready" ] && break; sleep 0.1; done
[ -f "$WORK/ready" ] || fail "child did not start"
kill -TERM "$pid"
set +e
wait "$pid"
term=$?
set -e
[ -f "$WORK/cleaned" ] || fail "launcher exited before the child finished shutting down"
[ "$term" -eq 3 ] || fail "SIGTERM exit status $term, expected the child's 3"

printf '%s\n' "service-app: OK"
