#!/usr/bin/env bash
# verify-agents: prove the per-project isolation and integration health of
# the read-only service tokens in ~/.config/humanwareos/doppler.env.
#
# Per token: it must read its OWN project, and must FAIL to read every
# other project (a Doppler service token is scoped to one project+config —
# this failure IS the per-agent isolation guarantee, so it gets verified,
# not assumed). Per agent: one harmless authenticated call per service
# (Slack auth.test, Notion users/me), skipped when the key isn't set.
# Prints PASS/FAIL/SKIP per check. Never prints secret values.
#
# Run after any token or project change. It must always pass.
set -uo pipefail

PREFIX="${HUMANWARE_SECRETS_PREFIX:-humanware}"
DOPPLER_ENV_FILE="${HUMANWARE_TOKEN_FILE:-$HOME/.config/humanwareos/doppler.env}"
DOPPLER_BIN="$(command -v doppler || echo /opt/homebrew/bin/doppler)"

if [ ! -x "$DOPPLER_BIN" ] || [ ! -f "$DOPPLER_ENV_FILE" ]; then
  echo "verify-agents: needs the doppler CLI and $DOPPLER_ENV_FILE (run setup-doppler.sh first)." >&2
  exit 1
fi

dtok() { grep "^$1=" "$DOPPLER_ENV_FILE" | cut -d= -f2-; }

FAILURES=0

dp() { DOPPLER_TOKEN="$1" "$DOPPLER_BIN" "${@:2}" --no-check-version; }

check_scoping() {
  local label="$1" token="$2" own_count other
  shift 2

  own_count="$(dp "$token" secrets --only-names --json 2>/dev/null \
    | jq -r 'if type == "array" then .[] else keys[] end' | grep -cv '^DOPPLER_')"
  if [ "${own_count:-0}" -gt 0 ]; then
    echo "PASS  $label read     (own project readable, $own_count keys)"
  else
    echo "FAIL  $label read     (cannot read own project)"
    FAILURES=$((FAILURES + 1))
  fi

  for other in "$@"; do
    if dp "$token" secrets --only-names --project "$other" --config prd >/dev/null 2>&1; then
      echo "FAIL  $label scoping  (token CAN read $other — permissions too broad)"
      FAILURES=$((FAILURES + 1))
    else
      echo "PASS  $label scoping  (cannot read $other)"
    fi
  done
}

check_slack() {
  local agent="$1" token="$2" ok
  if [ -z "$token" ]; then
    echo "SKIP  $agent slack    (no SLACK_BOT_TOKEN in this project)"
    return 0
  fi
  ok=$(curl -s https://slack.com/api/auth.test -H "Authorization: Bearer $token" | jq -r '.ok')
  if [ "$ok" = "true" ]; then
    echo "PASS  $agent slack"
  else
    echo "FAIL  $agent slack    (auth.test rejected the token)"
    return 1
  fi
}

check_notion() {
  local agent="$1" token="$2" obj
  if [ -z "$token" ]; then
    echo "SKIP  $agent notion   (no per-agent NOTION_TOKEN — shared token or none)"
    return 0
  fi
  obj=$(curl -s https://api.notion.com/v1/users/me \
    -H "Authorization: Bearer $token" -H "Notion-Version: 2022-06-28" | jq -r '.object')
  if [ "$obj" = "user" ]; then
    echo "PASS  $agent notion"
  else
    echo "FAIL  $agent notion   (users/me rejected the token)"
    return 1
  fi
}

verify_agent() {
  local agent="$1" var="$2" other_project="$3"
  local token slack_token notion_token

  token="$(dtok "$var")"
  if [ -z "$token" ]; then
    echo "FAIL  $agent identity ($var not in $DOPPLER_ENV_FILE)"
    FAILURES=$((FAILURES + 1))
    return
  fi

  check_scoping "$agent" "$token" "$other_project"

  slack_token="$(dp "$token" secrets get SLACK_BOT_TOKEN --plain 2>/dev/null)" || slack_token=""
  notion_token="$(dp "$token" secrets get NOTION_TOKEN --plain 2>/dev/null)" || notion_token=""
  case "$slack_token" in TODO-*) slack_token="" ;; esac
  case "$notion_token" in TODO-*) notion_token="" ;; esac

  check_slack "$agent" "$slack_token" || FAILURES=$((FAILURES + 1))
  check_notion "$agent" "$notion_token" || FAILURES=$((FAILURES + 1))
}

app_token() {
  local label="$1" var="$2" token
  shift 2
  token="$(dtok "$var")"
  if [ -z "$token" ]; then
    echo "FAIL  $label identity ($var not in $DOPPLER_ENV_FILE)"
    FAILURES=$((FAILURES + 1))
    return
  fi
  check_scoping "$label" "$token" "$@"
}

app_token core DOPPLER_TOKEN_CORE "$PREFIX-liv" "$PREFIX-max"
app_token agents DOPPLER_TOKEN_AGENTS "$PREFIX-liv" "$PREFIX-max"
verify_agent liv DOPPLER_TOKEN_LIV "$PREFIX-max"
verify_agent max DOPPLER_TOKEN_MAX "$PREFIX-liv"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "verify-agents: ALL PASS"
else
  echo "verify-agents: $FAILURES failure(s)"
  exit 1
fi
