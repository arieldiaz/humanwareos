#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HELPER="$ROOT/ops/openclaw/runtime/secret-env-exec.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

# A fake Doppler CLI: DOPPLER_TOKEN selects the scope, the key selects the value.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/doppler" <<'FAKE'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LOG"
[ "$1" = secrets ] && [ "$2" = get ] || exit 1
case "$DOPPLER_TOKEN:$3" in
  tok-liv:SLACK_BOT_TOKEN) printf 'liv-slack-value\n' ;;
  tok-max:SLACK_BOT_TOKEN) printf 'max-slack-value\n' ;;
  tok-agents:RESEND_API_KEY) printf 'agents-resend-value\n' ;;
  *) exit 1 ;;
esac
FAKE
chmod 755 "$WORK/bin/doppler"
printf 'DOPPLER_TOKEN_LIV=tok-liv\nDOPPLER_TOKEN_MAX=tok-max\nDOPPLER_TOKEN_AGENTS=tok-agents\nDOPPLER_TOKEN_CORE=tok-core\n' > "$WORK/doppler.env"
chmod 600 "$WORK/doppler.env"
export DOPPLER_BIN="$WORK/bin/doppler" HUMANWARE_DOPPLER_ENV_FILE="$WORK/doppler.env" FAKE_LOG="$WORK/doppler.log"
: > "$FAKE_LOG"

# Required and renamed keys are exported; values never appear in arguments.
out=$("$HELPER" SLACK_BOT_TOKEN=liv/SLACK_BOT_TOKEN MAX_TOKEN=max/SLACK_BOT_TOKEN -- /bin/sh -c 'printf "%s|%s|%s" "$SLACK_BOT_TOKEN" "$MAX_TOKEN" "$0 $*"' arg1 arg2)
[ "$out" = "liv-slack-value|max-slack-value|arg1 arg2" ] || { printf 'unexpected exports: %s\n' "$out" >&2; exit 1; }

# A required secret that cannot be resolved stops the run before exec.
if "$HELPER" MISSING=core/NOPE -- /bin/sh -c 'exit 0' 2>/dev/null; then
  printf '%s\n' "missing required secret must fail" >&2; exit 1
fi
status=0; "$HELPER" MISSING=core/NOPE -- /bin/sh -c 'exit 0' 2>/dev/null || status=$?
[ "$status" -eq 78 ] || { printf 'expected exit 78, got %s\n' "$status" >&2; exit 1; }

# An optional secret that cannot be resolved is simply absent.
out=$("$HELPER" SLACK_BOT_TOKEN=liv/SLACK_BOT_TOKEN OPTIONAL?=core/NOPE -- /bin/sh -c 'printf "%s|%s" "$SLACK_BOT_TOKEN" "${OPTIONAL-unset}"')
[ "$out" = "liv-slack-value|unset" ] || { printf 'unexpected optional handling: %s\n' "$out" >&2; exit 1; }

# Fallback chain: the first spec that resolves wins.
out=$("$HELPER" RESEND_API_KEY?=core/RESEND_API_KEY RESEND_API_KEY?=agents/RESEND_API_KEY -- /bin/sh -c 'printf "%s" "$RESEND_API_KEY"')
[ "$out" = "agents-resend-value" ] || { printf 'unexpected fallback: %s\n' "$out" >&2; exit 1; }

# A value already in the environment is kept and not fetched.
: > "$FAKE_LOG"
out=$(RESEND_API_KEY=preset "$HELPER" RESEND_API_KEY?=agents/RESEND_API_KEY -- /bin/sh -c 'printf "%s" "$RESEND_API_KEY"')
[ "$out" = "preset" ] || { printf 'preset value must win: %s\n' "$out" >&2; exit 1; }
[ ! -s "$FAKE_LOG" ] || { printf '%s\n' "preset value must not be fetched" >&2; exit 1; }

# Malformed specs and a missing command are usage errors.
for args in "SLACK_BOT_TOKEN=liv/SLACK_BOT_TOKEN" "-- /bin/true" "1BAD=liv/KEY -- /bin/true" "BAD=nope -- /bin/true"; do
  status=0; "$HELPER" $args 2>/dev/null || status=$?
  [ "$status" -eq 64 ] || { printf 'expected usage error for %s, got %s\n' "$args" "$status" >&2; exit 1; }
done

# Without the bootstrap file the provider fails closed and required keys stop the run.
status=0; HUMANWARE_DOPPLER_ENV_FILE= "$HELPER" SLACK_BOT_TOKEN=liv/SLACK_BOT_TOKEN -- /bin/true 2>/dev/null || status=$?
[ "$status" -eq 78 ] || { printf 'expected exit 78 without bootstrap, got %s\n' "$status" >&2; exit 1; }

printf '%s\n' "secret-env-exec: OK"
