#!/bin/sh
set -eu

usage() {
  printf '%s\n' "Usage: $0 FRAMEWORK_DIR INSTANCE_DIR"
}

[ "$#" -eq 2 ] || {
  usage >&2
  exit 2
}

FRAMEWORK_DIR=$(CDPATH= cd -- "$1" && pwd)
INSTANCE_DIR=$(CDPATH= cd -- "$2" && pwd)
JQ=${JQ:-/usr/bin/jq}

[ -x "$JQ" ] || {
  printf '%s\n' "validate-instance: jq is required" >&2
  exit 2
}

required_files='humanware.lock.json humanware.instance.json runtime/profiles.json'
for relative in $required_files; do
  [ -f "$INSTANCE_DIR/$relative" ] || {
    printf 'validate-instance: missing %s\n' "$relative" >&2
    exit 1
  }
  "$JQ" -e . "$INSTANCE_DIR/$relative" >/dev/null
done

"$JQ" -e '
  .schemaVersion == 1 and
  (.id | type == "string" and length > 0) and
  (.paths.dataRoot | startswith("/")) and
  (.paths.runtimeRoot | startswith("/")) and
  (.paths.worktreeRoot | startswith("/")) and
  (.agents | type == "array" and length > 0)
' "$INSTANCE_DIR/humanware.instance.json" >/dev/null || {
  printf '%s\n' "validate-instance: invalid humanware.instance.json" >&2
  exit 1
}

DATA_ROOT=$($JQ -r '.paths.dataRoot' "$INSTANCE_DIR/humanware.instance.json")
RUNTIME_ROOT=$($JQ -r '.paths.runtimeRoot' "$INSTANCE_DIR/humanware.instance.json")
WORKTREE_ROOT=$($JQ -r '.paths.worktreeRoot' "$INSTANCE_DIR/humanware.instance.json")

for external_path in "$DATA_ROOT" "$RUNTIME_ROOT" "$WORKTREE_ROOT"; do
  case "$external_path" in
    "$INSTANCE_DIR"|"$INSTANCE_DIR"/*|"$FRAMEWORK_DIR"|"$FRAMEWORK_DIR"/*)
      printf 'validate-instance: external path is inside a source checkout: %s\n' "$external_path" >&2
      exit 1
      ;;
  esac
done

"$JQ" -e '
  .schemaVersion == 2 and
  (.defaultProfile | type == "string") and
  (.profiles[.defaultProfile] != null) and
  (.agents | type == "object") and
  ([.agents[] | .allowedProfiles[]] | all(. as $id | $id != null)) and
  ([.profiles[] | .executionMode] | all(. == "general" or . == "task" or . == "workspace")) and
  ([.profiles[] | .runtime] | all(. == "native" or . == "cli" or . == "acp" or . == "app-server"))
' "$INSTANCE_DIR/runtime/profiles.json" >/dev/null || {
  printf '%s\n' "validate-instance: invalid runtime/profiles.json" >&2
  exit 1
}

"$JQ" -e '
  .profiles as $profiles |
  [.agents[] | .allowedProfiles[]] |
  all(. as $id | $profiles[$id] != null)
' "$INSTANCE_DIR/runtime/profiles.json" >/dev/null || {
  printf '%s\n' "validate-instance: agent references an unknown execution profile" >&2
  exit 1
}

for profile_file in "$INSTANCE_DIR"/channels/*.json "$INSTANCE_DIR"/surfaces/*.json; do
  [ -e "$profile_file" ] || continue
  "$JQ" -e '.schemaVersion == 1 and (.id | type == "string" and length > 0)' "$profile_file" >/dev/null || {
    printf 'validate-instance: invalid profile %s\n' "$profile_file" >&2
    exit 1
  }
done

if git -C "$INSTANCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  forbidden=$(git -C "$INSTANCE_DIR" ls-files | /usr/bin/awk '/^(evidence|current|working|artifacts|generated|operations|memory|sessions|workspaces|stream|derived|cache)\// { print }')
  [ -z "$forbidden" ] || {
    printf '%s\n%s\n' "validate-instance: data-plane content is tracked in the instance:" "$forbidden" >&2
    exit 1
  }
  secret_files=$(git -C "$INSTANCE_DIR" ls-files | /usr/bin/awk '/(^|\/)\.env$|(^|\/)(credentials|secrets)\.json$/ { print }')
  [ -z "$secret_files" ] || {
    printf '%s\n%s\n' "validate-instance: secret-shaped files are tracked:" "$secret_files" >&2
    exit 1
  }
fi

LOCKED_REVISION=$($JQ -r '.revision' "$INSTANCE_DIR/humanware.lock.json")
if CURRENT_REVISION=$(git -C "$FRAMEWORK_DIR" rev-parse HEAD 2>/dev/null); then
  :
else
  CURRENT_REVISION=unknown
fi
if [ "$LOCKED_REVISION" != "$CURRENT_REVISION" ] && [ "${HUMANWARE_ALLOW_UNLOCKED:-0}" != 1 ]; then
  printf 'validate-instance: framework HEAD %s does not match lock %s\n' "$CURRENT_REVISION" "$LOCKED_REVISION" >&2
  exit 1
fi

if [ "$CURRENT_REVISION" != unknown ] && [ "${HUMANWARE_ALLOW_DIRTY_SOURCE:-0}" != 1 ]; then
  [ -z "$(git -C "$FRAMEWORK_DIR" status --porcelain)" ] || {
    printf '%s\n' "validate-instance: framework checkout is dirty" >&2
    exit 1
  }
fi

printf 'validate-instance: OK framework=%s instance=%s data=%s\n' "$CURRENT_REVISION" "$INSTANCE_DIR" "$DATA_ROOT"
