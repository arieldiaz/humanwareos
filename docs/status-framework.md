# Status framework

Lifecycle answers who owns the next move. The model selects ordinary terminal status; the host alone authenticates, reserves and completes closure.

Budget: 900 words. Over it, consolidate.

## Four states

- `working`: admitted execution owns the next move; 🔄.
- `act`: the conversational turn returns to the human, including an ordinary answer or completed reversible action; ✋.
- `scheduled`: a verified durable wake owns future continuation in this conversation; 🗓️.
- `closed`: the configured instance owner closed this conversation generation through the host; ✅.

`working` and `closed` are not model terminal choices. `done` is not an alias. Historical append-only records remain unchanged. Domain processing states and harness completion are separate vocabularies.

## Model final contract

Every enabled conversational execution path returns exactly `{schemaVersion: 1, message: string, status: "act" | "scheduled"}`. The message must be nonempty; extra fields are rejected. Codex uses app-server `turn/start.outputSchema`; Cursor uses its whole stream-JSON final result. Decode once, strictly: never extract JSON from prose, strip fences, or infer status from headings, reactions or tools. Unsupported enabled harnesses fail the integration gate.

A scheduled decision requires an enabled durable `agentTurn` wake with a future next-run time, bound to this canonical session and configured for delivery. Validate scheduler storage, not a tool success claim.

Key each decision by canonical conversation and admitted run ID. Reserve the envelope before durable publication, retain the receipt, record the transition, and project the root tile. Ordinary Liv/Max finals both deliver; only the latest admission owns the tile. Invalid schema or evidence gets one tool-free repair in the same harness/session. A second failure restores the prior terminal state, never invents `act`, and records a fault. Uncertain delivery remains reserved under the same outbox intent for reconciliation, never a new send.

## Owner-only close command

Intercept the authenticated Slack event before model admission and mention gating. Match only its own raw text: trim surrounding whitespace, compare `close this` case-insensitively, allow one final period or exclamation mark, and allow leading structured mentions of configured agents separated by whitespace. Do not strip other words, punctuation, quotes, code, forwards or attachments into a match. Bots, other humans and replayed text cannot authorize closure. Missing owner principal configuration fails closed. A root command receives an instruction to reply inside the target thread, not a closure.

The persisted conversation sender owns the report; otherwise use the configured channel default, bound at reservation. Mentions never transfer closure ownership. Missing sender configuration is an error. Other bot callbacks exit without admission, acknowledgement or lifecycle writes.

## Closure commit and recovery

The existing FinalRuntime journal owns live state, generation and closure stages. Atomically reserve one close operation per generation, bind source event/principal/sender and fence earlier work. Freeze recorded outcomes and unresolved work, thread counts and elapsed time, models and usage through that event. Missing metrics say unavailable; partial coverage is labeled; zero requires observed evidence. Limited recap evidence is explicit, never inferred success. No model enrichment occurs.

Persist the snapshot and `formatCloseReport` output before sending. Write that semantic report to the Markdown session record and send it fully inline in the originating thread. Deterministic parts retain stable outbox identities and receipts. A link, canvas or acknowledgement is not the report. Only after both outputs are confirmed, append one idempotent completion event, then project closed. Failures retain the fence and recoverable stage. Restart recovery reuses the snapshot and receipts without a model turn. Ambiguous or expired receipts require reconciliation, never blind resend.

A new human message after completed closure reopens a new generation; duplicate/older events and machine callbacks cannot reopen. Pre-close results stay recorded and intentionally undelivered even after reopening. Legacy boundaries are read-only import sources until reconciled; ambiguous or conflicting history remains fenced. No competing live fence writer survives.

Only the projector changes bot-owned lifecycle reactions; human reactions are social input. Provenance belongs on delivered replies. Disable Slack acknowledgement and native status-reaction writers in activation configuration.

## Verification and release

Before merge: both harness adapters and identities, exact grammar and principal/sender gates, duplicate/racing callbacks, generation fencing, unavailable/partial usage, and crashes at each durable stage. Rehearse patches idempotently against copied installed bundles. Tests are not live acceptance.

After separately approved activation, fresh owner-authored Slack threads for both identities must show ordinary answers, scheduling, the full inline report matching disk, one completion event, then one root closed tile; reopen and verify old work remains fenced. Implementation approval grants no merge, migration, activation or restart authority.
