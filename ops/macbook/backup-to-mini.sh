#!/usr/bin/env bash
# Backup (runs ON THE MACBOOK): MacBook-only config/dotfiles → restic repo
# ON THE MINI, over SFTP. Daily. The mini is always-on, so it is the target;
# the laptop pushes. Everything else the MacBook holds is already on GitHub or
# the mini, so this job's job is the thin layer that is ONLY on the laptop:
# shell + dev + agent config, editor settings, ssh, and a fresh Brewfile.
#
# Never fights the human: sources lib/gate.sh, so if OBS is running, you're on
# battery, or you're actively typing, it defers to the next launchd tick.
# Deltas are deduplicated, so a deferred run costs nothing.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$OPS_DIR/stream-paths.env"
source "$OPS_DIR/lib/gate.sh"
source "$OPS_DIR/lib/restic-lib.sh"

defer_if_busy macbook-backup

# Regenerate the "reinstall everything" manifests before the snapshot, so the
# backup always carries a current rebuild recipe (see docs/macbook-setup.md).
MANIFEST_DIR="${BACKUP_MANIFEST_DIR:-$HOME/.config/humanwareos-backup}"
mkdir -p "$MANIFEST_DIR"
command -v brew >/dev/null 2>&1 && brew bundle dump --force --file "$MANIFEST_DIR/Brewfile" 2>/dev/null || true
command -v code >/dev/null 2>&1 && code --list-extensions > "$MANIFEST_DIR/vscode-extensions.txt" 2>/dev/null || true

# What is ONLY on the MacBook and worth keeping. Tune in stream-paths.env via
# BACKUP_MACBOOK_PATHS; this is the default set.
default_paths=(
  "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv"
  "$HOME/.gitconfig" "$HOME/.config" "$HOME/.ssh"
  "$HOME/.claude" "$HOME/.aws" "$HOME/.docker"
  "$MANIFEST_DIR"
)
if [ "${#BACKUP_MACBOOK_PATHS[@]:-0}" -gt 0 ] 2>/dev/null; then
  paths=("${BACKUP_MACBOOK_PATHS[@]}")
else
  paths=("${default_paths[@]}")
fi
# drop paths that don't exist on this machine (keeps restic from erroring)
existing=(); for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("$p"); done

REPO="${BACKUP_MACBOOK_REPO:?set BACKUP_MACBOOK_REPO in stream-paths.env}"
restic_ensure "$REPO"
restic_run "$REPO" existing "macbook-config"
