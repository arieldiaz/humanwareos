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
  printf '%s' "${TEST_OPENCLAW_VERSION:-2026.7.1-2}"
  exit 0
fi
basename "$1" >> "$PATCH_LOG"
if [ -n "${PATCH_ENV_LOG:-}" ]; then
  printf '%s\n' "${OPENCLAW_PACKAGE_ROOT:-missing}|${OPENCLAW_CORE_DIST:-missing}" >> "$PATCH_ENV_LOG"
fi
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

touch "$TMP/patches/patch-2026.7.1-prompt-boilerplate.mjs" "$TMP/patches/patch-2026.7.1-slack-rich-text.mjs" "$TMP/patches/patch-2026.9.1-prompt-annotation-race.mjs" "$TMP/patches/patch-2026.9.1-manual-cancel-notify.mjs" "$TMP/patches/patch-2026.9.1-conversation-lifecycle-fence.mjs" "$TMP/patches/patch-2026.9.1-cli-commentary-projection.mjs" "$TMP/patches/patch-2026.9.1-slack-response-reliability.mjs" "$TMP/patches/patch-2026.9.1-final-envelope.mjs" "$TMP/patches/patch-2026.9.1-codex-runtime-reliability.mjs" "$TMP/patches/patch-2026.9.1-slack-channel-thread.mjs"
PATCH_LOG="$TMP/modern.log" PATCH_ENV_LOG="$TMP/env.log" TEST_OPENCLAW_VERSION=2026.9.1 OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"
test "$(sed -n '1p' "$TMP/modern.log")" = "patch-2026.7.1-prompt-boilerplate.mjs"
test "$(sed -n '2p' "$TMP/modern.log")" = "patch-2026.9.1-prompt-annotation-race.mjs"
test "$(sed -n '3p' "$TMP/modern.log")" = "patch-2026.7.1-slack-rich-text.mjs"
test "$(sed -n '4p' "$TMP/modern.log")" = "patch-2026.9.1-manual-cancel-notify.mjs"
test "$(sed -n '5p' "$TMP/modern.log")" = "patch-2026.9.1-conversation-lifecycle-fence.mjs"
test "$(sed -n '6p' "$TMP/modern.log")" = "patch-2026.9.1-cli-commentary-projection.mjs"
test "$(sed -n '7p' "$TMP/modern.log")" = "patch-2026.9.1-slack-response-reliability.mjs"
test "$(sed -n '10p' "$TMP/modern.log")" = "patch-2026.9.1-final-envelope.mjs"
test "$(sed -n '8p' "$TMP/modern.log")" = "patch-2026.9.1-codex-runtime-reliability.mjs"
test "$(sed -n '9p' "$TMP/modern.log")" = "patch-2026.9.1-slack-channel-thread.mjs"
test "$(wc -l < "$TMP/modern.log" | tr -d ' ')" = "10"
test "$(sed -n '1p' "$TMP/env.log")" = "$TMP/openclaw|$TMP/openclaw/dist"
if PATCH_LOG="$TMP/unsupported.log" TEST_OPENCLAW_VERSION=2026.9.2 OPENCLAW_PACKAGE_ROOT="$TMP/openclaw" HUMANWARE_OPENCLAW_PATCH_DIR="$TMP/patches" NODE_BIN="$TMP/node" "$ROOT/scripts/apply-openclaw-patches.sh"; then
  echo "Expected unreviewed runtime version to fail" >&2
  exit 1
fi
test ! -e "$TMP/unsupported.log"
echo "apply-openclaw-patches tests passed"
