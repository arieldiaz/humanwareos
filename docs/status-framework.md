# Status framework

Run lifecycle and workflow status are separate facts. The host records run lifecycle; a human controls current Slack root status, except as stated below. Neither substitutes for the other.

Budget: 900 words. Over it, consolidate.

## Run lifecycle

- `working`: admitted execution owns the next move.
- `act`: the run ended and the turn returns to the human.
- `closed`: the owner asked to close the thread.

`done` is not a current alias. Historical append-only records are not rewritten. Domain processing states, human workflow status, and harness completion are separate vocabularies.

The first model-start event admits a run as `working`; duplicate starts are idempotent, and the end of the latest admitted run records `act`. When the owner asks to close, the agent finishes the other requested work and calls `close_thread`. The host records `closed`, then seals the session record: it captures the record, exports the whole Slack thread, writes the close report as the record's summary (tokens and cost from the ledger, priced like the session console), appends the ledger completion event, posts the report, and queues the `closed` root status and the session's Notion entry, which the projector writes from the sealed record. Each step is idempotent and recorded in `close.json`; a failed step does not stop independent ones, the post names it in one line, and `close_thread` with `retry` runs only what is missing. Every run end also captures the record in the background, without a timer. Closure remains soft: later sends, completions, scheduled wakes, and human messages proceed normally.

Slack never renders run lifecycle as a root reaction. Run admission, completion, acknowledgement, typing, work-thread creation, recovery, and sweeps may not add, replace, or remove reactions on a Slack root. Only the owner's explicit request, through the status tool or a close, writes a bot-owned root status; generic reaction tools remain blocked from canonical status emoji. Per-message provenance reactions on delivered replies are unaffected.

## Human Slack status

The canonical Slack root statuses are:

- `working`: 🔄 (`arrows_counterclockwise`)
- `act`: ✋ (`raised_hand`; normalize Slack's read alias `hand`)
- `scheduled`: 🗓️ (`calendar`)
- `closed`: ✅ (`white_check_mark`)
- `unknown`: no accepted canonical reaction

An instance-configured human status actor is authoritative. Configured migration bots may retain one historical status only while that baseline root remains unclaimed. Reactions from other people and noncanonical emoji are social or provenance data and do not set status.

Status is derived from the current root snapshot. Zero distinct canonical reactions held by configured actors means `unknown`; exactly one means that status; more than one is ambiguous, projects as `unknown`, and is journaled for manual review. Never resolve ambiguity by reaction order, first reaction, precedence, or inference.

Human reactions are never removed or rewritten by the system. To change status, the human removes the old canonical reaction and adds the new one. A short per-root debounce may coalesce that pair before projection. The first human canonical add or remove claims the root and removes its managed legacy bot status.

## Projection and recovery

Slack is the source for new and human-claimed workflow status. During an explicitly configured migration, a Status edit on an unclaimed baseline row may replace or clear only configured bots' canonical reaction on that root. This writeback cannot affect new roots, human-claimed roots, human reactions, or any other Notion property. The projector records ownership so clearing a migrated status does not resurrect the baseline.

The Slack adapter consumes structured `reaction_added` and `reaction_removed` events for message items. It accepts only configured human actors and canonical status reactions, silently claims the event before ordinary agent dispatch, and never wakes a model or posts a reply. Prose rendering of a system event is not an authentication or parsing boundary.

After a short per-root debounce, the projector refetches the exact message, verifies it is a root, derives status from the complete current reaction snapshot, and upserts the row by `channel_id:thread_ts`. Reactions on replies and non-message items are ignored.

Processing is idempotent. Deduplicate Slack retries by event ID and, when multiple apps observe one workspace action, by a stable logical event key. A status-change timestamp never moves backward. A validated event supplies its event timestamp; reconciliation without a retained event uses observation time and records that provenance.

A full reconciliation runs when the projector's job loads and after each close or status command, never on a timer. It repairs dropped, delayed, duplicated, or out-of-order events and Notion write failures. Projection updates only owned Notion properties; page bodies, comments, and unrelated properties remain untouched.

Cutover disables acknowledgement, typing, native status-reaction, and custom lifecycle writers before cleanup. An approved migration may restore one unambiguous historical bot status per unclaimed root. It remains visibly bot-owned, may be changed in bulk from Notion, and disappears when a human claims the root. Rollback may restore code but must not restart lifecycle-driven root reactions.

## Verification and release

Verify that agent runs and work-thread creation make zero root-reaction writes; closure records lifecycle, posts one report, and queues the closed status; per-message provenance remains; status reduction covers authorized and unauthorized holders, zero, one, and multiple statuses, and `hand`; events converge after retries and reordering without waking a model; reconciliation repairs a dropped event; and Notion preserves page bodies, comments, and unrelated properties. Live acceptance has the configured human add, change, and remove each status while Notion follows. Fixtures alone do not establish live Slack acceptance. Merge and production activation require separate human approval.
