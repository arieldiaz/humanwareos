#!/usr/bin/env bash
# Sync: spool → mini canonical store, verified, then DELETE from MacBook.
# Runs every 5 min via launchd. If the mini is unreachable (off network),
# the spool simply accumulates until it isn't — nothing is lost.
# If MINI_DATA_ROOT is set, also pulls derived/ text (transcripts) back from
# the mini — same direction of trust: the MacBook initiates everything.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$OPS_DIR/stream-paths.env"
source "$OPS_DIR/lib/gate.sh"

# never fight a live stream, an active user, or the battery for bandwidth
defer_if_busy sync

# cap upload rate (KiB/s) so a big recording never starves whatever the
# network is doing when the gate does let us through; set "" to uncap
SYNC_BWLIMIT="${SYNC_BWLIMIT-8192}"

# reachability check — bail quietly if the mini isn't there
ssh -o ConnectTimeout=5 -o BatchMode=yes "$MINI_USER@$MINI_HOST" true 2>/dev/null || {
  echo "$(date '+%F %T') mini unreachable; spool retained"
  exit 0
}

# ship the spool, if there's anything in it
if [ -d "$STREAM_LOCAL" ] && find "$STREAM_LOCAL" -type f ! -name ".DS_Store" | head -1 | grep -q .; then
  # --checksum: verify content, not just size/mtime.
  # --remove-source-files: rsync deletes each source file ONLY after
  # that file transferred successfully. This is the delete-from-MacBook step.
  rsync -a --checksum --partial --remove-source-files \
    ${SYNC_BWLIMIT:+--bwlimit="$SYNC_BWLIMIT"} \
    --exclude ".DS_Store" \
    "$STREAM_LOCAL/" "$MINI_USER@$MINI_HOST:$STREAM_CANONICAL/"

  # sweep now-empty date directories from the spool
  find "$STREAM_LOCAL" -mindepth 1 -type d -empty -delete
  echo "$(date '+%F %T') sync complete; spool cleared"
fi

# pull derived text back from the mini. Safe to mirror: derived/ is
# disposable and the mini's copy is canonical (README.md stays git's).
if [ -n "${MINI_DATA_ROOT:-}" ]; then
  rsync -a --delete --exclude ".DS_Store" --exclude "README.md" \
    "$MINI_USER@$MINI_HOST:$MINI_DATA_ROOT/derived/" "$DATA_ROOT/derived/"
  echo "$(date '+%F %T') derived/ pulled from mini"
fi
