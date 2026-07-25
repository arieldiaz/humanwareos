# Status framework

The shared status taxonomy for Life OS (and any instance built on it, e.g.
Ariel OS). Every item is in exactly **one of four lifecycle states** — there is
nothing else. Agents (e.g. Liv 🦋 / Max 🦊) signal the state as part of the
**run strip** — a fixed-order set of reactions on the human's thread root.

## The four states

- 🔄 **in-process** — actively being worked. (An open thread usually implies
  this; the reaction just makes it explicit on the root.)
- 🗓️ **scheduled** — flagged to resurface at a set time (reminder/cron set).
  The "keep it alive" state. **No resurface date = kill it, don't park it.**
- 🚫 **blocked** — waiting on something external before it can move,
  *including a decision from the human*.
- ✅ **done** — the user-level outcome is shipped / confirmed / complete.
  Finishing an agent turn, draft, commit, or subtask is not enough; the human
  confirms the item is done.

If an item isn't one of these four, it's either done (close it) or it should be
scheduled (give it a date). No open-ended parking lot, no ceremony layer.

## Pickup & who acted

The agent's **identity reaction** (e.g. 🦋 / 🦊) is the "I've got it" signal —
there's no separate 👀. Combine identity with state to read who did what:

- 🦋✅ = Liv done · 🦊✅ = Max done
- 🦋🗓️ = Liv scheduled a follow-up · 🦊🚫 = Max is blocked

## Run strip order

The run strip lands on the human's thread root *before* the agent's first
visible reply, and its order is fixed so the thread can be read at a glance:

1. **Lifecycle status — always first, always exactly one for the thread.** Not
   per agent: one thread, one state.
2. **Then one `agent → harness → model` triplet per agent**, agents ordered by
   first involvement. An agent running a native local model has no harness
   tile, which collapses its triplet to a pair.

Two agents in one thread therefore read
`status · agent harness model · agent harness model`. Multiple agents and
multiple models are fine — the strip grows by whole triplets, and the leading
status never moves.

**Implementation note (Slack, and any platform that orders reactions by
first-added time):** replacing 🔄 with ✅ would park the new status at the *end*
of the strip. A lifecycle transition must therefore **re-lay the whole strip** —
read the root's reactions, remove every strip reaction, re-add them in canonical
order. Reactions added by humans are left alone. An agent joining a thread that
already has a strip just appends its own triplet; no re-lay needed, since
triplets are ordered by arrival anyway.

An instance defines its own agent/harness/model tiles; the ordering contract is
the part that belongs to the framework.

## Changelog

- **2026-07-25** — Added the run strip and fixed its order: status first
  *always*, then `agent · harness · model` per agent. Lifecycle transitions
  re-lay the whole strip rather than appending the new state.
- **2026-07-23** — Established as a global framework, then reduced to its core.
  Removed 👀 (pickup is the identity reaction), 📌 parked (replaced by
  schedule-or-kill under 🗓️), and the handshake reactions 🎯/❓/🧠/🙈 — the
  thread itself carries acknowledgment, and "waiting on your decision" is just
  🚫 blocked.
- **2026-07-23** — Standardized the blocked glyph to 🚫 (was 🚧) to match the
  simplified taxonomy used across instances.
