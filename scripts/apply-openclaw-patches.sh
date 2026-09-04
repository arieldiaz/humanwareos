#!/bin/bash
set -euo pipefail

PATCH_DIR="${HUMANWARE_OPENCLAW_PATCH_DIR:-$(CDPATH= cd -- "$(dirname "$0")/../ops/openclaw/patches" && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node/bin/node}"

test -d "$PATCH_DIR"
test -x "$NODE_BIN"

OPENCLAW_PACKAGE_ROOT="${OPENCLAW_PACKAGE_ROOT:-/opt/homebrew/lib/node_modules/openclaw}"
OPENCLAW_VERSION=$(
  OPENCLAW_PACKAGE_ROOT="$OPENCLAW_PACKAGE_ROOT" "$NODE_BIN" -e \
    'const fs=require("fs"),path=require("path"); process.stdout.write(JSON.parse(fs.readFileSync(path.join(process.env.OPENCLAW_PACKAGE_ROOT,"package.json"),"utf8")).version)'
)

case "$OPENCLAW_VERSION" in
  2026.7.1*)
    while IFS= read -r patch; do
      "$NODE_BIN" "$patch"
    done < <(find "$PATCH_DIR" -maxdepth 1 -type f -name 'patch-2026.7.1*.mjs' ! -name '*.test.mjs' | LC_ALL=C sort)
    ;;
  2026.9.1)
    OPENCLAW_CORE_DIST="${OPENCLAW_CORE_DIST:-$OPENCLAW_PACKAGE_ROOT/dist}" \
      "$NODE_BIN" "$PATCH_DIR/patch-2026.7.1-prompt-boilerplate.mjs"
    "$NODE_BIN" "$PATCH_DIR/patch-2026.7.1-slack-rich-text.mjs"
    ;;
  *)
    echo "Unsupported OpenClaw version $OPENCLAW_VERSION; review runtime patches before activation." >&2
    exit 1
    ;;
esac

echo "OpenClaw runtime patches applied from $PATCH_DIR"
