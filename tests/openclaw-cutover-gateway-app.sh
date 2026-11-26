#!/bin/bash
# Activation with stubbed OpenClaw and launchd: the gateway job is unwrapped before every
# install and wrapped after it, on the forward and rollback paths, and untouched without an app setting.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/cutover-gateway-app.XXXXXX")
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
fail() { echo "openclaw cutover gateway app: $*" >&2; exit 1; }

FAKE_HOME="$TEST_ROOT/home"
JOB="$FAKE_HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
LOG="$TEST_ROOT/calls"
STATE="$TEST_ROOT/launchd"
LAUNCHER="$TEST_ROOT/Test Services.app/Contents/MacOS/Test Services"
mkdir -p "$FAKE_HOME/.openclaw" "$(dirname "$JOB")" "$STATE" "$(dirname "$LAUNCHER")" "$TEST_ROOT/bin"
echo '{}' > "$FAKE_HOME/.openclaw/openclaw.json"
printf '#!/bin/sh\n' > "$LAUNCHER"
chmod +x "$LAUNCHER"

# The framework: the real cutover and adopt script, stub helpers.
FRAMEWORK="$TEST_ROOT/framework"
mkdir -p "$FRAMEWORK/.git" "$FRAMEWORK/scripts" "$FRAMEWORK/surfaces/macos/service-app"
cp "$ROOT/scripts/openclaw-cutover.sh" "$FRAMEWORK/scripts/"
cp "$ROOT/surfaces/macos/service-app/adopt-job.py" "$FRAMEWORK/surfaces/macos/service-app/"
printf '#!/bin/sh\necho "$5/approval.json"\n' > "$FRAMEWORK/scripts/runtime-restart-guard.sh"
printf '#!/bin/sh\nexit 0\n' > "$FRAMEWORK/scripts/apply-openclaw-patches.sh"
printf 'import json, sys\nif sys.argv[1] == "install":\n    t = sys.argv[sys.argv.index("--transaction") + 1]\n    json.dump({"replaced": False, "changed": False}, open(t + "/installed.json", "w"))\n' \
  > "$FRAMEWORK/scripts/openclaw-package-transaction.py"
chmod +x "$FRAMEWORK/scripts/"*.sh

# node runs the candidate binary (status, stop) and the workspace materializer.
cat > "$TEST_ROOT/bin/node" <<'EOF'
#!/bin/sh
case "$*" in *" gateway status "*) echo '{"service":{"loaded":false},"port":{"status":"free"}}' ;; esac
exit 0
EOF
# openclaw: install writes the stock job and loads it; start fails once when asked to.
cat > "$TEST_ROOT/bin/openclaw" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "gateway install")
    /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$JOB" 2>/dev/null | sed 's/^/install-saw /' >> "$LOG"
    cp "$TEST_ROOT/stock.plist" "$JOB"; printf /bin/sh > "$STATE/program"; touch "$STATE/loaded" ;;
  "gateway start") echo start >> "$LOG"
    if [ -f "$TEST_ROOT/fail-start" ]; then rm "$TEST_ROOT/fail-start"; exit 1; fi ;;
esac
exit 0
EOF
cat > "$TEST_ROOT/bin/launchctl" <<EOF
#!/bin/sh
echo "launchctl \$1" >> "$LOG"
case "\$1" in
  print) [ -f "$STATE/loaded" ] || exit 113; printf 'state = running\nprogram = %s\npid = 4242\n' "\$(cat "$STATE/program")" ;;
  bootout) rm -f "$STATE/loaded" ;;
  bootstrap) printf %s "\$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "\$3")" > "$STATE/program"; touch "$STATE/loaded" ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/"*

cat > "$TEST_ROOT/stock.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.openclaw.gateway</string>
<key>KeepAlive</key><true/>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>wrapper.sh</string><string>gateway.env</string><string>/usr/bin/node</string><string>index.js</string><string>gateway</string><string>--port</string><string>18789</string></array>
</dict></plist>
EOF

# activate [with-app] [fail-start]: one activation of a fresh prepared transaction.
activate() {
  local case_root="$TEST_ROOT/case-$1" instance runtime transaction
  instance="$case_root/instance" runtime="$case_root/runtime" transaction="$case_root/transaction"
  mkdir -p "$instance/.git" "$runtime/config/openclaw" "$runtime/config/services" "$transaction/staged/node_modules/openclaw" "$case_root/data"
  jq -n --arg data "$case_root/data" --arg root "$case_root/runtimes" \
    '{id:"test",openclaw:{version:"1.0.0",plugins:[]},paths:{dataRoot:$data,runtimeRoot:$root}}' > "$instance/humanware.instance.json"
  mkdir -p "$case_root/runtimes"
  echo '{"patchSet":""}' > "$runtime/manifest.json"
  echo '{}' > "$runtime/config/openclaw/openclaw.json"
  [ "$1" != with-app ] || jq -n --arg path "$TEST_ROOT/Test Services.app" \
    '{schemaVersion:1,name:"Test Services",bundleIdentifier:"org.example.services",path:$path}' > "$runtime/config/services/app.json"
  touch "$transaction/staged/node_modules/openclaw/openclaw.mjs"
  jq -n --arg f "$FRAMEWORK" --arg i "$instance" --arg r "$runtime" --arg t "$transaction" \
    '{schemaVersion:1,framework:$f,instance:$i,runtime:$r,transaction:$t,version:"1.0.0"}' > "$transaction/prepared.json"
  echo '{}' > "$case_root/approval.json"
  [ "${2:-}" != fail-start ] || touch "$TEST_ROOT/fail-start"
  : > "$LOG"
  HOME="$FAKE_HOME" PATH="$TEST_ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin" JQ=/usr/bin/jq NODE_BIN="$TEST_ROOT/bin/node" \
    OPENCLAW_BIN="$TEST_ROOT/bin/openclaw" LAUNCHCTL="$TEST_ROOT/bin/launchctl" OPENCLAW_PACKAGE_ROOT="$TEST_ROOT/package" \
    "$FRAMEWORK/scripts/openclaw-cutover.sh" activate "$transaction/prepared.json" "$case_root/approval.json" \
    > "$case_root/out" 2>&1
}
first_argument() { /usr/bin/plutil -extract ProgramArguments.0 raw -o - "$JOB"; }

# Forward path: the stock install is wrapped, reloaded, and verified before start.
cp "$TEST_ROOT/stock.plist" "$JOB"
activate with-app || fail "forward activation failed: $(cat "$TEST_ROOT/case-with-app/out")"
[ "$(first_argument)" = "$LAUNCHER" ] || fail "forward install was not wrapped"
[ "$(/usr/bin/plutil -extract AssociatedBundleIdentifiers.0 raw -o - "$JOB")" = org.example.services ] || fail "bundle identifier missing"
[ "$(cat "$STATE/program")" = "$LAUNCHER" ] || fail "launchd still runs the unwrapped job"
grep -qx 'install-saw /bin/sh' "$LOG" || fail "install did not see the stock job"
[ "$(grep -n 'launchctl bootstrap' "$LOG" | cut -d: -f1)" -lt "$(grep -n '^start$' "$LOG" | cut -d: -f1)" ] || fail "wrap ran after start"
[ "$(jq -r .result "$TEST_ROOT/case-with-app/transaction/activation/gateway-app/report.json")" = applied ] || fail "forward report"

# A second activation over the wrapped job hands OpenClaw its own form, then wraps again.
rm -rf "$TEST_ROOT/case-with-app"
activate with-app || fail "repeat activation failed"
grep -qx 'install-saw /bin/sh' "$LOG" || fail "install saw the wrapped job"
[ "$(first_argument)" = "$LAUNCHER" ] || fail "repeat install was not wrapped"

# Rollback path: a failed start reinstalls, and the reinstalled job is wrapped too.
rm -rf "$TEST_ROOT/case-with-app"
if activate with-app fail-start; then fail "failed start did not fail activation"; fi
[ "$(grep -c '^install-saw /bin/sh$' "$LOG")" -eq 2 ] || fail "rollback install did not see the stock job: $(cat "$LOG")"
[ "$(first_argument)" = "$LAUNCHER" ] || fail "rollback install was not wrapped"
[ "$(jq -r .result "$TEST_ROOT/case-with-app/transaction/activation/rollback-gateway-app/report.json")" = applied ] || fail "rollback report"

# No app setting: the installed job is left exactly as OpenClaw wrote it, and launchd is not touched.
cp "$TEST_ROOT/stock.plist" "$JOB"
activate without-app || fail "activation without an app setting failed: $(cat "$TEST_ROOT/case-without-app/out")"
cmp -s "$JOB" "$TEST_ROOT/stock.plist" || fail "job changed without an app setting"
! grep -q 'launchctl' "$LOG" || fail "launchctl ran without an app setting"

# A launcher that cannot run leaves the stock job installed and the cutover healthy, with a warning.
rm -rf "$TEST_ROOT/case-with-app"
chmod -x "$LAUNCHER"
activate with-app || fail "activation failed when wrapping was refused"
cmp -s "$JOB" "$TEST_ROOT/stock.plist" || fail "refused wrap changed the job"
grep -q 'runs without the service app' "$TEST_ROOT/case-with-app/out" || fail "refused wrap was silent"

echo "openclaw cutover gateway app: OK"
