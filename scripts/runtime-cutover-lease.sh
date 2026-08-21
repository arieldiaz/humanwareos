#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 assert-external | acquire LOCK_DIR OWNER_PID [LABEL] | release LOCK_DIR OWNER_PID" >&2
  exit 2
}

assert_external() {
  if [ "${HUMANWARE_GATEWAY_PROCESS:-}" = "1" ]; then
    echo "Control-plane mutation refused from a gateway-descendant process. Run the cutover out of band." >&2
    exit 73
  fi
}

read_owner_pid() {
  file=$1/pid
  [ -f "$file" ] || return 1
  owner=$(/bin/cat "$file")
  case "$owner" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$owner"
}

acquire() {
  lock_dir=$1
  owner_pid=$2
  label=${3:-runtime-cutover}
  parent=$(/usr/bin/dirname "$lock_dir")
  /bin/mkdir -p "$parent"
  /bin/chmod 700 "$parent"

  if ! /bin/mkdir "$lock_dir" 2>/dev/null; then
    existing_pid=$(read_owner_pid "$lock_dir" 2>/dev/null || true)
    if [ -n "$existing_pid" ] && /bin/kill -0 "$existing_pid" 2>/dev/null; then
      echo "Runtime cutover lease is already held by PID $existing_pid: $lock_dir" >&2
      exit 75
    fi
    stamp=$(/bin/date -u +%Y%m%dT%H%M%SZ)
    stale_dir="$lock_dir.stale-$stamp-$$"
    if ! /bin/mv "$lock_dir" "$stale_dir" 2>/dev/null; then
      echo "Runtime cutover lease changed while recovering stale state: $lock_dir" >&2
      exit 75
    fi
    echo "Recovered stale runtime cutover lease as $stale_dir" >&2
    /bin/mkdir "$lock_dir" 2>/dev/null || {
      echo "Runtime cutover lease was acquired concurrently: $lock_dir" >&2
      exit 75
    }
  fi

  /bin/chmod 700 "$lock_dir"
  umask 077
  printf '%s\n' "$owner_pid" > "$lock_dir/pid"
  printf '%s\n' "$label" > "$lock_dir/label"
  /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "$lock_dir/acquired-at"
}

release() {
  lock_dir=$1
  owner_pid=$2
  existing_pid=$(read_owner_pid "$lock_dir" 2>/dev/null || true)
  if [ "$existing_pid" != "$owner_pid" ]; then
    echo "Runtime cutover lease owner mismatch for $lock_dir (expected $owner_pid, found ${existing_pid:-none})" >&2
    exit 76
  fi
  /bin/rm -f "$lock_dir/pid" "$lock_dir/label" "$lock_dir/acquired-at"
  /bin/rmdir "$lock_dir"
}

assert_external
action=${1:-}
case "$action" in
  assert-external)
    [ "$#" -eq 1 ] || usage
    ;;
  acquire)
    [ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage
    acquire "$2" "$3" "${4:-runtime-cutover}"
    ;;
  release)
    [ "$#" -eq 3 ] || usage
    release "$2" "$3"
    ;;
  *) usage ;;
esac
