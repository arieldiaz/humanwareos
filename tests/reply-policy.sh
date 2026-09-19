#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

test "$(wc -w < "$ROOT/docs/reply-shape.md")" -le 500
test "$(wc -w < "$ROOT/docs/status-framework.md")" -le 1800
grep -q 'An admitted turn has one owner at each stage' "$ROOT/docs/reply-shape.md"
grep -q 'Every execution path, including Liv through Cursor and Max through Codex, receives this contract verbatim' "$ROOT/docs/reply-shape.md"
grep -q 'A substantive answer uses `## TLDR`, optional `## Background`, and `## Next Step`' "$ROOT/docs/reply-shape.md"
grep -q 'The adapter sets it when an inbound turn is accepted' "$ROOT/docs/status-framework.md"
grep -q 'It never appends a generic `## Status` footer' "$ROOT/docs/status-framework.md"
grep -q 'The reply ends naturally' "$ROOT/docs/status-framework.md"
grep -q 'Completion does not create an ask' "$ROOT/docs/status-framework.md"
grep -q 'An explicit request authorizes reversible work' "$ROOT/docs/permission-model.md"
grep -q 'Apply and verify the requested switch before content work' "$ROOT/docs/channel-runtime.md"
test ! -e "$ROOT/docs/approval-discipline.md"
! grep -q 'close every chat message' "$ROOT/docs/status-framework.md"
! grep -q 'short prose keeps only the last' "$ROOT/docs/reply-shape.md"
! grep -q 'Every visible agent post ends with `## Status`' "$ROOT/docs/reply-shape.md" "$ROOT/docs/slack-style.md"
! grep -q 'kickoff\|first agent post.*Goal:' "$ROOT/docs/reply-shape.md"
! grep -q '^## Format' "$ROOT/agents/liv.md" "$ROOT/agents/max.md"

printf '%s\n' "reply-policy: OK"
