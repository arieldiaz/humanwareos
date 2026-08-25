#!/bin/bash
set -euo pipefail

usage() {
  printf '%s\n' "Usage: $0 --dry-run|--apply|--verify SOURCE_ROOT TARGET_ROOT"
}

[ "$#" -eq 3 ] || { usage >&2; exit 2; }
MODE=$1
SOURCE_ROOT=$2
TARGET_ROOT=$3
case "$MODE" in --dry-run|--apply|--verify) ;; *) usage >&2; exit 2;; esac
case "$SOURCE_ROOT:$TARGET_ROOT" in /*:/*) ;; *) printf '%s\n' "source and target roots must be absolute" >&2; exit 2;; esac
[ "$SOURCE_ROOT" != "$TARGET_ROOT" ] || { printf '%s\n' "source and target roots must differ" >&2; exit 2; }
[ -d "$SOURCE_ROOT" ] || { printf '%s\n' "source root is missing: $SOURCE_ROOT" >&2; exit 2; }

MAPPINGS=(
  "stream:evidence/stream"
  "records:evidence/records"
  "sessions:evidence/sessions"
  "session-history:evidence/sessions/history"
  "imports:evidence/imports"
  "provenance:evidence/provenance"
  "memory/events:evidence/memory/events"
  "strategy/events:evidence/strategy/events"
  "memory/current:current/memory"
  "strategy/current.md:current/strategy.md"
  "workspaces:working"
  "hypaware-pilot:working/projects/hypaware-pilot"
  "inbox:working/inbox"
  "artifacts:artifacts"
  "blobs:artifacts/blobs"
  "manifests:artifacts/manifests"
  "derived:generated"
  "memory/indexes:generated/indexes/memory"
  "cache:operations/cache"
  "backups:operations/backups"
)

copy_entry() {
  local source=$1 target=$2
  [ -e "$source" ] || return 0
  mkdir -p "$(dirname "$target")"
  if [ -d "$source" ]; then
    mkdir -p "$target"
    if [ "$(uname -s)" = "Darwin" ]; then /bin/cp -a -c "$source/." "$target/"; else /bin/cp -a --reflink=auto "$source/." "$target/"; fi
  else
    if [ "$(uname -s)" = "Darwin" ]; then /bin/cp -a -c "$source" "$target"; else /bin/cp -a --reflink=auto "$source" "$target"; fi
  fi
}

verify_entry() {
  local source=$1 target=$2
  [ -e "$source" ] || return 0
  [ -e "$target" ] || { printf '%s\n' "missing migrated target: $target" >&2; return 1; }
  if [ -f "$source" ]; then
    /usr/bin/cmp -s "$source" "$target" || { printf '%s\n' "migrated file differs: $target" >&2; return 1; }
    return
  fi
  local source_count target_count
  source_count=$(/usr/bin/find "$source" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  target_count=$(/usr/bin/find "$target" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  [ "$target_count" -ge "$source_count" ] || {
    printf '%s\n' "file-count mismatch $source -> $target ($source_count > $target_count)" >&2
    return 1
  }
}

if [ "$MODE" = "--dry-run" ]; then
  for mapping in "${MAPPINGS[@]}"; do
    source=${mapping%%:*}
    target=${mapping#*:}
    [ -e "$SOURCE_ROOT/$source" ] && printf '%s\t%s\n' "$source" "$target"
  done
  exit 0
fi

if [ "$MODE" = "--apply" ]; then
  [ ! -e "$TARGET_ROOT" ] || { printf '%s\n' "target already exists: $TARGET_ROOT" >&2; exit 1; }
  umask 077
  mkdir -p "$TARGET_ROOT"
  for mapping in "${MAPPINGS[@]}"; do
    copy_entry "$SOURCE_ROOT/${mapping%%:*}" "$TARGET_ROOT/${mapping#*:}"
  done
  for path in evidence/legacy evidence/sessions/raw current working/agents working/sessions working/projects artifacts/revisions artifacts/blobs artifacts/manifests artifacts/archives generated/sessions generated/transcripts generated/reports generated/indexes generated/review-projections operations/cache operations/backups operations/migrations operations/cutovers operations/locks operations/diagnostics operations/restore-tests; do
    mkdir -p "$TARGET_ROOT/$path"
  done
  printf '%s\n' '{"schemaVersion":2,"layout":"humanware-data-v2"}' > "$TARGET_ROOT/artifacts/manifests/data-plane.json"
fi

for mapping in "${MAPPINGS[@]}"; do
  verify_entry "$SOURCE_ROOT/${mapping%%:*}" "$TARGET_ROOT/${mapping#*:}"
done
test -f "$TARGET_ROOT/current/memory/index.md"
test -f "$TARGET_ROOT/current/strategy.md"
test -f "$TARGET_ROOT/artifacts/manifests/data-plane.json"
printf 'data-layout-v2: verified %s -> %s\n' "$SOURCE_ROOT" "$TARGET_ROOT"
