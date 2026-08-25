#!/bin/sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 DATA_ROOT"
}

[ "$#" -eq 1 ] || {
  usage >&2
  exit 2
}

DATA_ROOT=$1
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FRAMEWORK_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

case "$DATA_ROOT" in
  /*) ;;
  *) printf '%s\n' "data root must be absolute: $DATA_ROOT" >&2; exit 2 ;;
esac

umask 077
for path in \
  evidence/stream \
  evidence/memory/events \
  evidence/strategy/events \
  evidence/sessions/events \
  evidence/sessions/raw \
  evidence/imports \
  evidence/provenance \
  evidence/legacy \
  current/memory \
  working/agents \
  working/sessions \
  working/projects \
  working/inbox \
  artifacts/revisions \
  artifacts/blobs \
  artifacts/manifests \
  artifacts/archives \
  generated/sessions \
  generated/transcripts \
  generated/reports \
  generated/indexes \
  generated/review-projections \
  operations/cache \
  operations/backups \
  operations/migrations \
  operations/cutovers \
  operations/locks \
  operations/diagnostics \
  operations/restore-tests; do
  mkdir -p "$DATA_ROOT/$path"
done

if [ ! -f "$DATA_ROOT/current/strategy.md" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/current/strategy.md" "$DATA_ROOT/current/strategy.md"
fi
if [ ! -f "$DATA_ROOT/current/memory/index.md" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/current/memory/index.md" "$DATA_ROOT/current/memory/index.md"
fi
if [ ! -f "$DATA_ROOT/artifacts/manifests/data-plane.json" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/manifests/data-plane.json" "$DATA_ROOT/artifacts/manifests/data-plane.json"
fi

printf 'data-plane: ready at %s\n' "$DATA_ROOT"
