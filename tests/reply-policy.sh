#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

test "$(wc -w < "$ROOT/docs/reply-shape.md")" -le 500
test "$(wc -w < "$ROOT/docs/status-framework.md")" -le 1800
test "$(wc -w < "$ROOT/AGENTS.md")" -le 1400
for file in "$ROOT"/agents/*.md "$ROOT"/skills/*/SKILL.md; do test "$(wc -w < "$file")" -le 250; done
test ! -e "$ROOT/docs/approval-discipline.md"
! grep -q '^## Format' "$ROOT/agents/liv.md" "$ROOT/agents/max.md"
! grep -q 'skills/\|## Standing instructions\|## Wears' "$ROOT"/agents/*.md

printf '%s\n' "reply-policy: OK"
