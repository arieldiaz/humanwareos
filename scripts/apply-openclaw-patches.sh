#!/bin/bash
set -euo pipefail

PATCH_DIR="${HUMANWARE_OPENCLAW_PATCH_DIR:-$(CDPATH= cd -- "$(dirname "$0")/../ops/openclaw/patches" && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node/bin/node}"

test -d "$PATCH_DIR"
test -x "$NODE_BIN"

OPENCLAW_PACKAGE_ROOT="${OPENCLAW_PACKAGE_ROOT:-/opt/homebrew/lib/node_modules/openclaw}"
export OPENCLAW_PACKAGE_ROOT
OPENCLAW_VERSION=$(
  OPENCLAW_PACKAGE_ROOT="$OPENCLAW_PACKAGE_ROOT" "$NODE_BIN" -e \
    'const fs=require("fs"),path=require("path"); process.stdout.write(JSON.parse(fs.readFileSync(path.join(process.env.OPENCLAW_PACKAGE_ROOT,"package.json"),"utf8")).version)'
)

if [ "$OPENCLAW_VERSION" != "2026.9.8" ]; then
  echo "Unsupported OpenClaw version $OPENCLAW_VERSION; review runtime patches before activation." >&2
  exit 1
fi
OPENCLAW_CORE_DIST="${OPENCLAW_CORE_DIST:-$OPENCLAW_PACKAGE_ROOT/dist}"
export OPENCLAW_CORE_DIST

while IFS= read -r patch; do
  "$NODE_BIN" "$patch"
done < <(find "$PATCH_DIR" -maxdepth 1 -type f -name "patch-$OPENCLAW_VERSION-*.mjs" ! -name '*.test.mjs' | LC_ALL=C sort)

echo "OpenClaw runtime patches applied from $PATCH_DIR"
