# Status framework

The shared lifecycle taxonomy for Humanware OS and any instance built on it. Status is control-plane state. Conversation prose shows it only when there is a real handoff, scheduled outcome, or confirmed close.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The states

The internal outbound enum is `answer`, `act`, `working`, `scheduled`, `no_action`, or `closed`. The adapter records one value on the session ledger and renders the matching root tile. It never appends a generic `## Status` footer to the human-visible reply.

- `answer` — the human owes an answer, choice, judgment, or go. Visible closing section: `## ❓ Clarify`. Root tile: ❓ `:question:`.
- `act` — the human owes work that only they can do with their identity, credential, vendor console, or physical access. Visible closing section: `## ✋ Act`. Root tile: ✋ `:raised_hand:`.
- `working` — the agent still owns a long-running turn. The kickoff is plain prose with no lifecycle heading. Root tile: 🔄 `:arrows_counterclockwise:`.
- `scheduled` — the item has a real resurface time backed by an internal durable wake. Visible closing section: `## 🗓️ Scheduled`. Root tile: 🗓️ `:calendar:`.
- `no_action` — an ordinary answer, result, or completed reversible action with no pending handoff. The reply ends naturally. Root tile: none.
- `closed` — the human confirmed the user-level outcome and the durable close-out was recorded. Visible closing section: `## Session Closed`. Root tile: ✅ `:white_check_mark:`.

The visible lifecycle section contains the shortest useful next step. The reasoning, tradeoff, and evidence belong above it. No status sentence is added when there is no handoff.

## Choosing the state

**Answer and act name different obligations.** Use `answer` for a blocking question. Use `act` only when the next step genuinely needs the human's hands. Before assigning action, ask whether the agent can do it with available tools and authority. If so, do it.

**An explicit request already supplies authority for reversible in-scope work.** Do not turn it into another approval request. A go is needed only for work that is irreversible, outward-facing, costly, or outside existing authority. When a true go is required, state the recommendation before the question.

**Questions have a budget.** Ask one blocking question by default, three only when inseparable. Act on the confident majority and flag reversible assumptions. Never manufacture a choice because a reply template expects one.

**Working is an ownership claim.** Use it only when the agent has started follow-through that will continue after the kickoff post. A completed turn is never working merely because it lacks a lifecycle section.

**Scheduled needs an internal wake.** When the agent must message or resume work later, create an OpenClaw cron wake in the current conversation and then publish the exact `## 🗓️ Scheduled` section. Do not route that request to Apple Reminders, a calendar, or another personal task system unless the human explicitly names that destination. If the cron wake fails, report the failure and do not claim `scheduled`; no resurface date means kill it, complete it, or keep it on the agent.

**Completion does not create an ask.** Report the result and stop. Closed is reserved for the human's confirmed thread close and measured close-out, not for a draft, commit, subtask, or ordinary finished turn.

## One value, three renderings

The control plane normalizes one outbound status before delivery, writes it to the session ledger, and uses it to maintain the root tile. Human-visible lifecycle sections are the conversational rendering only for `answer`, `act`, `scheduled`, and `closed`; `working` and `no_action` deliberately add no footer.

The adapter recognizes only exact lifecycle sections or explicit internal metadata. It does not infer obligation from arbitrary prose. Missing or invalid status defaults to `no_action`, which can clear a stale gateway-held transient tile but can never manufacture a handoff. Legacy `## Status` transport footers may be accepted during migration, but the adapter strips or projects them into the lifecycle rendering instead of publishing protocol text.

The mapping is exact:

- `answer` → ❓
- `act` → ✋
- `working` → 🔄
- `scheduled` → 🗓️
- `no_action` → no tile
- `closed` → ✅

The human's root message carries at most one adapter-held lifecycle tile. A human-held lifecycle tile owns the state and is never removed or co-reacted by the adapter. Non-lifecycle reactions are never touched. Forward cleanup removes only gateway-held tiles from retired schemes when the thread next sees a send.

✅ remains the human's decision. Their confirmation in the thread or their own ✅ on the root authorizes the close-out. A human-held ✅ outranks a later agent status until the human reopens the work.

## Collaboration

Individual Brainstorm contributions and interim Challenge turns have no human-facing lifecycle section because the phase still owns follow-through. The phase produces one Ariel-facing handoff only when the collaboration contract reaches its stopping point. One thread has one status regardless of how many agents contributed.

When more than one actor shares a thread, the next-step sentence may prefix the owner with 🦋 Liv, 🦊 Max, or 🙋 Ariel. A single-agent thread needs no identity prefix because the author already names the agent.

## Run signatures and faults

Every visible agent post receives the adapter-owned run signature: resolved model, optional harness, and resolved thinking level. Agents never type it themselves. If the effective thinking value cannot be proved, the adapter omits it and logs `thinking_unknown`; it never guesses.

Status, signature, or ledger write failures are journaled for scheduled review, never posted into the affected thread. Delivery succeeds when cosmetic reaction writes fail. The journal and digest are the monitor.

## Changelog

- **2026-08-24** — Restored lifecycle-only visible sections. Status remains one internal value across the ledger and root tile, while ordinary replies again end naturally.
- **2026-08-24** — The outbound status also writes the session ledger; the menu is a view of that ledger.
- **2026-08-23** — Replaced competing lifecycle parsers with one normalized outbound value.
- **2026-08-18** — Moved provenance from the root to per-message run signatures and reduced the root to one lifecycle tile.
