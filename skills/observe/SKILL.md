---
name: observe
description: Preserve a meaningful raw input as append-only evidence with minimal capture context.
---

# Observe

Use when the human asks to capture something or when an input clearly matters beyond the current conversation.

1. Preserve the rawest available source under `$HUMANWARE_DATA_ROOT/evidence/stream/` using the repository's stream naming convention. Never rewrite an existing event.
2. Add only the capture-time context needed to identify what it is, when it happened, and why it may matter. Do not summarize, tag, or reorganize the stream as part of capture.
3. Return the evidence reference to the enclosing task. For requested behavioral corrections, continue through [Rule promotion](docs/agent-context-hierarchy.md#rule-promotion); for a requested derived artifact, create it separately with provenance.

Capture is done when the new event is durable and no prior evidence changed. The enclosing task retains its own completion condition.
