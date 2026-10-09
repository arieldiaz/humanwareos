#!/bin/bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
GUARD="$ROOT/scripts/check-independent-deploy.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
FAKE_PS="$TMP_DIR/fake-ps"

printf '%s\n' '#!/bin/bash' 'case "$2:$4" in' '  200:command=) echo "bash scripts/openclaw-deploy.sh" ;;' '  200:ppid=) echo "300" ;;' '  300:command=) echo "node /opt/homebrew/lib/node_modules/openclaw/openclaw.mjs gateway run" ;;' '  300:ppid=) echo "1" ;;' '  400:command=) echo "zsh" ;;' '  400:ppid=) echo "1" ;;' '  *) exit 1 ;;' 'esac' > "$FAKE_PS"
chmod 700 "$FAKE_PS"

"$GUARD" --test-ps-bin "$FAKE_PS" 400
set +e
refusal=$("$GUARD" --test-ps-bin "$FAKE_PS" 200 2>&1)
status=$?
set -e
[ "$status" -eq 2 ]
case "$refusal" in
  *"direct gateway-descended deployment"*"deploy-once.py launch"*"human-operated Terminal is not required"*) ;;
  *) echo "Gateway-descended deployment was not rejected with the required explanation." >&2; exit 1 ;;
esac

echo "independent deploy ancestry guard: OK"
