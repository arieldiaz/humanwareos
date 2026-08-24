# Status framework

The shared status taxonomy for Humanware OS and any instance built on it. One explicit outbound status value renders both the human-readable `## Status` footer and the single lifecycle tile on the human's thread root. The adapter never infers status from arbitrary reply prose.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The statuses

Every visible agent post ends with `## Status` and exactly one canonical opening line:

- `Ariel — answer:` — the human owes an answer, choice, judgment, or go. Root tile: ❓ `:question:`.
- `Ariel — act:` — the human owes work that only they can do with their identity, credential, vendor console, or physical access. Root tile: ✋ `:raised_hand:`.
- `Agent — working:` — the agent still owns follow-through. Root tile: 🔄 `:arrows_counterclockwise:`.
- `Scheduled:` — the item has a real resurface time backed by a reminder or durable wake. Root tile: 🗓️ `:calendar:`.
- `No action needed.` — the post is an answer, result, or completed reversible action with no pending handoff. Root tile: none.
- `Session closed.` — the human confirmed the user-level outcome and the durable close-out was recorded. Root tile: ✅ `:white_check_mark:`.

The text after a colon is the shortest useful next step. `No action needed.` and `Session closed.` take no added instruction. An omitted or invalid explicit status is normalized to `No action needed.` so missing formatting can never manufacture a human handoff or leave a false working tile.

## Choosing the status

**Answer and act name different obligations.** Use `Ariel — answer:` for a blocking question. Use `Ariel — act:` only when the next step genuinely needs the human's hands. Before assigning action, ask whether the agent can do it with available tools and authority. If so, do it.

**An explicit request already supplies authority for reversible in-scope work.** Do not turn it into another approval request. A go is needed only for work that is irreversible, outward-facing, costly, or outside existing authority. When a true go is required, state the recommendation before the question.

**Questions have a budget.** Ask one blocking question by default, three only when inseparable. Act on the confident majority and flag reversible assumptions. Never manufacture a choice because the format expects a status.

**Working is an ownership claim.** Use it only when the agent has started follow-through that will continue after this post. A long turn expected to exceed five minutes opens with a short working post. Progress posts remain working. The final result replaces it with the actual next owner or no action. A completed turn is never working merely because it lacks an old lifecycle heading.

**Scheduled needs a wake.** No resurface date means kill it, complete it, or keep it on the agent; do not park it without a trigger.

**Completion does not create an ask.** Report the result with `No action needed.` The closed status is reserved for the human's confirmed thread close and the measured close-out, not for a draft, commit, subtask, or ordinary finished turn.

## One value, three renderings

The outbound adapter normalizes the final Status section into a closed internal enum before delivery. It renders the canonical footer from that value, uses the same value to set, swap, or clear the root tile, and records that same value on the session ledger. The menu and session console are views of the ledger, not a second inventory. There is no second prose lifecycle parser and no headerless fallback to working.

The human's root message carries at most one adapter-held lifecycle tile. Model, harness, thinking, and agent identity never belong on the root. Provenance lives on each agent post because it may change mid-thread.

The mapping is exact:

- `answer` → ❓
- `act` → ✋
- `working` → 🔄
- `scheduled` → 🗓️
- `no_action` → no tile
- `closed` → ✅

A human-held lifecycle tile owns the state and is never removed or co-reacted by the adapter. Non-lifecycle reactions are never touched. Forward cleanup removes only gateway-held tiles from retired status and provenance schemes when the thread next sees a send.

✅ remains the human's decision. Their confirmation in the thread or their own ✅ on the root authorizes the close-out. A human-held ✅ outranks a later bot status until the human reopens the work.

## Collaboration

In a multi-agent phase, individual Brainstorm contributions and interim Challenge turns use `Agent — working:` because the phase still owns follow-through. The phase produces one Ariel-facing answer request only when the collaboration contract reaches its handoff. One thread has one status regardless of how many agents contributed.

When more than one actor shares a thread, the next-step sentence may prefix the owner with 🦋 Liv, 🦊 Max, or 🙋 Ariel. A single-agent thread needs no identity prefix because the author already names the agent.

## Run signatures and faults

Every visible agent post also receives the adapter-owned run signature: resolved model, optional harness, and resolved thinking level. Agents never type it themselves. If the effective thinking value cannot be proved, the adapter omits it and logs `thinking_unknown`; it never guesses.

Status or signature write failures are journaled for scheduled review, never posted into the affected thread. Delivery succeeds even when cosmetic reaction writes fail. The journal and digest are the monitor.

## Examples

- Ordinary answer or completed reversible action → `No action needed.` and no root tile.
- Waiting for a decision → `Ariel — answer: Approve the recommended migration.` and root ❓.
- Waiting for a vendor-console step → `Ariel — act: Complete the identity check in the vendor console.` and root ✋.
- Long run kickoff → `Agent — working: I am implementing and verifying the approved change.` and root 🔄.
- Reminder created for Monday → `Scheduled: Resurfaces Monday at 9:00 AM.` and root 🗓️.
- Human-confirmed close-out → `Session closed.` and root ✅.

## Changelog

- **2026-08-24** — The same outbound status also writes the session ledger; the menu is a view of that ledger.
- **2026-08-23** — Replaced competing closing headers and prose inference with one explicit outbound status value that renders both the mandatory Status footer and root tile.
- **2026-08-18** — RCR 2026-08-18-01 moved provenance from the root to per-message run signatures and reduced the root to one lifecycle tile.
