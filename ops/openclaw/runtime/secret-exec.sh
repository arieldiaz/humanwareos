#!/bin/sh
set -eu

DOPPLER_BIN=${DOPPLER_BIN:-/opt/homebrew/bin/doppler}
JQ_BIN=${JQ_BIN:-$(command -v jq || echo /usr/bin/jq)}
BOOTSTRAP=${HUMANWARE_DOPPLER_ENV_FILE:-}

[ -x "$DOPPLER_BIN" ] && [ -x "$JQ_BIN" ] && [ -n "$BOOTSTRAP" ] && [ -r "$BOOTSTRAP" ] || exit 1
case "$(/usr/bin/stat -f '%Lp' "$BOOTSTRAP")" in
  400|600) ;;
  *) printf '%s\n' "secret-exec: bootstrap file must be mode 400 or 600" >&2; exit 1 ;;
esac

request=$("$JQ_BIN" -ce 'if .protocolVersion == 1 and (.ids | type == "array") then . else error("invalid request") end')
values='{}'
ids=$(printf '%s' "$request" | "$JQ_BIN" -r '.ids[]')
for id in $ids; do
  case "$id" in
    */*) ;;
    *) continue ;;
  esac
  scope=${id%%/*}
  name=${id#*/}
  case "$scope" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  case "$name" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  upper=$(printf '%s' "$scope" | /usr/bin/tr '[:lower:]' '[:upper:]')
  token=$(/usr/bin/awk -F= -v key="DOPPLER_TOKEN_$upper" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$BOOTSTRAP")
  [ -n "$token" ] || continue
  if value=$(DOPPLER_TOKEN="$token" "$DOPPLER_BIN" secrets get "$name" --plain --no-check-version 2>/dev/null); then
    [ -n "$value" ] || continue
    values=$(printf '%s' "$values" | "$JQ_BIN" --arg key "$id" --arg value "$value" '. + {($key): $value}')
  fi
done
printf '%s' "$values" | "$JQ_BIN" -c '{protocolVersion: 1, values: .}'
