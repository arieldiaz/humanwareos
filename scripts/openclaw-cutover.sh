#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 prepare FRAMEWORK_DIR INSTANCE_DIR | activate PREPARED_JSON APPROVAL_FILE | prune RUNTIME_ROOT DATA_ROOT [KEEP] | migrations OPENCLAW_PACKAGE STATE_DIR | services PREVIOUS_RUNTIME RUNTIME" >&2
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
LAUNCHCTL=${LAUNCHCTL:-/bin/launchctl}

# Builds and cutover transactions are rebuildable. Keep the newest KEEP of each
# plus whatever `current` points at, so a rollback target always survives.
# A build the live OpenClaw config still references (its secret provider) also
# survives: a prepared but unactivated cutover must not strand the gateway.
prune() {
  [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
  local runtime_root=$1 data=$2 keep=${3:-3} current="" name live_config="$HOME/.openclaw/openclaw.json"
  [ ! -L "$runtime_root/current" ] || current=$(basename "$(readlink "$runtime_root/current")")
  if [ -d "$runtime_root/runtime" ]; then
    ls -1 "$runtime_root/runtime" | grep -vx -- "$current" | sort -r | tail -n +"$((keep + 1))" | while IFS= read -r name; do
      [ -f "$live_config" ] && grep -qF -- "$runtime_root/runtime/$name/" "$live_config" && continue
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
  # Finished one-shot cutover jobs stay registered in launchd until something boots them out.
  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | awk '$3 ~ /^com\.humanwareos\.cutover\./ && $1 == "-" {print $3}' | while IFS= read -r label; do
      launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    done
  fi
}

# The shared state database and every agent database: the files whose schema an OpenClaw build owns.
state_databases() {
  local db
  for db in "$1/state/openclaw.sqlite" "$1"/agents/*/agent/openclaw-agent.sqlite; do
    [ ! -f "$db" ] || echo "$db"
  done
}

# A package declares the schema version it writes; a database behind it is migrated on first
# open, which the displaced package cannot read back, and one ahead of it cannot be opened at
# all. Prints one "kind path found wanted" line per database the package would migrate and
# fails when it could not open one. Reading the header with immutable=1 takes no lock and needs
# no WAL sidecar, so it works beside a running gateway and after a stop; it can only lag a
# header write still in the WAL, which overstates the pending migrations and never hides one.
migrations() {
  [ "$#" -eq 2 ] || usage
  local package=$1 state=$2 db kind wanted found
  while IFS= read -r db; do
    case "$db" in */state/openclaw.sqlite) kind=state ;; *) kind=agent ;; esac
    wanted=$($JQ -er ".openclaw.schemaVersions.$kind" "$package/package.json") || { echo "OpenClaw package $package does not declare its $kind schema version" >&2; return 1; }
    found=$(/usr/bin/sqlite3 "file:$db?immutable=1" 'PRAGMA user_version')
    [ "$found" -le "$wanted" ] || { echo "OpenClaw package $package writes $kind schema $wanted but $db is already at $found; it cannot open this state" >&2; return 1; }
    [ "$found" -eq "$wanted" ] || printf '%s\t%s\t%s\t%s\n' "$kind" "$db" "$found" "$wanted"
  done < <(state_databases "$state")
}

# A SQLite database travels with its -wal and -shm files; a stale journal beside a restored copy would corrupt it.
# A local service loads its code once, so switching `current` does not reach a
# running one. Restart each running keepalive service whose own files differ
# between the two builds; a scheduled job picks the build up on its next run.
services() {
  [ "$#" -eq 2 ] || usage
  local previous=$1 runtime=$2 domain plist dir label state program failed=0
  domain="gui/$(id -u)"
  while IFS= read -r plist; do
    dir=${plist#"$runtime/config/services/"}
    dir=${dir%%/*}
    [ "$(/usr/bin/plutil -extract KeepAlive raw -o - "$plist" 2>/dev/null)" = true ] || continue
    if /usr/bin/diff -rq "$previous/config/services/$dir" "$runtime/config/services/$dir" >/dev/null 2>&1 &&
      { [ ! -e "$runtime/framework/services/$dir" ] || /usr/bin/diff -rq "$previous/framework/services/$dir" "$runtime/framework/services/$dir" >/dev/null 2>&1; }; then
      continue
    fi
    label=$(/usr/bin/plutil -extract Label raw -o - "$plist")
    state=$("$LAUNCHCTL" print "$domain/$label" 2>/dev/null) || continue
    printf '%s\n' "$state" | grep -q '^[[:space:]]*pid = ' || continue
    # Killing a service whose installed definition points at a deleted build leaves it down.
    program=$(printf '%s\n' "$state" | sed -n 's/^[[:space:]]*program = //p' | head -1)
    if [ ! -x "$program" ]; then
      echo "not restarted: $label runs a program that no longer exists; reinstall its LaunchAgent" >&2
      failed=1
    elif "$LAUNCHCTL" kickstart -k "$domain/$label"; then
      echo "restarted $label"
    else
      echo "restart failed: $label" >&2
      failed=1
    fi
  done < <(find "$runtime/config/services" -name '*.plist' 2>/dev/null | sort)
  return "$failed"
}

copy_database() {
  local source=$1 target=$2 part
  mkdir -p "$target"
  for part in "$source" "$source-wal" "$source-shm"; do
    [ ! -f "$part" ] || /bin/cp -pc "$part" "$target/"
  done
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
  migrations "$transaction/staged/node_modules/openclaw" "$HOME/.openclaw" > "$transaction/migrations"
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
  local prepared approval framework instance runtime transaction version data runtime_root current control instance_id db
  local report previous_runtime live_state live_config config_rollback workspace_rollback state_rollback candidate_package candidate_bin candidate_config active=1 previous_patch_set="" stock_needed=0
  local cutover_started=0 state_backed_up=0 package_installed=0 config_replaced=0 workspace_applied=0 runtime_switched=0
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
  live_state="$HOME/.openclaw"
  live_config="$live_state/openclaw.json"
  config_rollback="$report/openclaw-before.json"
  workspace_rollback="$report/workspaces"
  state_rollback="$report/state"
  candidate_package="$transaction/staged/node_modules/openclaw"
  candidate_bin="$candidate_package/openclaw.mjs"
  candidate_config="$runtime/config/openclaw/openclaw.json"
  [ -f "$candidate_bin" ] || { echo "Prepared OpenClaw candidate is missing: $candidate_bin" >&2; exit 1; }
  [ -f "$candidate_config" ] || { echo "Prepared OpenClaw config is missing: $candidate_config" >&2; exit 1; }
  # Service management refuses a non-canonical config path, so the candidate
  # binary drives the live gateway through the canonical config it is replacing.
  candidate_gateway() {
    "$NODE_BIN" "$candidate_bin" gateway "$@"
  }
  mkdir -p "$report"
  chmod 700 "$report"
  # A candidate that cannot open the databases refuses here, before anything is drained,
  # consumed, or stopped. One it would migrate makes this window back them up and run Doctor.
  migrations "$candidate_package" "$live_state" > "$report/migrations"

  # Drain, then consume the approval, then stop: the suspension window is short,
  # so nothing slow may sit between the drain and the stop.
  candidate_gateway status --json > "$report/gateway-pre-suspend-status.json"
  if $JQ -e '.service.loaded == false and .port.status == "free"' "$report/gateway-pre-suspend-status.json" >/dev/null; then
    active=0
  elif candidate_gateway suspend --wait 60 --expect-final --json > "$report/suspend.json" 2> "$report/suspend.err"; then
    active=0
  fi
  trap 'candidate_gateway resume --json >/dev/null 2>&1 || true' EXIT
  "$framework/scripts/runtime-restart-guard.sh" consume "$control" "$approval" "$instance_id" "$active" "$report/restart-approval.json" > "$report/consumed-approval-path"

  previous_runtime=""
  [ ! -L "$current" ] || previous_runtime=$(readlink "$current")
  printf '%s\n' "$previous_runtime" > "$report/previous-runtime"
  # A changed patch set means the live package carries edits that no longer
  # exist in source; it must return to stock text before patches apply.
  [ ! -f "$previous_runtime/manifest.json" ] || previous_patch_set=$($JQ -r '.patchSet // ""' "$previous_runtime/manifest.json")
  [ "$previous_patch_set" = "$($JQ -r '.patchSet // ""' "$runtime/manifest.json")" ] || stock_needed=1
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
      if [ "$state_backed_up" -eq 1 ]; then
        local copy db
        while IFS= read -r copy; do
          db="$live_state/${copy#"$state_rollback"/}"
          rm -f "$db" "$db-wal" "$db-shm"
          copy_database "$copy" "$(dirname "$db")"
        done < <(find "$state_rollback" -name '*.sqlite')
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
      "$OPENCLAW_BIN" gateway start --json > "$report/rollback-gateway-start.json" 2>&1
      # A rollback that leaves the gateway down is a second failure; say so instead of implying recovery.
      local attempt=1
      until "$OPENCLAW_BIN" gateway status --require-rpc --json > "$report/rollback-gateway-status.json" 2>&1; do
        if [ "$attempt" -ge 12 ]; then
          echo "OpenClaw rollback left the gateway down: $report/rollback-gateway-status.json" >&2
          break
        fi
        attempt=$((attempt + 1))
        sleep 5
      done
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
    candidate_gateway stop --disable --force --json > "$report/gateway-stop.json"
  fi
  # The first mutation below (a plugin update) already migrates the state database, so the
  # copies are taken before any of it; every database is copied so rollback restores one
  # consistent set, including the agent registry the state database keeps.
  if [ -s "$report/migrations" ]; then
    while IFS= read -r db; do
      copy_database "$db" "$state_rollback/$(dirname "${db#"$live_state"/}")"
    done < <(state_databases "$live_state")
    state_backed_up=1
  fi
  /usr/bin/python3 "$framework/scripts/openclaw-package-transaction.py" install --transaction "$transaction" --target "$PACKAGE_TARGET" $([ "$stock_needed" -eq 1 ] && echo --force)
  if $JQ -e '.replaced == true' "$transaction/installed.json" >/dev/null; then
    package_installed=1
  fi
  cp -p "$runtime/config/openclaw/openclaw.json" "$live_config"
  chmod 600 "$live_config"
  config_replaced=1
  # A version change refreshes every plugin; a patch-set change refreshes only the Slack plugin the patches edit.
  if $JQ -e '.changed == true' "$transaction/installed.json" >/dev/null; then
    while IFS= read -r plugin; do "$OPENCLAW_BIN" plugins update "$plugin" > "$report/plugin-$(basename "$plugin").log" 2>&1; done < <($JQ -r '.openclaw.plugins[]' "$instance/humanware.instance.json")
  elif [ "$stock_needed" -eq 1 ]; then
    while IFS= read -r plugin; do "$OPENCLAW_BIN" plugins update "$plugin" > "$report/plugin-$(basename "$plugin").log" 2>&1; done < <($JQ -r '.openclaw.plugins[] | select(startswith("@openclaw/slack"))' "$instance/humanware.instance.json")
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
  # Doctor owns the agent-database identity migration the new gateway refuses to start without;
  # it exits 1 on an incomplete repair, which rolls the package and the database copies back.
  if [ -s "$report/migrations" ]; then
    "$OPENCLAW_BIN" doctor --fix --non-interactive > "$report/doctor.log" 2>&1
  fi
  "$OPENCLAW_BIN" gateway install --force --json > "$report/gateway-install.json"
  "$OPENCLAW_BIN" gateway start --json > "$report/gateway-start.json"
  local attempt=1
  until "$OPENCLAW_BIN" gateway status --require-rpc --json > "$report/gateway-status.json" 2> "$report/gateway-status.err"; do
    [ "$attempt" -lt 12 ] || { echo "OpenClaw gateway did not become healthy" >&2; exit 1; }
    attempt=$((attempt + 1))
    sleep 5
  done
  trap - EXIT HUP INT TERM
  # The gateway is live; a local service that fails to restart is reported, never rolled back.
  [ -z "$previous_runtime" ] || services "$previous_runtime" "$runtime" > "$report/services.log" 2>&1 ||
    echo "A local service did not restart: $report/services.log" >&2
  echo "OpenClaw $version active. Report: $report"
}

case "$ACTION" in
  prepare) prepare "$@" ;;
  activate) activate "$@" ;;
  prune) prune "$@" ;;
  migrations) migrations "$@" ;;
  services) services "$@" ;;
  *) usage ;;
esac
