#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CUTOVER="$ROOT/scripts/openclaw-cutover.sh"
TEST_ROOT=$(mktemp -d)
trap '/bin/rm -rf "$TEST_ROOT"' EXIT
STATE="$TEST_ROOT/openclaw"

package() {
  mkdir -p "$1"
  printf '{"name":"openclaw","version":"%s","openclaw":{"schemaVersions":{"state":%s,"agent":%s}}}\n' "$2" "$3" "$4" > "$1/package.json"
}
database() {
  mkdir -p "$(dirname "$1")"
  /usr/bin/sqlite3 "$1" "PRAGMA journal_mode=wal; PRAGMA user_version=$2; CREATE TABLE IF NOT EXISTS t(x); INSERT INTO t VALUES(1);" >/dev/null
}

package "$TEST_ROOT/candidate" 2026.11.2 22 27
database "$STATE/state/openclaw.sqlite" 19
database "$STATE/agents/behind/agent/openclaw-agent.sqlite" 24
database "$STATE/agents/current/agent/openclaw-agent.sqlite" 27
# A stopped gateway leaves no WAL sidecars behind; the check must not need them.
rm -f "$STATE/state/openclaw.sqlite-wal" "$STATE/state/openclaw.sqlite-shm"
# Files beside the databases are not databases.
: > "$STATE/agents/behind/agent/openclaw-agent.sqlite.reindex-lock.sqlite"
cp "$STATE/state/openclaw.sqlite" "$STATE/state/openclaw.sqlite.pre-startup-migration-x.bak"

plan=$("$CUTOVER" migrations "$TEST_ROOT/candidate" "$STATE")
test "$plan" = "$(printf 'state\t%s/state/openclaw.sqlite\t19\t22\nagent\t%s/agents/behind/agent/openclaw-agent.sqlite\t24\t27' "$STATE" "$STATE")"

# Nothing to migrate prints nothing, so the activation skips the copies and Doctor.
package "$TEST_ROOT/same" 2026.11.2 19 27
database "$STATE/agents/behind/agent/openclaw-agent.sqlite" 27
test -z "$("$CUTOVER" migrations "$TEST_ROOT/same" "$STATE")"

# A database ahead of the package refuses before anything is stopped.
package "$TEST_ROOT/older" 2026.9.8 19 24
set +e
refusal=$("$CUTOVER" migrations "$TEST_ROOT/older" "$STATE" 2>&1)
status=$?
set -e
[ "$status" -ne 0 ]
case "$refusal" in
  *"writes agent schema 24"*"openclaw-agent.sqlite is already at 27"*) ;;
  *) echo "migrations did not name the database the package cannot open: $refusal" >&2; exit 1 ;;
esac

# A package that does not declare its schema versions is unknown, which fails closed.
mkdir -p "$TEST_ROOT/silent"
printf '{"name":"openclaw","version":"2026.11.2"}\n' > "$TEST_ROOT/silent/package.json"
! "$CUTOVER" migrations "$TEST_ROOT/silent" "$STATE" 2>/dev/null

# A database that cannot be read fails closed rather than counting as current.
printf 'junk\n' > "$STATE/state/openclaw.sqlite"
! "$CUTOVER" migrations "$TEST_ROOT/candidate" "$STATE" 2>/dev/null

# The activation checks before it drains, copies after the stop and before the first mutation,
# runs Doctor only when a migration is pending, and restores the copies on rollback.
line() { grep -n -F -- "$1" "$CUTOVER" | head -n 1 | cut -d: -f1; }
check=$(line 'migrations "$candidate_package" "$live_state" > "$report/migrations"')
drain=$(line 'candidate_gateway suspend --wait 60')
stop=$(line 'candidate_gateway stop --disable --force --json > "$report/gateway-stop.json"')
copy=$(line 'copy_database "$db" "$state_rollback/')
install=$(line 'openclaw-package-transaction.py" install')
doctor=$(line '"$OPENCLAW_BIN" doctor --fix --non-interactive > "$report/doctor.log"')
start=$(line '"$OPENCLAW_BIN" gateway install --force --json > "$report/gateway-install.json"')
[ -n "$check" ] && [ "$check" -lt "$drain" ] && [ "$drain" -lt "$stop" ] && [ "$stop" -lt "$copy" ] && [ "$copy" -lt "$install" ] && [ "$install" -lt "$doctor" ] && [ "$doctor" -lt "$start" ]
rollback_stop=$(line '"$OPENCLAW_BIN" gateway stop --disable --force --json >/dev/null')
restore=$(line 'copy_database "$copy" "$(dirname "$db")"')
[ "$rollback_stop" -lt "$restore" ] && [ "$restore" -lt "$stop" ]
grep -Fq 'migrations "$transaction/staged/node_modules/openclaw" "$HOME/.openclaw" > "$transaction/migrations"' "$CUTOVER"

echo "openclaw cutover migrations: OK"
