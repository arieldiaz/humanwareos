# Status framework

Lifecycle answers who owns the next move. The host derives it from the run lifecycle and owner-authorized closure; model output never chooses it.

Budget: 900 words. Over it, consolidate.

## States

- `working`: admitted execution owns the next move; 🔄.
- `act`: the run ended and the turn returns to the human; ✋.
- `closed`: the owner asked to close the thread; ✅.

`done` is not a current alias. Historical append-only records are not rewritten. Domain processing states and harness run completion are separate vocabularies.

## Projection and recovery

The first model-start event of a run admits it as `working`; duplicate start events are idempotent, and the end of that run sets `act`. Only the latest admitted run, from any agent, sets the root tile. No lifecycle state is stored: the root's bot-held ✅ is the record of closure, and a run interrupted by restart leaves 🔄 until the thread's next run ends. Closure has one path. When the owner asks to close, the agent finishes the other requested work and calls `close_thread`. The tool closes the thread the run belongs to, derived from the session's thread key; it needs no triggering message id, inbound cache, owner bookkeeping, or other stored state, so it works after a restart or replay. A close requested during a live run applies when that run ends; with no live run in host memory it applies immediately. Closing is soft and reversible, so the agent's judgment about who asked is the only gate.

Only the projector can add/remove bot-owned lifecycle reactions. Human reactions remain untouched social input and cannot suppress canonical state. Agent reaction tools reject the lifecycle vocabulary. Provenance reactions belong on the delivered reply, not the root. Remove retired provenance tiles only through a bounded migration, not steady-state projection.

`closed` is soft. A reserved host close freezes one measured report, publishes it inline and to the generated session view, then projects ✅ after delivery settles and the completion event exists. Nothing is fenced: later sends, subagent completions and scheduled wakes proceed normally, and the next admitted run in the thread replaces ✅ with 🔄 and then its own terminal status through ordinary admission. A repeated close request on a still-closed thread is a no-op. Machine workflows, including email receipts, may report domain state but cannot choose conversation lifecycle. Slack acknowledgement and native status-reaction writers must be disabled in the activation configuration.

Host close reports and other configured-agent messages are transport, not new conversational turns. While closure is in progress or the thread remains closed, the inbound adapter consumes those bot-authored messages so another participating agent cannot answer them. A later human message is never consumed by this fence and reopens the thread normally.

## Verification and release

Verify changed behavior through the affected harness and delivery paths, including recovery where relevant. Fixtures alone do not establish live Slack acceptance. Merge and production activation require separate human approval.
