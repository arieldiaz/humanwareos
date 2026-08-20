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
  stream \
  memory/events \
  memory/current \
  memory/indexes \
  strategy/events \
  sessions/events \
  workspaces \
  artifacts \
  imports \
  blobs \
  manifests \
  derived \
  inbox \
  cache; do
  mkdir -p "$DATA_ROOT/$path"
done

if [ ! -f "$DATA_ROOT/strategy/current.md" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/strategy/current.md" "$DATA_ROOT/strategy/current.md"
fi
if [ ! -f "$DATA_ROOT/memory/current/index.md" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/memory/current/index.md" "$DATA_ROOT/memory/current/index.md"
fi
if [ ! -f "$DATA_ROOT/manifests/data-plane.json" ]; then
  install -m 600 "$FRAMEWORK_DIR/templates/data/manifests/data-plane.json" "$DATA_ROOT/manifests/data-plane.json"
fi

printf 'data-plane: ready at %s\n' "$DATA_ROOT"
