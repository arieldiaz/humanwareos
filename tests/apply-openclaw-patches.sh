#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/patches"
cat > "$TMP/node" <<'EOF'
#!/bin/bash
set -euo pipefail
basename "$1" >> "$PATCH_LOG"
if [ "$(basename "$1")" = "patch-b.mjs" ] && [ "${FAIL_PATCH_B:-0}" = "1" ]; then
  exit 9
fi
EOF
chmod +x "$TMP/node"
touch "$TMP/patches/patch-b.mjs" "$TMP/patches/patch-a.mjs" "$TMP/patches/patch-a.test.mjs"

PATCH_LOG="$TMP/success.log" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"
test "$(sed -n '1p' "$TMP/success.log")" = "patch-a.mjs"
test "$(sed -n '2p' "$TMP/success.log")" = "patch-b.mjs"
test "$(wc -l < "$TMP/success.log" | tr -d ' ')" = "2"

if PATCH_LOG="$TMP/failure.log" FAIL_PATCH_B=1 HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"; then
  echo "Expected patch failure to stop the runner" >&2
  exit 1
fi

echo "apply-openclaw-patches tests passed"
