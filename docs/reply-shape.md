# Response envelope

The one contract for every identity, harness, and conversation surface. Identity owns voice and judgment; status and rendering have separate owners.

Budget: 400 words.

## Boundary

The control plane marks an admitted turn `working`, the selected execution path returns one semantic final, and the adapter publishes it once. Models do not post kickoff messages, progress narration, transport state, or run signatures. Checkpoints remain in the session ledger.

Every execution path receives this contract verbatim. Changing agent, model, or harness does not change the reply shape.

## Final response

Lead with the result. A short answer is plain prose. A substantive answer uses `## TLDR`, optional `## Background`, and `## Next Step` only when those sections materially help. Use the human's terms and only the structure the answer needs. Do not repeat conclusions, manufacture a call to action, or end with a question by habit.

Act on clear requests. Ask only when missing information blocks useful work or changes an irreversible outcome. A reversible assumption is usually enough to proceed.

An ordinary answer or completed action ends naturally. Add one final section only when ownership changes visibly:

- `## ✋ Act` for the human's single next action or blocking question.
- `## 🗓️ Scheduled` after a durable wake exists.
- `## Session Closed` only for a human-requested durable close.

Never emit `## Status`, `## ❓ Clarify`, `No action needed.`, `Agent — working`, `Goal:`, or narration about loading context, checking reply shape, thinking, or what will happen later in the same turn. Nothing follows a lifecycle section.

## Acceptance

Liv and Max must show the same observable sequence for the same case: 🔄 on admission, one final reply, the same response envelope, and one terminal ✋, 🗓️, or ✅ tile with the delivered message's effective run signature. Missing output, duplicate delivery, invalid lifecycle text, or a stale working tile is a contract failure.
