#!/usr/bin/env bash
# setup-doppler: create the Doppler projects and per-project read-only
# service tokens for a humanwareos instance (see runbook.md).
#
# Run as YOU — needs a personal CLI session (`doppler login`), because
# project/token management is a human-tier operation; the runtime only
# ever holds the read-only tokens this script issues.
#
# Projects: $PREFIX-core, $PREFIX-agents, $PREFIX-liv, $PREFIX-max.
# Change PREFIX if your Doppler workplace is shared with other projects.
# Doppler creates dev/stg/prd configs by default; humanwareos uses dev + prd
# and leaves stg unused.
#
# Service tokens (one per consumer, config prd, access read) land in
# ~/.config/humanwareos/doppler.env (mode 600, outside the repo — this file is
# the bootstrap tier, see runbook.md § contract point 4):
#   DOPPLER_TOKEN_CORE, DOPPLER_TOKEN_AGENTS  — the app/runtime
#   DOPPLER_TOKEN_LIV                         — liv only
#   DOPPLER_TOKEN_MAX                         — max only
#
# Idempotent: existing projects are kept; a token is only issued if its
# variable is not already in doppler.env (token values are shown once at
# creation, so re-issuing would orphan the old one). Never prints secret
# values — names and counts only.
set -euo pipefail

PREFIX="${HUMANWARE_SECRETS_PREFIX:-humanware}"
TOKEN_FILE="${HUMANWARE_TOKEN_FILE:-$HOME/.config/humanwareos/doppler.env}"
TOKEN_NAME="launchd"

PROJECTS="$PREFIX-core $PREFIX-agents $PREFIX-liv $PREFIX-max"

fail() { echo "setup-doppler: $*" >&2; exit 1; }

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
issue_token DOPPLER_TOKEN_LIV "$PREFIX-liv"
issue_token DOPPLER_TOKEN_MAX "$PREFIX-max"

echo "setup-doppler: done — next: add secrets in the dashboard, then run verify-agents.sh"
