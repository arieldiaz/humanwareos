#!/bin/bash
set -euo pipefail
trap 'echo "Deploy stopped at scripts/openclaw-deploy.sh:$LINENO: $BASH_COMMAND" >&2' ERR

PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
DEPLOY_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)  # the framework checkout

if [ "$#" -lt 3 ] || [ "$1" != "--apply" ]; then
  echo "Usage: $0 --apply FRAMEWORK_DIR INSTANCE_DIR --approval-file ABSOLUTE_PATH [--openclaw-version EXACT_VERSION]" >&2
  exit 2
fi
FRAMEWORK_DIR=$(/bin/sh -c 'CDPATH= cd -- "$1" && pwd' sh "$2")
INSTANCE_DIR=$(/bin/sh -c 'CDPATH= cd -- "$1" && pwd' sh "$3")
shift 3
APPROVAL_FILE=""
REQUESTED_VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --approval-file)
      [ "$#" -ge 2 ] && [ -z "$APPROVAL_FILE" ] || exit 2
      APPROVAL_FILE=$2
      shift 2
      ;;
    --openclaw-version)
      [ "$#" -ge 2 ] && [ -z "$REQUESTED_VERSION" ] || exit 2
      REQUESTED_VERSION=$2
      shift 2
      ;;
    *) echo "Unknown deployment option: $1" >&2; exit 2 ;;
  esac
done

/usr/bin/python3 "$DEPLOY_ROOT/scripts/deploy-once.py" check "$$" "${XPC_SERVICE_NAME:-}"
"$DEPLOY_ROOT/scripts/check-independent-deploy.sh"

case "$APPROVAL_FILE" in
  /*) ;;
  *) echo "Deployment refused: a fresh absolute --approval-file is required." >&2; exit 77 ;;
esac
test -z "$(git -C "$FRAMEWORK_DIR" status --porcelain)"
test -z "$(git -C "$INSTANCE_DIR" status --porcelain)"
test "$(git -C "$FRAMEWORK_DIR" branch --show-current)" = main
test "$(git -C "$INSTANCE_DIR" branch --show-current)" = main
test "$(git -C "$FRAMEWORK_DIR" rev-parse HEAD)" = "$(git -C "$FRAMEWORK_DIR" rev-parse origin/main)"
test "$(git -C "$INSTANCE_DIR" rev-parse HEAD)" = "$(git -C "$INSTANCE_DIR" rev-parse origin/main)"

PINNED_VERSION=$(/usr/bin/jq -r .openclaw.version "$INSTANCE_DIR/humanware.instance.json")
[ -z "$REQUESTED_VERSION" ] || [ "$REQUESTED_VERSION" = "$PINNED_VERSION" ] || {
  echo "Requested OpenClaw $REQUESTED_VERSION does not match the instance pin $PINNED_VERSION." >&2
  exit 2
}

OPENCLAW_CUTOVER="$FRAMEWORK_DIR/scripts/openclaw-cutover.sh"
test -x "$OPENCLAW_CUTOVER"
PREPARED=$("$OPENCLAW_CUTOVER" prepare "$FRAMEWORK_DIR" "$INSTANCE_DIR")
"$OPENCLAW_CUTOVER" activate "$PREPARED" "$APPROVAL_FILE"
