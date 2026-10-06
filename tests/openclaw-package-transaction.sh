#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/humanware-openclaw-package.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
TRANSACTION="$TMP/transaction"
TARGET="$TMP/global/openclaw"

package() {
  local root=$1 version=$2
  mkdir -p "$root"
  printf '%s\n' "{\"name\":\"openclaw\",\"version\":\"$version\",\"dependencies\":{},\"optionalDependencies\":{}}" > "$root/package.json"
  printf '%s\n' '#!/usr/bin/env node' > "$root/openclaw.mjs"
}

package "$TRANSACTION/staged/node_modules/openclaw" 2026.9.8
package "$TARGET" 2026.9.1
printf '%s\n' '{"version":"2026.9.8"}' > "$TRANSACTION/stage.json"

python3 "$ROOT/scripts/openclaw-package-transaction.py" install --transaction "$TRANSACTION" --target "$TARGET" >/dev/null
[ "$(jq -r .version "$TARGET/package.json")" = 2026.9.8 ]
[ "$(jq -r .version "$TRANSACTION/retained/openclaw/package.json")" = 2026.9.1 ]

python3 "$ROOT/scripts/openclaw-package-transaction.py" restore --transaction "$TRANSACTION" --target "$TARGET" >/dev/null
[ "$(jq -r .version "$TARGET/package.json")" = 2026.9.1 ]
[ "$(jq -r .version "$TRANSACTION/restored.json")" = 2026.9.1 ]

echo "openclaw package transaction: OK"
