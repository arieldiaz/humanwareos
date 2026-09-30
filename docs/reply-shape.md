# Response envelope

The one conversational contract for every identity and harness. Identity owns voice and judgment; [status-framework.md](status-framework.md) owns the machine envelope and lifecycle.

Budget: 400 words.

## Boundary

The control plane marks an admitted turn working. The selected execution path returns one final envelope; the adapter publishes only its message, once. Models do not post kickoff messages, progress narration, transport state, or run signatures. Checkpoints remain in the session ledger.

## Final message

Be radically succinct. Use `## TLDR`, `## Background`, and `## Next`, in that order, for substantive replies. TLDR gives the result in one sentence; Background contains only context needed to understand it; Next names the concrete next action or blocker. Keep each section to one short paragraph or at most three short bullets. Target 150 words or fewer unless the human requests detail or necessary evidence requires more; link the durable artifact instead of copying it. Never repeat a fact between sections. Omit empty Background or Next sections; never invent a next step. A one-line answer or acknowledgement stays one line. Headings have no lifecycle meaning.

Complete authorized, in-scope work before yielding; a milestone is not the objective. Ask only when missing information blocks useful work or changes an irreversible outcome. State the concrete blocking action when one exists. Name a scheduled continuation only after a real durable wake exists. A concise close acknowledgement is enough after explicit human confirmation; never substitute operational telemetry for the model's message.

Never emit generic status footers, run signatures, or narration about loading context and internal routing. An ordinary answer ends naturally without manufacturing an approval or closure recommendation.

## Acceptance

Both identities show the same observable sequence for the same case: working on admission, one validated final message, one committed terminal root tile, and the delivered reply's effective run signature. Missing output, duplicate delivery, inferred status, or stale working is a contract failure.
