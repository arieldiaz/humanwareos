#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

test "$(wc -w < "$ROOT/docs/reply-shape.md")" -le 500
test "$(wc -w < "$ROOT/docs/status-framework.md")" -le 1800
test "$(wc -w < "$ROOT/AGENTS.md")" -le 1400
for file in "$ROOT"/agents/*.md "$ROOT"/skills/*/SKILL.md; do test "$(wc -w < "$file")" -le 250; done
grep -q 'The control plane marks an admitted turn `working`' "$ROOT/docs/reply-shape.md"
grep -q 'Every execution path receives this contract verbatim' "$ROOT/docs/reply-shape.md"
grep -q 'A substantive answer uses `## TLDR`, optional `## Background`, and `## Next Step`' "$ROOT/docs/reply-shape.md"
grep -q 'The adapter writes `working` when it admits a human turn' "$ROOT/docs/status-framework.md"
grep -q 'The canonical enum has exactly four values' "$ROOT/docs/status-framework.md"
grep -q 'A question is content, not a lifecycle phase' "$ROOT/docs/status-framework.md"
grep -q 'A normal `done` response ends naturally' "$ROOT/docs/status-framework.md"
grep -q 'An explicit request authorizes reversible work' "$ROOT/docs/permission-model.md"
grep -q 'Apply and verify the requested switch before content work' "$ROOT/docs/channel-runtime.md"
test ! -e "$ROOT/docs/approval-discipline.md"
! grep -q 'close every chat message' "$ROOT/docs/status-framework.md"
! grep -q 'short prose keeps only the last' "$ROOT/docs/reply-shape.md"
! grep -q 'Every visible agent post ends with `## Status`' "$ROOT/docs/reply-shape.md" "$ROOT/docs/slack-style.md"
! grep -q 'kickoff\|first agent post.*Goal:' "$ROOT/docs/reply-shape.md"
! grep -q '## ❓ Clarify' "$ROOT/docs/reply-shape.md"
! grep -q '^## Format' "$ROOT/agents/liv.md" "$ROOT/agents/max.md"
! grep -q 'skills/\|## Standing instructions\|## Wears' "$ROOT"/agents/*.md

printf '%s\n' "reply-policy: OK"
