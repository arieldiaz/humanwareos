# Status framework

Run lifecycle and human workflow status are separate facts. The host records run lifecycle; an instance-configured human controls Slack root status. Neither substitutes for the other.

Budget: 900 words. Over it, consolidate.

## Run lifecycle

- `working`: admitted execution owns the next move.
- `act`: the run ended and the turn returns to the human.
- `closed`: the owner asked to close the thread.

`done` is not a current alias. Historical append-only records are not rewritten. Domain processing states, human workflow status, and harness completion are separate vocabularies.

The first model-start event admits a run as `working`; duplicate starts are idempotent, and the end of the latest admitted run records `act`. When the owner asks to close, the agent finishes the other requested work and calls `close_thread`. The host records `closed` and posts one measured close report. Closure remains soft: later sends, completions, scheduled wakes, and human messages proceed normally.

Slack never renders run lifecycle as a root reaction. Run admission, completion, closure, acknowledgement, typing, work-thread creation, recovery, and sweeps may not add, replace, or remove reactions on a Slack root. Agent reaction tools may not write root reactions. This restriction does not affect per-message provenance reactions on delivered agent replies.

## Human Slack status

The canonical Slack root statuses are:

- `working`: 🔄 (`arrows_counterclockwise`)
- `act`: ✋ (`raised_hand`; normalize Slack's read alias `hand`)
- `scheduled`: 🗓️ (`calendar`)
- `closed`: ✅ (`white_check_mark`)
- `unknown`: no accepted canonical reaction

Only reactions held by an instance-configured human status actor count. Bot-held reactions, reactions from other people, and noncanonical emoji are social or provenance data and do not set status.

Status is derived from the current root snapshot. Zero distinct canonical reactions held by configured actors means `unknown`; exactly one means that status; more than one is ambiguous, projects as `unknown`, and is journaled for manual review. Never resolve ambiguity by reaction order, first reaction, precedence, or inference.

Human reactions are never removed or rewritten by the system. To change status, the human removes the old canonical reaction and adds the new one. A short per-root debounce may coalesce that pair before projection.

## Projection and recovery

Slack is the source for human workflow status. Notion projects it one way and never writes back to Slack.

The Slack adapter consumes structured `reaction_added` and `reaction_removed` events for message items. It accepts only configured human actors and canonical status reactions, silently claims the event before ordinary agent dispatch, and never wakes a model or posts a reply. Prose rendering of a system event is not an authentication or parsing boundary.

After a short per-root debounce, the projector refetches the exact message, verifies it is a root, derives status from the complete current reaction snapshot, and upserts the row by `channel_id:thread_ts`. Reactions on replies and non-message items are ignored.

Processing is idempotent. Deduplicate Slack retries by event ID and, when multiple apps observe one workspace action, by a stable logical event key. A status-change timestamp never moves backward. A validated event supplies its event timestamp; reconciliation without a retained event uses observation time and records that provenance.

A periodic full reconciliation remains mandatory. It repairs dropped, delayed, duplicated, or out-of-order events and Notion write failures. Projection updates only owned Notion properties; page bodies, comments, and unrelated properties remain untouched.

Cutover removes every agent-held root reaction, including canonical lifecycle reactions, while preserving every human-held reaction. Historical agent suggestions may be retained only as a manual-review artifact; they do not become human-authored status. Disable acknowledgement, typing, native status-reaction, and custom root-reaction writers before cleanup. Rollback may restore code but must not recreate agent-held root status.

## Verification and release

Verify that agent runs, closure, and work-thread creation make zero root-reaction writes; closure still records lifecycle and posts one report; per-message provenance remains; status reduction covers authorized and unauthorized holders, zero, one, and multiple statuses, and `hand`; events converge after retries and reordering without waking a model; reconciliation repairs a dropped event; and Notion preserves page bodies, comments, and unrelated properties. Live acceptance has the configured human add, change, and remove each status while Notion follows. Fixtures alone do not establish live Slack acceptance. Merge and production activation require separate human approval.
