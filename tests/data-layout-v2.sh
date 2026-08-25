#!/bin/bash
set -euo pipefail

ROOT=$(mktemp -d "${TMPDIR:-/tmp}/humanware-data-v2-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT
SOURCE="$ROOT/source"
TARGET="$ROOT/target"
mkdir -p "$SOURCE/memory/current" "$SOURCE/memory/events" "$SOURCE/strategy" "$SOURCE/stream" "$SOURCE/derived/report" "$SOURCE/workspaces/agents/liv" "$SOURCE/sessions/events" "$SOURCE/artifacts"
printf '%s\n' memory > "$SOURCE/memory/current/index.md"
printf '%s\n' strategy > "$SOURCE/strategy/current.md"
printf '%s\n' event > "$SOURCE/stream/one.jsonl"
printf '%s\n' report > "$SOURCE/derived/report/current.txt"
printf '%s\n' session > "$SOURCE/sessions/events/one.jsonl"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
dry_run=$("$SCRIPT_DIR/scripts/migrate-data-layout-v2.sh" --dry-run "$SOURCE" "$TARGET")
printf '%s' "$dry_run" | grep -q $'stream\tevidence/stream'
"$SCRIPT_DIR/scripts/migrate-data-layout-v2.sh" --apply "$SOURCE" "$TARGET"
"$SCRIPT_DIR/scripts/migrate-data-layout-v2.sh" --verify "$SOURCE" "$TARGET"
cmp -s "$SOURCE/memory/current/index.md" "$TARGET/current/memory/index.md"
cmp -s "$SOURCE/derived/report/current.txt" "$TARGET/generated/report/current.txt"
test -d "$TARGET/operations/restore-tests"
printf '%s\n' "data layout v2 test: OK"
