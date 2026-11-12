#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CUTOVER="$ROOT/scripts/openclaw-cutover.sh"
TEST_ROOT=$(mktemp -d)
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
OLD="$TEST_ROOT/old"
NEW="$TEST_ROOT/new"
RUNNING="$TEST_ROOT/running"
KICKED="$TEST_ROOT/kicked"
mkdir -p "$RUNNING"
: > "$KICKED"

# service NAME KEEPALIVE: one launchd definition, a config file, and a code file in both builds.
service() {
  local build keepalive=""
  [ "$2" != keepalive ] || keepalive='<key>KeepAlive</key><true/>'
  for build in "$OLD" "$NEW"; do
    mkdir -p "$build/config/services/$1" "$build/framework/services/$1"
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>test.%s</string>%s</dict></plist>\n' "$1" "$keepalive" > "$build/config/services/$1/test.$1.plist"
    echo config > "$build/config/services/$1/config.json"
    echo code > "$build/framework/services/$1/server.mjs"
  done
}
# running NAME [PROGRAM]: launchd reports the service loaded with a process.
running() { printf '\tprogram = %s\n\tpid = 42\n' "${2:-/bin/sh}" > "$RUNNING/test.$1"; }

service code-changed keepalive; running code-changed
echo changed > "$NEW/framework/services/code-changed/server.mjs"
service config-changed keepalive; running config-changed
echo changed > "$NEW/config/services/config-changed/config.json"
service unchanged keepalive; running unchanged
service scheduled job; running scheduled
echo changed > "$NEW/framework/services/scheduled/server.mjs"
service stopped keepalive
echo changed > "$NEW/framework/services/stopped/server.mjs"
service stale-definition keepalive; running stale-definition "$TEST_ROOT/deleted-build/run.sh"
echo changed > "$NEW/framework/services/stale-definition/server.mjs"

cat > "$TEST_ROOT/launchctl" <<FAKE
#!/bin/sh
case "\$1" in
  print) cat "$RUNNING/\${2##*/}" 2>/dev/null || exit 113 ;;
  kickstart) [ "\$2" = -k ] && echo "\${3##*/}" >> "$KICKED" ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$TEST_ROOT/launchctl"

status=0
output=$(LAUNCHCTL="$TEST_ROOT/launchctl" "$CUTOVER" services "$OLD" "$NEW" 2>&1) || status=$?

test "$(tr '\n' ' ' < "$KICKED")" = "test.code-changed test.config-changed "
test "$status" -eq 1
case "$output" in *"not restarted: test.stale-definition"*) ;; *) echo "stale definition was not reported: $output" >&2; exit 1 ;; esac

# Identical builds restart nothing and succeed.
: > "$KICKED"
LAUNCHCTL="$TEST_ROOT/launchctl" "$CUTOVER" services "$NEW" "$NEW"
test ! -s "$KICKED"

echo "openclaw cutover services: OK"
