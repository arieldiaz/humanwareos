#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

test "$(wc -w < "$ROOT/docs/reply-shape.md")" -le 500
test "$(wc -w < "$ROOT/docs/status-framework.md")" -le 1800
grep -q 'An ordinary answer or completed reversible action ends naturally' "$ROOT/docs/reply-shape.md"
grep -q 'Never append `## Status`, `No action needed.`, a forced CTA, or a closing question' "$ROOT/docs/reply-shape.md"
grep -q 'It never appends a generic `## Status` footer' "$ROOT/docs/status-framework.md"
grep -q 'The reply ends naturally' "$ROOT/docs/status-framework.md"
grep -q 'Completion does not create an ask' "$ROOT/docs/status-framework.md"
grep -q 'An explicit request authorizes reversible work' "$ROOT/docs/permission-model.md"
grep -q 'Apply and verify the requested switch before content work' "$ROOT/docs/channel-runtime.md"
grep -q 'Natural language is the product interface' "$ROOT/docs/channel-runtime.md"
grep -q 'Fix the foundation, never productize a workaround' "$ROOT/AGENTS.md"
test ! -e "$ROOT/docs/approval-discipline.md"
! grep -q 'close every chat message' "$ROOT/docs/status-framework.md"
! grep -q 'short prose keeps only the last' "$ROOT/docs/reply-shape.md"
! grep -q 'Every visible agent post ends with `## Status`' "$ROOT/docs/reply-shape.md" "$ROOT/docs/slack-style.md"

printf '%s\n' "reply-policy: OK"
