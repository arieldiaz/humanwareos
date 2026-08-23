#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

test "$(wc -w < "$ROOT/docs/reply-shape.md")" -le 500
test "$(wc -w < "$ROOT/docs/status-framework.md")" -le 1800
grep -q 'An ordinary result ends naturally' "$ROOT/docs/reply-shape.md"
grep -q 'Never invent a question, choice, standing offer, or close request' "$ROOT/docs/reply-shape.md"
grep -q 'A message with no real transition has no lifecycle header' "$ROOT/docs/status-framework.md"
grep -q 'Completion does not create an ask' "$ROOT/docs/status-framework.md"
grep -q 'An explicit request authorizes reversible work' "$ROOT/docs/permission-model.md"
test ! -e "$ROOT/docs/approval-discipline.md"
! grep -q 'close every chat message' "$ROOT/docs/status-framework.md"
! grep -q 'short prose keeps only the last' "$ROOT/docs/reply-shape.md"

printf '%s\n' "reply-policy: OK"
