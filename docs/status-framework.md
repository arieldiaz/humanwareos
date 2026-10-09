# Status framework

Lifecycle answers who owns the next move. The host derives it from the run lifecycle and owner-authorized closure; model output never chooses it.

Budget: 900 words. Over it, consolidate.

## States

- `working`: admitted execution owns the next move; 🔄.
- `act`: the run ended and the turn returns to the human; ✋.
- `closed`: the owner asked to close the thread; ✅.

`done` is not a current alias. Historical append-only records are not rewritten. Domain processing states and harness run completion are separate vocabularies.

## Projection and recovery

The first model-start event of a run admits it as `working`; duplicate start events are idempotent, and the end of that run sets `act`. Only the latest admitted run, from any agent, sets the root tile. No lifecycle state is stored: the root's bot-held tile is the record, and a run interrupted by restart leaves 🔄 until the thread's next run ends.

Closure has one path. When the owner asks to close, the agent finishes the other requested work and calls `close_thread`. The host puts ✅ on the root at once, then posts one measured close report in the thread after that run's final reply and writes it to the generated session view and the session ledger. The report is best effort: if measuring or posting fails, ✅ stays and the fault is journaled. The host refuses a close the runtime attributes to a sender other than the owner; bots, quoted text, reactions, and the model's own initiative cannot close a thread.

Only the projector can add/remove bot-owned lifecycle reactions. Human reactions remain untouched social input and cannot suppress canonical state. Agent reaction tools reject the lifecycle vocabulary. Provenance reactions belong on the delivered reply, not the root.

`closed` is soft and nothing is fenced: later sends, subagent completions and scheduled wakes proceed normally, and the next admitted run in the thread replaces ✅ with 🔄 and then its own terminal status through ordinary admission. A repeated close request posts another report. Agent-authored Slack messages, including the close report, are context, never triggers, so a report cannot wake another identity; a later human message reopens the thread normally. Machine workflows, including email receipts, may report domain state but cannot choose conversation lifecycle. Slack acknowledgement and native status-reaction writers must be disabled in the activation configuration.

## Verification and release

Verify changed behavior through the affected harness and delivery paths, including recovery where relevant. Fixtures alone do not establish live Slack acceptance. Merge and production activation require separate human approval.
