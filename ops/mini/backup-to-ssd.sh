#!/usr/bin/env bash
# Backup (runs ON THE MINI): the mini's canonical data → restic repo on an
# external SSD. This is the 3rd copy in the 3-2-1 plan and is MANUAL by design
# — you plug the SSD in periodically (a monthly reminder nags you), run this,
# and eject. Same restic repo format as everything else, so restores are
# identical whether you pull from the SSD, the mini, or (later) the QNAP.
#
# Run it yourself:  bash ops/mini/backup-to-ssd.sh
set -euo pipefail
OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$OPS_DIR/stream-paths.env"
source "$OPS_DIR/lib/restic-lib.sh"

REPO="${BACKUP_SSD_REPO:?set BACKUP_SSD_REPO in stream-paths.env}"
# The repo path lives on a removable volume; if it isn't mounted, stop loudly
# rather than silently backing up to an empty mountpoint on the internal disk.
mount_root="${BACKUP_SSD_MOUNT:-${REPO%/restic*}}"
if [ ! -d "$mount_root" ]; then
  echo "$(date '+%F %T') SSD not mounted at $mount_root — plug it in first. SKIPPED" >&2
  exit 1
fi

# What is worth keeping from the mini. Most is already on GitHub; this captures
# the canonical stream/journal data + anything ONLY on the mini. Tune via
# BACKUP_MINI_PATHS in stream-paths.env.
default_paths=(
  "$DATA_ROOT"
  "$HOME/.config" "$HOME/.claude"
  "$HOME/Library/LaunchAgents"
)
if [ "${#BACKUP_MINI_PATHS[@]:-0}" -gt 0 ] 2>/dev/null; then
  paths=("${BACKUP_MINI_PATHS[@]}")
else
  paths=("${default_paths[@]}")
fi
existing=(); for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("$p"); done

restic_ensure "$REPO"
restic_run "$REPO" existing "mini-data"
echo "$(date '+%F %T') SSD backup complete — you can eject the drive."
