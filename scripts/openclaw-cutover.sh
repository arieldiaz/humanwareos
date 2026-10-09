#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 prepare FRAMEWORK_DIR INSTANCE_DIR | activate PREPARED_JSON APPROVAL_FILE | prune RUNTIME_ROOT DATA_ROOT [KEEP]" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
ACTION=$1
shift
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
JQ=${JQ:-/usr/bin/jq}
NODE_BIN=${NODE_BIN:-/opt/homebrew/opt/node/bin/node}
OPENCLAW_BIN=${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}
PACKAGE_TARGET=${OPENCLAW_PACKAGE_ROOT:-/opt/homebrew/lib/node_modules/openclaw}

# Builds and cutover transactions are rebuildable. Keep the newest KEEP of each
# plus whatever `current` points at, so a rollback target always survives.
prune() {
  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
  local runtime_root=$1 data=$2 keep=${3:-3} current="" name
  [ ! -L "$runtime_root/current" ] || current=$(basename "$(readlink "$runtime_root/current")")
  if [ -d "$runtime_root/runtime" ]; then
    ls -1 "$runtime_root/runtime" | grep -vx -- "$current" | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r name; do
      rm -rf "$runtime_root/runtime/$name"
    done
  fi
  if [ -d "$data/operations/cutovers" ]; then
    ls -1 "$data/operations/cutovers" | grep '^openclaw-' | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r name; do
      rm -rf "$data/operations/cutovers/$name"
    done
  fi
  # An approval is valid for at most 30 minutes, so an older pending file can never be consumed.
  if [ -d "$data/operations/control/restart-approvals/pending" ]; then
    find "$data/operations/control/restart-approvals/pending" -name '*.json' -mmin +31 -delete
  fi
}

prepare() {
  [ "$#" -eq 2 ] || usage
  local framework instance data runtime_root version output runtime build_id transaction staged_bin candidate
  framework=$(CDPATH= cd -- "$1" && pwd)
  instance=$(CDPATH= cd -- "$2" && pwd)
  # The only thing prepare prints on stdout is the prepared.json path; everything else goes to stderr.
  exec 3>&1 1>&2
  "$framework/scripts/validate-instance.sh" "$framework" "$instance"
  data=$($JQ -r '.paths.dataRoot' "$instance/humanware.instance.json")
  runtime_root=$($JQ -r '.paths.runtimeRoot' "$instance/humanware.instance.json")
  version=$($JQ -r '.openclaw.version' "$instance/humanware.instance.json")
  prune "$runtime_root" "$data"
  output=$("$framework/scripts/build-runtime.sh" "$framework" "$instance")
  runtime=$(printf '%s\n' "$output" | /usr/bin/sed -n 's/^build-runtime: built //p' | /usr/bin/tail -n 1)
  [ -d "$runtime" ] || { echo "OpenClaw prepare did not produce a runtime" >&2; exit 1; }
  build_id=$($JQ -r '.buildId' "$runtime/manifest.json")
  transaction="$data/operations/cutovers/openclaw-$build_id"
  mkdir -p "$transaction"
  chmod 700 "$transaction"
  /usr/bin/python3 "$framework/scripts/openclaw-package-transaction.py" stage --transaction "$transaction" --version "$version"
  staged_bin="$transaction/staged/node_modules/openclaw/openclaw.mjs"
  candidate="$runtime/config/openclaw/openclaw.json"
  OPENCLAW_STATE_DIR="$transaction/validation-state" OPENCLAW_CONFIG_PATH="$candidate" "$NODE_BIN" "$staged_bin" config validate
  $JQ -n \
    --arg framework "$framework" --arg instance "$instance" --arg runtime "$runtime" \
    --arg transaction "$transaction" --arg version "$version" \
    '{schemaVersion:1,framework:$framework,instance:$instance,runtime:$runtime,transaction:$transaction,version:$version}' \
    > "$transaction/prepared.json"
  chmod 600 "$transaction/prepared.json"
  echo "$transaction/prepared.json" >&3
}

activate() {
  [ "$#" -eq 2 ] || usage
  local prepared approval framework instance runtime transaction version data runtime_root current control instance_id
  local report previous_runtime live_config config_rollback workspace_rollback candidate_bin active=1
  local cutover_started=0 package_installed=0 config_replaced=0 workspace_applied=0 runtime_switched=0
  prepared=$(CDPATH= cd -- "$(dirname "$1")" && pwd)/$(basename "$1")
  approval=$(CDPATH= cd -- "$(dirname "$2")" && pwd)/$(basename "$2")
  $JQ -e '.schemaVersion == 1' "$prepared" >/dev/null
  framework=$($JQ -r .framework "$prepared")
  instance=$($JQ -r .instance "$prepared")
  runtime=$($JQ -r .runtime "$prepared")
  transaction=$($JQ -r .transaction "$prepared")
  version=$($JQ -r .version "$prepared")
  [ -d "$framework/.git" ] && [ -d "$instance/.git" ] && [ -d "$runtime" ] && [ -d "$transaction" ]
  [ "$version" = "$($JQ -r '.openclaw.version' "$instance/humanware.instance.json")" ]
  data=$($JQ -r '.paths.dataRoot' "$instance/humanware.instance.json")
  runtime_root=$($JQ -r '.paths.runtimeRoot' "$instance/humanware.instance.json")
  current="$runtime_root/current"
  control="$data/operations/control"
  instance_id=$($JQ -r .id "$instance/humanware.instance.json")
  report="$transaction/activation"
  live_config="$HOME/.openclaw/openclaw.json"
  config_rollback="$report/openclaw-before.json"
  workspace_rollback="$report/workspaces"
  candidate_bin="$transaction/staged/node_modules/openclaw/openclaw.mjs"
  [ -f "$candidate_bin" ] || { echo "Prepared OpenClaw candidate is missing: $candidate_bin" >&2; exit 1; }
  mkdir -p "$report"
  chmod 700 "$report"

  # Drain, then consume the approval, then stop: the suspension window is short,
  # so nothing slow may sit between the drain and the stop.
  "$NODE_BIN" "$candidate_bin" gateway status --json > "$report/gateway-pre-suspend-status.json"
  if $JQ -e '.service.loaded == false and .port.status == "free"' "$report/gateway-pre-suspend-status.json" >/dev/null; then
    active=0
  elif "$NODE_BIN" "$candidate_bin" gateway suspend --wait 60 --expect-final --json > "$report/suspend.json" 2> "$report/suspend.err"; then
    active=0
  fi
  trap '"$OPENCLAW_BIN" gateway resume --json >/dev/null 2>&1 || true' EXIT
  "$framework/scripts/runtime-restart-guard.sh" consume "$control" "$approval" "$instance_id" "$active" "$report/restart-approval.json" > "$report/consumed-approval-path"

  previous_runtime=""
  [ ! -L "$current" ] || previous_runtime=$(readlink "$current")
  printf '%s\n' "$previous_runtime" > "$report/previous-runtime"
  cp -p "$live_config" "$config_rollback"
  chmod 600 "$config_rollback"

  rollback() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [ "$status" -ne 0 ]; then
      set +e
      if [ "$cutover_started" -eq 1 ]; then
        "$OPENCLAW_BIN" gateway stop --disable --force --json >/dev/null 2>&1
      fi
      if [ "$workspace_applied" -eq 1 ]; then
        HUMANWARE_WORKSPACE_BACKUP_DIR="$workspace_rollback" "$NODE_BIN" "$framework/scripts/materialize-openclaw-workspaces.mjs" restore "$workspace_rollback"
      fi
      if [ "$config_replaced" -eq 1 ]; then
        cp -p "$config_rollback" "$live_config"
      fi
      if [ "$package_installed" -eq 1 ]; then
        /usr/bin/python3 "$framework/scripts/openclaw-package-transaction.py" restore --transaction "$transaction" --target "$PACKAGE_TARGET"
      fi
      if [ "$runtime_switched" -eq 1 ] && [ -n "$previous_runtime" ]; then
        local rollback_link="$runtime_root/.rollback-$$"
        ln -s "$previous_runtime" "$rollback_link"
        mv -h -f "$rollback_link" "$current"
      fi
      if [ "$package_installed" -eq 1 ] || [ "$config_replaced" -eq 1 ] || [ "$runtime_switched" -eq 1 ]; then
        "$OPENCLAW_BIN" plugins registry --refresh --json >/dev/null 2>&1
        "$OPENCLAW_BIN" gateway install --force --json >/dev/null 2>&1
      fi
      "$OPENCLAW_BIN" gateway resume --json >/dev/null 2>&1
      "$OPENCLAW_BIN" gateway start --json >/dev/null 2>&1
      echo "OpenClaw activation failed; rollback was attempted. Inspect the report before retrying: $report" >&2
    fi
    exit "$status"
  }
  trap rollback EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  cutover_started=1
  if [ "$active" -eq 0 ] && $JQ -e '.service.loaded == false and .port.status == "free"' "$report/gateway-pre-suspend-status.json" >/dev/null; then
    $JQ -n '{action:"stop",ok:true,result:"already-stopped",message:"Gateway service is not loaded and its port is free."}' > "$report/gateway-stop.json"
  else
    "$NODE_BIN" "$candidate_bin" gateway stop --disable --force --json > "$report/gateway-stop.json"
  fi
  /usr/bin/python3 "$framework/scripts/openclaw-package-transaction.py" install --transaction "$transaction" --target "$PACKAGE_TARGET"
  if $JQ -e '.changed == true' "$transaction/installed.json" >/dev/null; then
    package_installed=1
  fi
  cp -p "$runtime/config/openclaw/openclaw.json" "$live_config"
  chmod 600 "$live_config"
  config_replaced=1
  if [ "$package_installed" -eq 1 ]; then
    while IFS= read -r plugin; do "$OPENCLAW_BIN" plugins update "$plugin" > "$report/plugin-$(basename "$plugin").log" 2>&1; done < <($JQ -r '.openclaw.plugins[]' "$instance/humanware.instance.json")
  fi
  NODE_BIN="$NODE_BIN" "$framework/scripts/apply-openclaw-patches.sh" > "$report/patches.log"
  HUMANWARE_WORKSPACE_BACKUP_DIR="$workspace_rollback" "$NODE_BIN" "$framework/scripts/materialize-openclaw-workspaces.mjs" apply "$runtime" "$live_config"
  workspace_applied=1
  local next_link="$runtime_root/.current-$$"
  ln -s "$runtime" "$next_link"
  mv -h -f "$next_link" "$current"
  runtime_switched=1
  "$OPENCLAW_BIN" plugins registry --refresh --json > "$report/plugin-registry.json"
  "$OPENCLAW_BIN" config validate
  "$OPENCLAW_BIN" gateway install --force --json > "$report/gateway-install.json"
  "$OPENCLAW_BIN" gateway start --json > "$report/gateway-start.json"
  local attempt=1
  until "$OPENCLAW_BIN" gateway status --require-rpc --json > "$report/gateway-status.json" 2> "$report/gateway-status.err"; do
    [ "$attempt" -lt 12 ] || { echo "OpenClaw gateway did not become healthy" >&2; exit 1; }
    attempt=$((attempt + 1))
    sleep 5
  done
  trap - EXIT HUP INT TERM
  echo "OpenClaw $version active. Report: $report"
}

case "$ACTION" in
  prepare) prepare "$@" ;;
  activate) activate "$@" ;;
  prune) prune "$@" ;;
  *) usage ;;
esac
