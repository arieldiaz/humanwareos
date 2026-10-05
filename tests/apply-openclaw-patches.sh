#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/patches"
mkdir -p "$TMP/openclaw"
printf '%s\n' '{"version":"2026.9.8"}' > "$TMP/openclaw/package.json"
cat > "$TMP/node" <<'EOF'
#!/bin/bash
set -euo pipefail
if [ "$1" = "-e" ]; then
  printf '%s' "${TEST_OPENCLAW_VERSION:-2026.9.8}"
  exit 0
fi
basename "$1" >> "$PATCH_LOG"
if [ -n "${PATCH_ENV_LOG:-}" ]; then
  printf '%s\n' "${OPENCLAW_PACKAGE_ROOT:-missing}|${OPENCLAW_CORE_DIST:-missing}" >> "$PATCH_ENV_LOG"
fi
if [ "$(basename "$1")" = "patch-2026.9.8-b.mjs" ] && [ "${FAIL_PATCH_B:-0}" = "1" ]; then
  exit 9
fi
EOF
chmod +x "$TMP/node"
touch "$TMP/patches/patch-2026.9.8-b.mjs" "$TMP/patches/patch-2026.9.8-a.mjs" "$TMP/patches/patch-2026.9.8-a.test.mjs"

PATCH_LOG="$TMP/success.log" OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"
test "$(sed -n '1p' "$TMP/success.log")" = "patch-2026.9.8-a.mjs"
test "$(sed -n '2p' "$TMP/success.log")" = "patch-2026.9.8-b.mjs"
test "$(wc -l < "$TMP/success.log" | tr -d ' ')" = "2"

if PATCH_LOG="$TMP/failure.log" FAIL_PATCH_B=1 OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"; then
  echo "Expected patch failure to stop the runner" >&2
  exit 1
fi

PATCH_LOG="$TMP/env-run.log" PATCH_ENV_LOG="$TMP/env.log" OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"
test "$(sed -n '1p' "$TMP/env.log")" = "$TMP/openclaw|$TMP/openclaw/dist"
if PATCH_LOG="$TMP/unsupported.log" TEST_OPENCLAW_VERSION=2026.9.1 OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"; then
  echo "Expected unreviewed runtime version to fail" >&2
  exit 1
fi
test ! -e "$TMP/unsupported.log"
echo "apply-openclaw-patches tests passed"
