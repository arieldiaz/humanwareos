#!/usr/bin/env bash
# setup-doppler: create the Doppler projects and per-project read-only
# service tokens for a humanwareos instance (see runbook.md).
#
# Usage: setup-doppler.sh <instance-dir>
# The instance directory holds humanware.instance.json; its `agents` array
# names the per-agent projects.
#
# Run as YOU — needs a personal CLI session (`doppler login`), because
# project/token management is a human-tier operation; the runtime only
# ever holds the read-only tokens this script issues.
#
# Projects: $PREFIX-core, $PREFIX-agents, and $PREFIX-<agent> per agent.
# Set HUMANWARE_SECRETS_PREFIX if your Doppler workplace is shared with other
# projects. Doppler creates dev/stg/prd configs by default; humanwareos uses
# dev + prd and leaves stg unused.
#
# Service tokens (one per consumer, config prd, access read) land in
# ~/.config/humanwareos/doppler.env (mode 600, outside the repo — this file is
# the bootstrap tier, see runbook.md § contract point 4):
#   DOPPLER_TOKEN_CORE, DOPPLER_TOKEN_AGENTS  — the app/runtime
#   DOPPLER_TOKEN_<AGENT>                     — that agent only
#
# Idempotent: existing projects are kept; a token is only issued if its
# variable is not already in doppler.env (token values are shown once at
# creation, so re-issuing would orphan the old one). Never prints secret
# values — names and counts only.
set -euo pipefail

INSTANCE_DIR="${1:?usage: setup-doppler.sh <instance-dir>}"
PREFIX="${HUMANWARE_SECRETS_PREFIX:-humanware}"
TOKEN_FILE="${HUMANWARE_TOKEN_FILE:-$HOME/.config/humanwareos/doppler.env}"
TOKEN_NAME="launchd"

fail() { echo "setup-doppler: $*" >&2; exit 1; }

MANIFEST="$INSTANCE_DIR/humanware.instance.json"
[ -f "$MANIFEST" ] || fail "no humanware.instance.json in $INSTANCE_DIR"
command -v jq >/dev/null 2>&1 || fail "jq is required"
AGENTS="$(jq -r '.agents[]' "$MANIFEST")"
[ -n "$AGENTS" ] || fail "manifest declares no agents"

token_var() { printf 'DOPPLER_TOKEN_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"; }

PROJECTS="$PREFIX-core $PREFIX-agents"
for agent in $AGENTS; do PROJECTS="$PROJECTS $PREFIX-$agent"; done

doppler me >/dev/null 2>&1 || fail "doppler CLI has no session — run: doppler login"

for p in $PROJECTS; do
  if doppler projects get "$p" >/dev/null 2>&1; then
    echo "setup-doppler: project $p exists"
  else
    doppler projects create "$p" >/dev/null
    echo "setup-doppler: created project $p"
  fi
  for c in dev prd; do
    doppler configs get --project "$p" --config "$c" >/dev/null 2>&1 \
      || fail "project $p is missing config $c (non-default environments?)"
  done
done

mkdir -p "$(dirname "$TOKEN_FILE")"
umask 077
touch "$TOKEN_FILE"

issue_token() {
  local var="$1" project="$2"
  if grep -q "^${var}=" "$TOKEN_FILE"; then
    echo "setup-doppler: $var already in $TOKEN_FILE — keeping it"
    return 0
  fi
  local value
  value="$(doppler configs tokens create "$TOKEN_NAME" \
    --project "$project" --config prd --access read --plain)"
  [ -n "$value" ] || fail "token creation returned nothing for $project"
  printf '%s=%s\n' "$var" "$value" >>"$TOKEN_FILE"
  echo "setup-doppler: issued $var (project $project, config prd, read-only)"
}

issue_token DOPPLER_TOKEN_CORE "$PREFIX-core"
issue_token DOPPLER_TOKEN_AGENTS "$PREFIX-agents"
for agent in $AGENTS; do issue_token "$(token_var "$agent")" "$PREFIX-$agent"; done

echo "setup-doppler: done — next: add secrets in the dashboard, then run verify-agents.sh $INSTANCE_DIR"
