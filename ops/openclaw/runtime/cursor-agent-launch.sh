#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SECRET_EXEC=${HUMANWARE_SECRET_EXEC:-$SCRIPT_DIR/secret-exec.sh}
CURSOR_AGENT=${CURSOR_AGENT_BIN:-$HOME/.local/bin/cursor-agent}
JQ_BIN=${JQ_BIN:-/usr/bin/jq}

[ -x "$SECRET_EXEC" ] && [ -x "$CURSOR_AGENT" ] && [ -x "$JQ_BIN" ] || {
  printf '%s\n' "cursor-agent-launch: runtime dependencies are unavailable" >&2
  exit 69
}

response=$(printf '%s\n' '{"protocolVersion":1,"provider":"humanware","ids":["core/CURSOR_API_KEY"]}' | "$SECRET_EXEC")
cursor_api_key=$(printf '%s' "$response" | "$JQ_BIN" -er '.values["core/CURSOR_API_KEY"] | select(type == "string" and length > 0)') || {
  printf '%s\n' "cursor-agent-launch: core/CURSOR_API_KEY is unavailable" >&2
  exit 78
}

export AGENT_CLI_CREDENTIAL_STORE=file
export CURSOR_API_KEY="$cursor_api_key"

args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mode" ] && [ "${2:-}" = "agent" ]; then
    shift 2
    continue
  fi
  args+=("$1")
  shift
done
exec "$CURSOR_AGENT" "${args[@]}"
