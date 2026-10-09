#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DEPLOY="$ROOT/scripts/openclaw-deploy.sh"

test -x "$DEPLOY"
grep -q '^PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin$' "$DEPLOY"
grep -Fq '/usr/bin/python3 "$DEPLOY_ROOT/scripts/deploy-once.py" check "$$" "${XPC_SERVICE_NAME:-}"' "$DEPLOY"
grep -Fq '"$DEPLOY_ROOT/scripts/check-independent-deploy.sh"' "$DEPLOY"
grep -Fq 'OPENCLAW_CUTOVER="$FRAMEWORK_DIR/scripts/openclaw-cutover.sh"' "$DEPLOY"
grep -Fq 'PREPARED=$("$OPENCLAW_CUTOVER" prepare "$FRAMEWORK_DIR" "$INSTANCE_DIR")' "$DEPLOY"
grep -Fq '"$OPENCLAW_CUTOVER" activate "$PREPARED" "$APPROVAL_FILE"' "$DEPLOY"
grep -Fq 'rev-parse origin/main' "$DEPLOY"
! grep -Eq 'apply-config|verify-runtime|install-launchagents|stop_state_writers|backup-state|doctor' "$DEPLOY"

set +e
refusal=$(/usr/bin/env XPC_SERVICE_NAME=com.example.manual-deploy.test "$DEPLOY" --apply "$ROOT" "$ROOT" 2>&1)
refusal_status=$?
set -e
[ "$refusal_status" -eq 2 ]
case "$refusal" in
  *"launchctl submit creates an inferred keepalive service"*) ;;
  *) echo "deploy did not explain the launchctl-submitted job refusal" >&2; exit 1 ;;
esac

bash "$ROOT/tests/check-independent-deploy.sh"
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 "$ROOT/tests/test_deploy_once.py"

echo "deploy delegation: OK"
