#!/bin/bash
set -euo pipefail

PS_BIN=/bin/ps
START_PID=$PPID
if [ "$#" -eq 3 ] && [ "$1" = "--test-ps-bin" ]; then
  PS_BIN=$2
  START_PID=$3
elif [ "$#" -ne 0 ]; then
  echo "Usage: $0 [--test-ps-bin ABSOLUTE_PATH START_PID]" >&2
  exit 2
fi

case "$PS_BIN" in
  /*) ;;
  *) echo "Deployment ancestry check requires an absolute ps path." >&2; exit 2 ;;
esac
case "$START_PID" in
  ''|*[!0-9]*) echo "Deployment ancestry check requires a numeric start PID." >&2; exit 2 ;;
esac

pid=$START_PID
depth=0
while [ "$pid" -gt 1 ] && [ "$depth" -lt 64 ]; do
  if ! command_line=$("$PS_BIN" -p "$pid" -o command= 2>/dev/null); then
    break
  fi
  case "$command_line" in
    *openclaw.mjs\ gateway*|*openclaw\ gateway*)
      echo "Refusing direct gateway-descended deployment: stopping the gateway would terminate the cutover before rollback or restart. After fresh human approval, use scripts/deploy-once.py launch; it records the approval and hands the cutover to an independent one-shot job. A human-operated Terminal is not required." >&2
      exit 2
      ;;
  esac
  if ! parent_pid=$("$PS_BIN" -p "$pid" -o ppid= 2>/dev/null); then
    break
  fi
  parent_pid=${parent_pid//[[:space:]]/}
  case "$parent_pid" in
    ''|*[!0-9]*) break ;;
  esac
  [ "$parent_pid" -ne "$pid" ] || break
  pid=$parent_pid
  depth=$((depth + 1))
done
