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
mkdir -p "$TEST_ROOT/home/.openclaw"
printf '{"secrets":{"providers":{"p":{"command":"%s/runtime/20261001T000000Z-build/framework/ops/openclaw/runtime/secret-exec.sh"}}}}\n' "$RUNTIME_ROOT" > "$TEST_ROOT/home/.openclaw/openclaw.json"
printf '{}\n' > "$PENDING/fresh.json"
printf '{}\n' > "$PENDING/expired.json"
touch -t 202601010000 "$PENDING/expired.json"

cat > "$TEST_ROOT/launchctl" <<'FAKE'
#!/bin/sh
[ ! -f "$LOADED.fail" ] || exit 1
case "$1" in
  list) printf 'PID Status Label\n42 0 test.loaded\n43 0 test.user\n' ;;
  print)
    case "$2" in
      gui/"$(id -u)"/test.loaded) cat "$LOADED" ;;
      user/"$(id -u)"/test.user) echo 'program = /usr/bin/true' ;;
      *) exit 113 ;;
    esac ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$TEST_ROOT/launchctl"
export LOADED="$TEST_ROOT/loaded"
: > "$LOADED"
export LAUNCHCTL="$TEST_ROOT/launchctl"
HOME="$TEST_ROOT/home" "$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3

test "$(ls "$RUNTIME_ROOT/runtime" | sort | tr '\n' ' ')" = "20261001T000000Z-build 20261002T000000Z-build 20261004T000000Z-build 20261005T000000Z-build 20261006T000000Z-build "
test "$(ls "$DATA/operations/cutovers" | sort | tr '\n' ' ')" = "openclaw-20261004T000000Z-build openclaw-20261005T000000Z-build openclaw-20261006T000000Z-build unrelated "
test -f "$PENDING/fresh.json"
test ! -e "$PENDING/expired.json"
test -L "$RUNTIME_ROOT/current"

# Both binary installed plists and loaded-but-replaced jobs retain old builds.
mkdir -p "$TEST_ROOT/home/Library/LaunchAgents" "$RUNTIME_ROOT/runtime/20000101-installed" "$RUNTIME_ROOT/runtime/20000102-loaded"
python3 - "$TEST_ROOT/home/Library/LaunchAgents/tunnel.plist" "$RUNTIME_ROOT" <<'PYTEST'
import plistlib, sys
with open(sys.argv[1], 'wb') as f:
    plistlib.dump({'Label': 'test.tunnel', 'ProgramArguments': [sys.argv[2] + '/runtime/20000101-installed/run.sh']}, f, fmt=plistlib.FMT_BINARY)
PYTEST
printf 'program = %s/runtime/20000102-loaded/run.sh\n' "$RUNTIME_ROOT" > "$LOADED"
HOME="$TEST_ROOT/home" "$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3
test -d "$RUNTIME_ROOT/runtime/20000101-installed"
test -d "$RUNTIME_ROOT/runtime/20000102-loaded"
# Once both references are gone the builds become reclaimable.
rm "$TEST_ROOT/home/Library/LaunchAgents/tunnel.plist"
: > "$LOADED"
HOME="$TEST_ROOT/home" "$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3
test ! -d "$RUNTIME_ROOT/runtime/20000101-installed"
test ! -d "$RUNTIME_ROOT/runtime/20000102-loaded"
# An unreadable inventory must never silently permit deletion.
mkdir -p "$RUNTIME_ROOT/runtime/19990101-protected"
touch "$LOADED.fail"
if HOME="$TEST_ROOT/home" "$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3; then exit 1; fi
test -d "$RUNTIME_ROOT/runtime/19990101-protected"
rm "$LOADED.fail"
printf 'not a plist' > "$TEST_ROOT/home/Library/LaunchAgents/broken.plist"
if HOME="$TEST_ROOT/home" "$CUTOVER" prune "$RUNTIME_ROOT" "$DATA" 3; then exit 1; fi
test -d "$RUNTIME_ROOT/runtime/19990101-protected"
echo "openclaw cutover prune: OK"
