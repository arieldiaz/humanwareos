# Response envelope

The one contract for what an execution returns and what a conversation surface publishes. Identity files own voice and judgment; they may not define another reply format. Status mechanics live in `docs/status-framework.md`; surface rendering lives in the channel style spec.

Budget: 500 words.

## Boundary

An admitted turn has one owner at each stage: the control plane marks the turn `working`; the selected harness produces one semantic final; the adapter publishes it once, derives the terminal lifecycle state, and adds provenance after delivery. The model never posts a kickoff, progress narration, transport state, or run signature. Internal checkpoints stay in telemetry.

Every execution path, including Liv through Cursor and Max through Codex, receives this contract verbatim in its generated harness context. A harness or model change cannot change the envelope.

## Final response

Lead with the result. A short answer stays plain prose. A substantive answer uses `## TLDR`, optional `## Background`, and `## Next Step` only when work remains. Use the human's terms, plain English, and only the structure the answer needs. Do not add consultant theater, repeated conclusions, a forced call to action, or a closing question.

If the request is actionable, act. Ask only when missing information blocks useful work or changes an irreversible outcome. Make one reversible assumption when that is enough to proceed. An explicit request authorizes reversible in-scope work; do not request the same permission again.

An ordinary answer or completed action ends naturally. Add exactly one final lifecycle section only when there is a real handoff or durable schedule:

- `## ❓ Clarify` when the human must answer one blocking question.
- `## ✋ Act` when the human must perform work the agent cannot do.
- `## 🗓️ Scheduled` only after a durable wake exists.
- `## Session Closed` only after the human approves closure; its measured body comes from the close-out tool.

Never emit `## Status`, `No action needed.`, `Agent — working`, `Goal:`, or process narration about loading context, checking reply shape, thinking, or what the agent is about to do during the same turn. Do not put any text after a lifecycle section.

## Acceptance

The boundary passes only when both Liv and Max show the same observable sequence for the same case: the root gains 🔄 within five seconds of admission; Slack receives one final reply; that reply follows this shape; 🔄 is cleared or replaced by the final lifecycle tile; and the delivered reply receives the effective model, harness, and thinking reactions. Missing final output, duplicate delivery, an invalid lifecycle section, or a stale working tile is a contract failure.

Test this in four layers: deterministic source checks in CI; fixture-driven envelope and status transitions for both identities; on-demand behavioral evals against realistic prompts and pressure cases; then a small live Slack matrix after the single cutover. Behavioral evals judge observable state and structure, not exact wording.
