# Status framework

Lifecycle answers who owns the next move. The LLM is the only semantic terminal authority; the host owns admission, validation, persistence, and projection.

Budget: 900 words. Over it, consolidate.

## Four states

- `working`: admitted execution owns the next move; 🔄.
- `act`: the conversational turn returns to the human, including an ordinary answer or completed reversible action; ✋. It does not require manufacturing an ask.
- `scheduled`: a verified durable wake owns future continuation in this conversation; 🗓️.
- `closed`: the current human explicitly confirmed whole-thread closure; ✅.

`working` is not a model terminal choice. `done` is not a current alias. Historical append-only records are not rewritten. Domain processing states and harness run completion are separate vocabularies.

## Final wire contract

Every enabled conversational execution path returns exactly `{schemaVersion: 1, message: string, status: "act" | "scheduled" | "closed"}`. The message must be nonempty. Extra fields are rejected. The adapter never infers status from headings, keywords, reactions, tool results, or send metadata.

Codex uses app-server `turn/start.outputSchema`. Cursor uses its supported stream-JSON transport; its entire final result string must itself be the JSON object. Decode the complete string once and validate it strictly. Do not extract objects from prose, strip fences, or guess missing fields. Both transports enter the same validator and commit path. Unsupported enabled harnesses fail the integration gate; disabling or rerouting a profile needs a separate human decision.

A scheduled decision requires an enabled durable `agentTurn` wake with a future next-run time, bound to this exact canonical session and configured for delivery. Read scheduler storage at validation time; a tool success claim is insufficient. Existing verified wakes may support rescheduling or status repair. Closure requires a current trusted human input explicitly authorizing closure (`close this thread`, `close this conversation`, `close this session`, `close it`, or `confirm closure`, optionally prefixed by please); neither old conversation context nor machine input supplies that authority.

## Commit and recovery

Key one decision by canonical conversation plus admitted run ID. Persist admission and its prior committed state before execution. Reserve the validated envelope durably before publishing. Deliver only its unchanged message through the existing durable transport, then record the receipt, append the accepted terminal transition, project its root tile, and add the independent run signature. Duplicate callbacks cannot select another decision. A superseded run cannot replace the latest admitted owner.

Invalid schema or evidence gets one repair in the same harness/session, with no repeated work. A second invalid result, failed execution, or delivery failure records an operational fault and restores the previous committed terminal state. With no prior terminal, clear the transient tile. Never invent `act` or leave `working` without an actual durable retry. Deliver through gateway `send` using the reservation key as its durable idempotency key, not through a second normal final publication. On restart, replay the same transport key to recover its receipt; never rerun tools or recompute a reserved decision.

Only the projector can add/remove bot-owned lifecycle reactions. Human reactions remain untouched social input and cannot suppress canonical state. Agent reaction tools reject the lifecycle vocabulary. Provenance reactions belong on the delivered reply, not the root. Remove retired provenance tiles only through a bounded migration, not steady-state projection.

An accepted closed final fences automated continuations. A new human message reopens through normal admission; stale work from before closure remains fenced. Closure measurements belong in the session ledger/generated operational view, never a replacement reply. Machine workflows, including email receipts, may report domain state but cannot choose conversation lifecycle. Slack acknowledgement and native status-reaction writers must be disabled in the activation configuration.

## Verification and release

Before merging: contract, evidence, bounded-repair, idempotency, supersession, failure, and restart tests; both identities through actual Codex and Cursor boundary adapters; and idempotent patch rehearsal on copied installed bundles. Search for removed parsers, overrides, and close rewriting. Fixtures alone do not establish live acceptance.

After separately approved merge and immutable-runtime activation, fresh user-authored Slack threads for both identities must prove admission 🔄, ordinary ✋, successful schedule/reschedule 🗓️, failed schedule recovery, confirmed concise closure ✅, reopening, exactly one bot-owned root tile, no acknowledgement reactions, and correct per-reply signatures. Record the ledger and Slack readback for each case. No production restart or cutover is implied by implementation approval.
