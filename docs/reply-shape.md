# Response envelope

The one conversational contract for every identity and harness. Identity owns voice and judgment; [status-framework.md](status-framework.md) owns the machine envelope and lifecycle.

Budget: 400 words.

## Boundary

The control plane marks an admitted turn working. The selected execution path returns one final envelope or the silence outcome defined in [status-framework.md](status-framework.md); the adapter publishes a response once or nothing for silence. Models do not post kickoff messages, progress narration, transport state, or run signatures. Checkpoints remain in the session ledger.

## Final message

Lead with the result. For substantive replies, default to `## TLDR`, `## Background`, and `## Next Step`: result, necessary context, and actual next action. Short answers use plain prose. Omit empty sections, repeated facts, and invented next steps. The human may request another shape. Headings have no lifecycle meaning.

Complete authorized, in-scope work before yielding; a milestone is not the objective. Ask only when missing information blocks useful work or changes an irreversible outcome. State the concrete blocking action when one exists. Name a scheduled continuation only after a real durable wake exists. A concise close acknowledgement is enough after explicit human confirmation; never substitute operational telemetry for the model's message.

Never emit generic status footers, run signatures, or narration about loading context and internal routing. An ordinary answer ends naturally without manufacturing an approval or closure recommendation.

## Acceptance

Both identities follow the same delivery contract: a response is delivered once with its effective run signature; intentional silence produces no message or signature and settles only that execution. Missing requested output, duplicate delivery, inferred lifecycle state, or stranded working is a contract failure.
