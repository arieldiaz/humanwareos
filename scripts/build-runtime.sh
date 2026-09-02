#!/bin/sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 FRAMEWORK_DIR INSTANCE_DIR [--activate]"
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || {
  usage >&2
  exit 2
}

FRAMEWORK_DIR=$(CDPATH= cd -- "$1" && pwd)
INSTANCE_DIR=$(CDPATH= cd -- "$2" && pwd)
ACTIVATE=0
if [ "${3:-}" = "--activate" ]; then
  ACTIVATE=1
elif [ "$#" -eq 3 ]; then
  usage >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
JQ=${JQ:-}
if [ -z "$JQ" ]; then
  JQ=$(command -v jq 2>/dev/null) || {
    printf '%s\n' "build-runtime: jq is required" >&2
    exit 2
  }
fi
NODE_BIN=${NODE_BIN:-}
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null) || {
    printf '%s\n' "build-runtime: node is required" >&2
    exit 2
  }
fi
"$SCRIPT_DIR/validate-instance.sh" "$FRAMEWORK_DIR" "$INSTANCE_DIR"

RUNTIME_ROOT=$($JQ -r '.paths.runtimeRoot' "$INSTANCE_DIR/humanware.instance.json")
DATA_ROOT=$($JQ -r '.paths.dataRoot' "$INSTANCE_DIR/humanware.instance.json")
FRAMEWORK_REVISION=$(git -C "$FRAMEWORK_DIR" rev-parse HEAD)
if INSTANCE_REVISION=$(git -C "$INSTANCE_DIR" rev-parse HEAD 2>/dev/null); then
  :
else
  INSTANCE_REVISION=uncommitted
fi
INSTANCE_CONTENT_HASH=$(
  cd "$INSTANCE_DIR"
  find . -type f ! -name .git ! -path './.git/*' -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done | shasum -a 256 | /usr/bin/awk '{ print $1 }'
)
if [ -n "$(git -C "$INSTANCE_DIR" status --porcelain 2>/dev/null)" ]; then
  INSTANCE_STATE="${INSTANCE_REVISION}-dirty-${INSTANCE_CONTENT_HASH}"
else
  INSTANCE_STATE=$INSTANCE_REVISION
fi
BUILD_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(printf %.12s "$FRAMEWORK_REVISION")-$(printf %.12s "$INSTANCE_REVISION")-$(printf %.12s "$INSTANCE_CONTENT_HASH")"
FINAL_DIR="$RUNTIME_ROOT/runtime/$BUILD_ID"

[ ! -e "$FINAL_DIR" ] || {
  printf 'build-runtime: build already exists: %s\n' "$FINAL_DIR" >&2
  exit 1
}

mkdir -p "$RUNTIME_ROOT/runtime"
BUILD_DIR=$(mktemp -d "$RUNTIME_ROOT/runtime/.build-$BUILD_ID.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM

mkdir -p "$BUILD_DIR/instructions" "$BUILD_DIR/config" "$BUILD_DIR/framework/scripts" "$BUILD_DIR/framework/ops/openclaw/plugins" "$BUILD_DIR/framework/ops/openclaw/patches" "$BUILD_DIR/framework/ops/channels" "$BUILD_DIR/surface"
cp "$FRAMEWORK_DIR/AGENTS.md" "$BUILD_DIR/instructions/AGENTS.md"
cp -R "$FRAMEWORK_DIR/docs" "$BUILD_DIR/instructions/docs"
cp -R "$FRAMEWORK_DIR/agents" "$BUILD_DIR/instructions/agents"
cp -R "$FRAMEWORK_DIR/skills" "$BUILD_DIR/instructions/skills"
cp -R "$FRAMEWORK_DIR/commands" "$BUILD_DIR/instructions/commands"
cp "$FRAMEWORK_DIR/scripts/render-openclaw-runtime-profiles.mjs" "$BUILD_DIR/framework/scripts/render-openclaw-runtime-profiles.mjs"
cp "$FRAMEWORK_DIR/scripts/render-openclaw-agent-context.mjs" "$BUILD_DIR/framework/scripts/render-openclaw-agent-context.mjs"
cp "$FRAMEWORK_DIR/scripts/materialize-openclaw-workspaces.mjs" "$BUILD_DIR/framework/scripts/materialize-openclaw-workspaces.mjs"
cp "$FRAMEWORK_DIR/scripts/apply-openclaw-patches.sh" "$BUILD_DIR/framework/scripts/apply-openclaw-patches.sh"
cp "$FRAMEWORK_DIR/scripts/runtime-cutover-lease.sh" "$BUILD_DIR/framework/scripts/runtime-cutover-lease.sh"
cp "$FRAMEWORK_DIR/scripts/runtime-restart-guard.sh" "$BUILD_DIR/framework/scripts/runtime-restart-guard.sh"
cp -R "$FRAMEWORK_DIR/ops/openclaw/plugins/." "$BUILD_DIR/framework/ops/openclaw/plugins/"
cp -R "$FRAMEWORK_DIR/ops/openclaw/patches/." "$BUILD_DIR/framework/ops/openclaw/patches/"
cp -R "$FRAMEWORK_DIR/ops/channels/." "$BUILD_DIR/framework/ops/channels/"
cp "$FRAMEWORK_DIR/ops/openclaw/slack-spin-out.mjs" "$BUILD_DIR/framework/ops/openclaw/slack-spin-out.mjs"
for component in menubar session-console; do cp -R "$FRAMEWORK_DIR/ops/$component" "$BUILD_DIR/framework/ops/$component"; done
cp "$INSTANCE_DIR/AGENTS-instance.md" "$BUILD_DIR/instructions/AGENTS-instance.md"
cp -R "$INSTANCE_DIR/agents" "$BUILD_DIR/instructions/agent-overlays"
if [ -d "$INSTANCE_DIR/docs" ]; then
  cp -R "$INSTANCE_DIR/docs/." "$BUILD_DIR/instructions/docs/"
fi
cp "$INSTANCE_DIR/humanware.instance.json" "$BUILD_DIR/config/instance.json"
cp "$INSTANCE_DIR/humanware.lock.json" "$BUILD_DIR/config/framework-lock.json"
cp -R "$INSTANCE_DIR/runtime" "$BUILD_DIR/config/runtime"
cp -R "$INSTANCE_DIR/channels" "$BUILD_DIR/config/channels"
cp -R "$INSTANCE_DIR/surfaces" "$BUILD_DIR/config/surfaces"
cp -R "$FRAMEWORK_DIR/surfaces/domain/." "$BUILD_DIR/surface/"
cp "$INSTANCE_DIR/surfaces/domain.json" "$BUILD_DIR/surface/surface.json"
if [ -d "$INSTANCE_DIR/surfaces/static" ]; then
  cp -R "$INSTANCE_DIR/surfaces/static/." "$BUILD_DIR/surface/"
fi
if [ -d "$INSTANCE_DIR/services" ]; then
  cp -R "$INSTANCE_DIR/services" "$BUILD_DIR/config/services"
fi
if [ -d "$INSTANCE_DIR/ops" ]; then
  cp -R "$INSTANCE_DIR/ops" "$BUILD_DIR/config/ops"
fi

"$NODE_BIN" "$FRAMEWORK_DIR/scripts/render-openclaw-agent-context.mjs" "$BUILD_DIR"

cat > "$BUILD_DIR/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "buildId": "$BUILD_ID",
  "createdAt": "$(date -u +%FT%TZ)",
  "frameworkRevision": "$FRAMEWORK_REVISION",
  "instanceRevision": "$INSTANCE_REVISION",
  "instanceState": "$INSTANCE_STATE",
  "instanceContentSha256": "$INSTANCE_CONTENT_HASH",
  "dataRoot": "$DATA_ROOT",
  "mutableStateIncluded": false
}
EOF

(cd "$BUILD_DIR" && find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done > SHA256SUMS)
(cd "$BUILD_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null)

mv "$BUILD_DIR" "$FINAL_DIR"
trap - EXIT HUP INT TERM

if [ "$ACTIVATE" -eq 1 ]; then
  NEXT_LINK="$RUNTIME_ROOT/.current-$BUILD_ID"
  ln -s "$FINAL_DIR" "$NEXT_LINK"
  mv -h -f "$NEXT_LINK" "$RUNTIME_ROOT/current"
fi

printf 'build-runtime: built %s\n' "$FINAL_DIR"
[ "$ACTIVATE" -eq 0 ] || printf 'build-runtime: active %s\n' "$RUNTIME_ROOT/current"
