# Status framework

The shared status taxonomy for Humanware OS and any instance built on it. A status records a real handoff or scheduled/closed outcome, not the mere end of an agent message. The surface adapter signals it with a single status tile on the human's thread root; who ran what, on which model, is read from the posts themselves.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The states

There are four *phases*, and the phase where the ball is in the human's court has two flavors, because "blocked on you" is useless without saying what you owe. The split is exactly one question: **do they have to answer something, or do they have to go do something?**

**On the agent**

- 🔄 `:arrows_counterclockwise:` **in-process** — long-running work only, and ephemeral. The tile appears only when a turn is expected to run five minutes or more, laid from the kickoff note that opens such a turn (reply-shape.md), and comes off when the run stops.

**No status tile** means no human handoff is pending. The conversation remains open: the agent may have answered, completed a reversible action, or still own follow-through. Absence is intentionally not a fifth state and never requires a closing header.

**On the human** — the agent has stopped and cannot proceed without them.

- ❓ `:question:` **clarify** — they owe an *answer*. A choice, a judgment call, or a go on a plan.
- ✋ `:raised_hand:` **act** — they owe *work*. Something only they can do with their hands: their identity, a credential, a vendor console.

**Parked**

- 🗓️ `:calendar:` **scheduled** — flagged to resurface at a set time (reminder/cron set). **No resurface date = kill it, don't park it.** This is an outcome of a decision, not a third thing the agent can ask for.

**Closed**

- ✅ `:white_check_mark:` **done** — the user-level outcome is shipped / confirmed / complete. Finishing an agent turn, draft, commit, or subtask is not enough; the human confirms the item is done.

**There is no generic "blocked" state and `:no_entry_sign:` is retired.** Waiting on the outside world (a vendor, a build, a third party) is not a state of its own: with a resurface date it is 🗓️; without one it stays on the agent to chase.

## One vocabulary, every surface

**These are the same glyphs that close a chat message when it creates a lifecycle transition** — `## ❓ Clarify`, `## ✋ Act`, `## 🗓️ Scheduled`, or the close-out's `## Session Closed`, which is ✅'s header — same meaning on the root tile and at the foot of the reply. This file owns the semantics; each surface spec owns rendering. A message with no real transition has no lifecycle header and creates no tile.

So a real handoff's closing header and root-tile transition are one decision, not two, and they can never disagree: when a reply ends in `## ✋ Act`, the root tile becomes ✋ in the same turn. 🔄 is the only state that is never a header — it means the agent has not stopped yet. In a multi-agent phase, individual Brainstorm contributions and interim Challenge turns are non-terminal and never write lifecycle state; the phase produces one human-facing transition only when the human actually owes something.

**The header is the recommendation.** Naming which state the turn ended in is the whole point: the human should know from the header alone whether they owe an answer or have to go do something — before reading a word under it.

**Act only when the step genuinely needs their hands** — their identity, a credential, a vendor console, physical access. Before writing an Act step, ask whether you could do it yourself with the tools and access you have. If you could, do it and do not ask. Handing them work you were capable of doing is the failure this ordering exists to catch. Reaching for Clarify because it is the cheapest turn for you is the other one.

**Each step is as brief as physically possible and DRY against the rest of the message.** The step is the instruction and nothing else — the why, the branch, the tradeoff appeared in a section above; repeating them is how this section bloats. They glance up for detail; if a step cannot be understood by glancing up, fix the section above.

**Only one header per message.** If part of the work needs their hands and part needs a decision, that is Act, and the question rides along in the body.

**A “go” is a question, not a state of its own.** Ask for one only when the work is irreversible, outward-facing, costly, or outside existing authority. An explicit request already supplies authority for reversible in-scope work; do it instead of asking again. When a true go is required, write the recommendation before the question. It never gets its own header, because from the human's side a go and an answer are the same action.

**Clarify has a budget: one blocking question by default, three only when they are inseparable.** Clarify is the cheapest turn for you and the most expensive for them. Act on the confident majority and flag reversible assumptions. Never manufacture a choice from an unexplained or model-invented label. A question generated only because a format expects one is invalid.

**Completion does not create an ask.** Report the result and stop. Recommend closing only when the human is explicitly managing thread lifecycle or their confirmation changes durable state; do not turn every finished task into another Clarify.

Any Clarify may draw a question back instead of a "go." That is expected and needs no invitation. This is a two-actor handoff: the state always makes clear which actor owns the next move.

## Who acted

Agent identity is not a root tile: the reply's author is the agent. When more than one actor shares a thread, an action or next-step line is prefixed with its owner's glyph — 🦋 Liv, 🦊 Max, or 🙋 the human. A single-agent thread stays unprefixed.

## The root status tile

The human's root message carries **at most one adapter-held tile: the thread's lifecycle status**. One state for the thread, not per agent: nothing when no human handoff is pending; one of `:question:`, `:raised_hand:`, `:calendar:`, or `:white_check_mark:` for a real transition matching the closing header; 🔄 while a long turn runs. Nothing else goes on the root: model, harness, and thinking change mid-thread, and the author is already on every reply, so a root copy of provenance is wrong by construction.

### The per-message run signature

**Every visible agent post ends with the run signature, appended by the surface adapter**: the runtime tile, then `model → harness → thinking`. Provenance lives where it changes — a mid-thread model or thinking switch simply shows on the posts where it happened, and old signatures remain historical truth.

- **Harness:** the delivering harness tile. Omitted for native local models, which shortens the signature.
- **Model:** the resolved session model tile, read off the runtime and not the config default.
- **Thinking:** the resolved active-session reasoning level, normalized to `off`, `low`, `medium`, `high`, `max`, or `auto`. `auto` means the provider/runtime chooses. If the adapter cannot prove the effective value, it omits the tile and logs `thinking_unknown`; it never guesses from model family or raw token budget.

Which glyph maps to which model or harness is a runtime lookup owned by the instance, not a rule this spec fixes. Agents never type the signature themselves — the adapter appends it, and a hand-typed copy duplicates it.

### Transitions

**The tile is written by the surface adapter; agents never write reactions themselves.** When the agent creates a lifecycle transition, its closing header declares that state and the adapter derives the tile. An ordinary headerless result clears any prior agent-held transient tile but does not invent a human-held state. With one tile there is no order contract and nothing to re-lay: the adapter sets, swaps, or removes the status tile, and that is the whole write surface.

**A tile a human holds is never removed and never co-reacted**, and a human-held lifecycle tile owns the state outright — the adapter adds nothing beside it. Non-tile reactions are never touched.

**✅ is the human's decision** — their word in the thread or their own ✅ on the root. The word triggers the close-out and the adapter renders the tile; never ask for the reaction when the word was given.

**When a write fails the adapter journals the fault for scheduled review — never a post in the thread.** The journal and its digest are the monitor; a tile problem is cosmetic and must not cost the human a read. An unreported failure is how an agent believes it set a state it never set, so every fault and recovery is journaled.

**Cleanup is forward-only.** Roots from the retired provenance-strip era keep their old tiles until the thread sees another send, at which point the adapter removes its own legacy tiles; dormant threads stay as they are.

Examples:
- Ordinary answer or completed reversible action → root has no lifecycle tile; the reply ends naturally before the adapter's run signature
- Waiting on a go → root ❓; the asking post carries its own signature
- Long run → root 🔄 from the kickoff note, swapped for the closing state when the turn stops

Carve-outs — channels that get neither tile nor signature — live in the surface spec.

## Changelog

- **2026-08-22** — Lifecycle headers became transition-only: ordinary results end naturally, completion creates no automatic close request, and Clarify cannot be manufactured by reply shape.
- **2026-08-19** — RCR 2026-08-19-04: multi-agent contributions became non-terminal; each collaboration phase now produces one lifecycle handoff when it stops.
- **2026-08-18** — RCR 2026-08-18-01: the root shrank to the status tile alone; provenance moved to the per-message run signature; identity tiles and combined readings retired; cleanup forward-only.
- **2026-08-17** — RCR 2026-08-17-01/-02: status first, re-laid by a multi-account adapter; absence means active; 🔄 restricted to long runs via the kickoff note; faults journal-only.
- **2026-08-15** — RCR 2026-08-15-01: adapter named the strip's writer everywhere, ✅'s two triggers explicit, and the scheduled and close-out headers added.
- **2026-08-14** — Adapter got sole ownership of the strip, ✅ became the human's, re-lay failures route to a reviewed journal, the contract became right tiles in canonical order.
- **2026-08-08** — Added thinking provenance after each model tile (`off`→`auto`), resolved from the active session, omitted when unknown.
- **2026-07-23/28** — Strip moved to the thread root; "blocked" split into states naming what the human owes; `:no_entry_sign:`, ▶️, 👀, 📌, and the handshakes retired; states and closing headers became one vocabulary.
