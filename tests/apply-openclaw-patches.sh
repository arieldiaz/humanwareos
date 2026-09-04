#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/patches"
mkdir -p "$TMP/openclaw"
printf '%s\n' '{"version":"2026.7.1-2"}' > "$TMP/openclaw/package.json"
cat > "$TMP/node" <<'EOF'
#!/bin/bash
set -euo pipefail
if [ "$1" = "-e" ]; then
  printf '%s' '2026.7.1-2'
  exit 0
fi
basename "$1" >> "$PATCH_LOG"
if [ "$(basename "$1")" = "patch-2026.7.1-b.mjs" ] && [ "${FAIL_PATCH_B:-0}" = "1" ]; then
  exit 9
fi
EOF
chmod +x "$TMP/node"
touch "$TMP/patches/patch-2026.7.1-b.mjs" "$TMP/patches/patch-2026.7.1-a.mjs" "$TMP/patches/patch-2026.7.1-a.test.mjs"

PATCH_LOG="$TMP/success.log" OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"
test "$(sed -n '1p' "$TMP/success.log")" = "patch-2026.7.1-a.mjs"
test "$(sed -n '2p' "$TMP/success.log")" = "patch-2026.7.1-b.mjs"
test "$(wc -l < "$TMP/success.log" | tr -d ' ')" = "2"

if PATCH_LOG="$TMP/failure.log" FAIL_PATCH_B=1 OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"; then
  echo "Expected patch failure to stop the runner" >&2
  exit 1
fi

echo "apply-openclaw-patches tests passed"
