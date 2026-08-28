#!/bin/bash
set -euo pipefail

PATCH_DIR="${HUMANWARE_OPENCLAW_PATCH_DIR:-$(CDPATH= cd -- "$(dirname "$0")/../ops/openclaw/patches" && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node/bin/node}"

test -d "$PATCH_DIR"
test -x "$NODE_BIN"

found=0
while IFS= read -r patch; do
  found=1
  "$NODE_BIN" "$patch"
done < <(find "$PATCH_DIR" -maxdepth 1 -type f -name 'patch-*.mjs' ! -name '*.test.mjs' | LC_ALL=C sort)

if [ "$found" -ne 1 ]; then
  echo "No OpenClaw runtime patches found in $PATCH_DIR" >&2
  exit 1
fi

echo "OpenClaw runtime patches applied from $PATCH_DIR"
