#!/usr/bin/env bash
# One-command MacBook side of the restic backup. Idempotent — safe to re-run.
#
# Does everything except the two things that must be a human at a prompt:
# the repo passphrase (typed, never passed as an argument) and the mini's
# login password for ssh-copy-id. Everything else — config line, plist paths,
# launchd agent, first seed snapshot — happens here.
#
#   ops/macbook/bootstrap-backup.sh
#
# Prereqs it checks and tells you how to fix: restic installed, passphrase in
# the Keychain, passwordless ssh to the mini.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$OPS_DIR/stream-paths.env"
MINI_HOST="${MINI_HOST:-ariel-mini}"
MINI_USER="${MINI_USER:-admin}"
REPO_PATH="${MINI_REPO_PATH:-/Users/admin/ariel-os-data/backups/restic/macbook}"
REPO="sftp:${MINI_USER}@${MINI_HOST}:${REPO_PATH}"

die() { echo "✗ $*" >&2; exit 1; }
ok()  { echo "✓ $*"; }

echo "── checking prerequisites ──"

command -v restic >/dev/null 2>&1 || die "restic not installed. Run: brew install restic"
ok "restic $(restic version | awk '{print $2}')"

security find-generic-password -a "$USER" -s "${RESTIC_KEYCHAIN_SERVICE:-lifeos-restic}" -w >/dev/null 2>&1 \
  || die "repo passphrase not in the Keychain. Run:
    security add-generic-password -a \"\$USER\" -s lifeos-restic -w"
ok "passphrase found in Keychain"

# Try the names the mini answers to, in order: Tailscale MagicDNS (works off
# the LAN), then Bonjour, then whatever MINI_HOST was set to.
reached=""
for h in "$MINI_HOST" "${MINI_HOST}.local"; do
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "${MINI_USER}@${h}" true 2>/dev/null; then
    reached="$h"; break
  fi
done
[ -n "$reached" ] || die "no passwordless ssh to ${MINI_USER}@${MINI_HOST}. Run:
    ssh-copy-id ${MINI_USER}@${MINI_HOST}
  (if that can't resolve the host, try ${MINI_HOST}.local)"
MINI_HOST="$reached"
REPO="sftp:${MINI_USER}@${MINI_HOST}:${REPO_PATH}"
ok "ssh ${MINI_USER}@${MINI_HOST} works without a password"

echo "── wiring config ──"

[ -f "$ENV_FILE" ] || cp "$OPS_DIR/stream-paths.env.example" "$ENV_FILE"
if grep -q '^BACKUP_MACBOOK_REPO=' "$ENV_FILE"; then
  ok "BACKUP_MACBOOK_REPO already set in $ENV_FILE"
else
  printf '\n# Daily push: this MacBook'"'"'s config layer → restic repo on the mini.\nBACKUP_MACBOOK_REPO="%s"\n' "$REPO" >> "$ENV_FILE"
  ok "added BACKUP_MACBOOK_REPO to $ENV_FILE"
fi

[ -f "$OPS_DIR/backup/exclude.txt" ] || cp "$OPS_DIR/backup/exclude.txt.example" "$OPS_DIR/backup/exclude.txt" 2>/dev/null || true
if grep -q '^RESTIC_EXCLUDE_FILE=' "$ENV_FILE"; then
  ok "RESTIC_EXCLUDE_FILE already set"
elif [ -f "$OPS_DIR/backup/exclude.txt" ]; then
  printf 'RESTIC_EXCLUDE_FILE="$OPS_DIR/backup/exclude.txt"\n' >> "$ENV_FILE"
  ok "added RESTIC_EXCLUDE_FILE (caches and node_modules stay out)"
fi

chmod +x "$OPS_DIR/macbook/backup-to-mini.sh"

PLIST_SRC="$OPS_DIR/macbook/com.lifeos.backup.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.lifeos.backup.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|/Users/you/life-os/ops|$OPS_DIR|g" -e "s|/Users/you|$HOME|g" "$PLIST_SRC" > "$PLIST_DST"
ok "installed $PLIST_DST (3am daily)"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
ok "launchd agent loaded"

echo "── first snapshot (this one is the slow one) ──"
BACKUP_FORCE=1 bash "$OPS_DIR/macbook/backup-to-mini.sh"

echo
restic --repo "$REPO" snapshots --latest 3
echo
ok "done. Nightly 3am from here; log: $HOME/Library/Logs/lifeos-backup.log"
