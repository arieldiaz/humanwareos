# Status framework

Lifecycle answers who owns the next move. The host derives it from the run lifecycle and authenticated closure; model output never chooses it.

Budget: 900 words. Over it, consolidate.

## States

- `working`: admitted execution owns the next move; 🔄.
- `act`: the run ended and the turn returns to the human; ✋.
- `closed`: the current human explicitly confirmed whole-thread closure; ✅.

`done` is not a current alias. Historical append-only records are not rewritten. Domain processing states and harness run completion are separate vocabularies.

## Projection and recovery

The first model input of a run admits it as `working`; the end of that run sets `act`. Only the latest admitted run, from any agent, sets the root tile. A run interrupted by restart restores the previous status. The authenticated instance owner's exact close command is intercepted before model admission; quotes, prior context, other senders, bots, and model text cannot authorize closure.

Only the projector can add/remove bot-owned lifecycle reactions. Human reactions remain untouched social input and cannot suppress canonical state. Agent reaction tools reject the lifecycle vocabulary. Provenance reactions belong on the delivered reply, not the root. Remove retired provenance tiles only through a bounded migration, not steady-state projection.

`closed` is soft. A reserved host close freezes one measured report, publishes it inline and to the generated session view, then projects ✅ after the receipt and the completion event exist. Nothing is fenced: later sends, subagent completions and scheduled wakes proceed normally, and the next admitted run in the thread replaces ✅ with 🔄 and then its own terminal status through ordinary admission. A repeated close command on a still-closed thread is a no-op. Machine workflows, including email receipts, may report domain state but cannot choose conversation lifecycle. Slack acknowledgement and native status-reaction writers must be disabled in the activation configuration.

## Verification and release

Verify changed behavior through the affected harness and delivery paths, including recovery where relevant. Fixtures alone do not establish live Slack acceptance. Merge and production activation require separate human approval.
