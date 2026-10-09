#!/bin/sh
# Hydrate secrets into the environment, then exec a command.
#
#   secret-env-exec.sh ENV=scope/KEY [ENV?=scope/KEY ...] -- command [args...]
#
# Each spec names the environment variable to export and the secret-exec id
# (Doppler scope and key) that fills it. A plain spec is required: the run
# stops with exit 78 (EX_CONFIG) when it cannot be resolved. A "?=" spec is
# optional. An environment variable that already holds a non-empty value is
# kept and not fetched, so the first spec that resolves wins; later specs for
# the same variable act as fallbacks. Values travel only through environment
# variables, never through arguments or logs.
#
# The bootstrap file is HUMANWARE_DOPPLER_ENV_FILE, as for secret-exec.sh.
set -eu

JQ_BIN=${JQ_BIN:-/usr/bin/jq}
SECRET_EXEC=${HUMANWARE_SECRET_EXEC:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/secret-exec.sh}

usage() {
  printf '%s\n' "usage: secret-env-exec.sh ENV=scope/KEY [ENV?=scope/KEY ...] -- command [args...]" >&2
  exit 64
}

specs=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    *=*/*) specs="$specs $1" ;;
    *) usage ;;
  esac
  shift
done
[ -n "$specs" ] && [ "$#" -gt 0 ] || usage

spec_name() { printf '%s' "${1%%=*}" | /usr/bin/sed 's/?$//'; }
spec_id() { printf '%s' "${1#*=}"; }
valid_name() { case "$1" in ''|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;; esac; }
is_set() { eval "[ -n \"\${$1:-}\" ]"; }

ids=
for spec in $specs; do
  name=$(spec_name "$spec")
  valid_name "$name" || { printf 'secret-env-exec: invalid variable name in %s\n' "$spec" >&2; exit 64; }
  is_set "$name" || ids="$ids $(spec_id "$spec")"
done

values='{}'
if [ -n "$ids" ]; then
  request=$(printf '%s\n' $ids | "$JQ_BIN" -Rcs '{protocolVersion: 1, ids: (split("\n") | map(select(length > 0)))}')
  values=$(printf '%s' "$request" | "$SECRET_EXEC") || values='{}'
fi

for spec in $specs; do
  name=$(spec_name "$spec")
  is_set "$name" && continue
  id=$(spec_id "$spec")
  value=$(printf '%s' "$values" | "$JQ_BIN" -r --arg id "$id" '.values[$id] // empty')
  if [ -n "$value" ]; then
    export "$name=$value"
  elif [ "${spec%%=*}" = "$name" ]; then
    printf 'secret-env-exec: required secret %s is unavailable\n' "$id" >&2
    exit 78
  fi
done
unset values value request ids specs spec name id

exec "$@"
