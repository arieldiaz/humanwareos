---
name: rederive
description: Rebuild a derived artifact from primary evidence for a new question or better method.
---

# Rederive

Use when an existing derivation is stale, suspect, or answering the wrong question.

1. Identify the primary evidence and state the new derivation question.
2. Use an execution profile approved for that evidence's privacy tier.
3. Write the result under `$HUMANWARE_DATA_ROOT/generated/` with source identifiers, date, method or model, schema, and question.
4. Compare with the prior derivation when the difference matters and record a correction event if the understanding changed materially.

Done when the new artifact is reproducible from named evidence. Never modify the evidence to agree with the derivation.
