# restic-lib: shared helpers for the backup jobs (macbook → mini, mini → SSD).
# Sourced AFTER stream-paths.env and lib/gate.sh. Keeps every restic job
# using the same repo resolution, password handling, flags, and retention —
# so a job script is just "pick a repo + a path list", nothing else.
#
# Password handling: unattended hosts use one external mode-600 bootstrap file.
# This avoids login-keychain prompts after reboot. Set RESTIC_PASSWORD,
# RESTIC_PASSWORD_COMMAND, or RESTIC_PASSWORD_FILE to override the default.
#
# Tunables (override in stream-paths.env):
#   HUMANWARE_RESTIC_PASSWORD_FILE  default external password file
#   RESTIC_BWLIMIT           upload cap in KiB/s for remote repos ("" uncaps)
#   RESTIC_KEEP_DAILY/WEEKLY/MONTHLY  retention for forget --prune

# Resolve the passphrase from a protected bootstrap file unless the caller set
# RESTIC_PASSWORD / RESTIC_PASSWORD_COMMAND / RESTIC_PASSWORD_FILE.
if [ -z "${RESTIC_PASSWORD:-}" ] && [ -z "${RESTIC_PASSWORD_COMMAND:-}" ] && [ -z "${RESTIC_PASSWORD_FILE:-}" ]; then
  RESTIC_PASSWORD_FILE="${HUMANWARE_RESTIC_PASSWORD_FILE:-$HOME/.config/humanwareos/restic-password}"
  [ -f "$RESTIC_PASSWORD_FILE" ] || {
    echo "restic: missing password file $RESTIC_PASSWORD_FILE" >&2
    return 1
  }
  mode=$(stat -f '%Lp' "$RESTIC_PASSWORD_FILE")
  [ "$mode" = 600 ] || [ "$mode" = 400 ] || {
    echo "restic: password file must be mode 400 or 600: $RESTIC_PASSWORD_FILE" >&2
    return 1
  }
  export RESTIC_PASSWORD_FILE
fi

# restic_run <repo> <backup-paths-array-name> <tag> [extra restic backup args...]
# Runs a tagged backup, then a retention prune. Idempotent and safe to defer:
# restic locks the repo itself, and a skipped run just means the next tick
# catches the same (deduplicated) delta.
restic_run() {
  local repo="$1" paths_name="$2" tag="$3"; shift 3
  local -a paths; eval "paths=(\"\${${paths_name}[@]}\")"
  local exclude="${RESTIC_EXCLUDE_FILE:-}"
  local -a args=(--repo "$repo" --tag "$tag" --exclude-caches --one-file-system)
  [ -n "$exclude" ] && [ -f "$exclude" ] && args+=(--exclude-file "$exclude")
  # bandwidth cap only helps for remote (sftp:/rest:) repos
  case "$repo" in sftp:*|rest:*) [ -n "${RESTIC_BWLIMIT:-}" ] && args+=(--limit-upload "$RESTIC_BWLIMIT");; esac

  echo "$(date '+%F %T') restic backup start: repo=$repo tag=$tag"
  restic "${args[@]}" backup "${paths[@]}" "$@"

  echo "$(date '+%F %T') restic forget/prune: repo=$repo"
  restic --repo "$repo" forget --tag "$tag" --prune \
    --keep-daily "${RESTIC_KEEP_DAILY:-7}" \
    --keep-weekly "${RESTIC_KEEP_WEEKLY:-8}" \
    --keep-monthly "${RESTIC_KEEP_MONTHLY:-12}"
  echo "$(date '+%F %T') restic done: repo=$repo tag=$tag"
}

# Ensure a repo exists (init on first run). No-op if already initialized.
restic_ensure() {
  local repo="$1"
  if ! restic --repo "$repo" cat config >/dev/null 2>&1; then
    echo "$(date '+%F %T') initializing restic repo: $repo"
    restic --repo "$repo" init
  fi
}
