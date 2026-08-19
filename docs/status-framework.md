# Status framework

The shared status taxonomy for Humanware OS and any instance built on it. Every item is in exactly one lifecycle state. The surface adapter signals it with a single status tile on the human's thread root; who ran what, on which model, is read from the posts themselves.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The states

There are four *phases*, and the phase where the ball is in the human's court has two flavors, because "blocked on you" is useless without saying what you owe. The split is exactly one question: **do they have to answer something, or do they have to go do something?**

**On the agent**

- 🔄 `:arrows_counterclockwise:` **in-process** — long-running work only, and ephemeral. **No status tile at all also means on the agent:** an ordinary turn moves straight from one stopped state to the next and never cycles through 🔄. The tile appears only when a turn is expected to run five minutes or more, laid from the kickoff note that opens such a turn (reply-shape.md), and comes off with the turn's closing header.

**On the human** — the agent has stopped and cannot proceed without them.

- ❓ `:question:` **clarify** — they owe an *answer*. A choice, a judgment call, or a go on a plan.
- ✋ `:raised_hand:` **act** — they owe *work*. Something only they can do with their hands: their identity, a credential, a vendor console.

**Parked**

- 🗓️ `:calendar:` **scheduled** — flagged to resurface at a set time (reminder/cron set). **No resurface date = kill it, don't park it.** This is an outcome of a decision, not a third thing the agent can ask for.

**Closed**

- ✅ `:white_check_mark:` **done** — the user-level outcome is shipped / confirmed / complete. Finishing an agent turn, draft, commit, or subtask is not enough; the human confirms the item is done.

**There is no generic "blocked" state and `:no_entry_sign:` is retired.** Waiting on the outside world (a vendor, a build, a third party) is not a state of its own: with a resurface date it is 🗓️; without one it stays on the agent to chase.

## One vocabulary, every surface

**These are the same glyphs that close every chat message** — `## ❓ Clarify`, `## ✋ Act`, `## 🗓️ Scheduled`, or the close-out's `## Session Closed`, which is ✅'s header — same meaning on the root tile and at the foot of the reply. This file owns the semantics; each surface spec owns rendering.

So a turn's closing header and the root-tile transition are one decision, not two, and they can never disagree: when a reply ends in `## ✋ Act`, the root tile becomes ✋ in the same turn. 🔄 is the only state that is never a header — it means the agent hasn't stopped yet.

**The header is the recommendation.** Naming which state the turn ended in is the whole point: the human should know from the header alone whether they owe an answer or have to go do something — before reading a word under it.

**Act only when the step genuinely needs their hands** — their identity, a credential, a vendor console, physical access. Before writing an Act step, ask whether you could do it yourself with the tools and access you have. If you could, do it and do not ask. Handing them work you were capable of doing is the failure this ordering exists to catch. Reaching for Clarify because it is the cheapest turn for you is the other one.

**Each step is as brief as physically possible and DRY against the rest of the message.** The step is the instruction and nothing else — the why, the branch, the tradeoff appeared in a section above; repeating them is how this section bloats. They glance up for detail; if a step cannot be understood by glancing up, fix the section above.

**Only one header per message.** If part of the work needs their hands and part needs a decision, that is Act, and the question rides along in the body.

**A "go" is a question, not a state of its own.** When you have a plan and want the green light, that is a Clarify question whose recommended answer you already wrote: say what you intend to do, and that you will do it unless they say otherwise. It never gets its own header, because from their side a go and an answer are the same action — reading one line and replying.

**Clarify has a budget: batch it, and cap it at three.** Clarify is the cheapest turn for you and the most expensive for them. Every ambiguity goes in one message, never a drip across turns. If you cannot get under three questions, the right move is usually to act on the confident majority and flag the rest as reversible assumptions. Work they have not read yet is never a one-word go: a first draft or a new analysis is a real question, because nobody can green-light what they have not evaluated.

**When the work is done, ask them to close the thread** — "Recommend closing this. Say the word and I'll mark it done." That is a Clarify, and it is the only ask in the message.

Any Clarify may draw a question back instead of a "go." That is expected and needs no invitation. This is a two-actor handoff: the state always makes clear which actor owns the next move.

## Who acted

Agent identity is not a root tile: the reply's author is the agent. When more than one actor shares a thread, an action or next-step line is prefixed with its owner's glyph — 🦋 Liv, 🦊 Max, or 🙋 the human. A single-agent thread stays unprefixed.

## The root status tile

The human's root message carries **exactly one adapter-held tile: the thread's lifecycle status** — zero or one. One state for the thread, not per agent: nothing while on the agent; one of `:question:`, `:raised_hand:`, `:calendar:`, or `:white_check_mark:` when a turn stops, matching the closing header; 🔄 while a long turn runs. Nothing else goes on the root: model, harness, and thinking change mid-thread, and the author is already on every reply, so a root copy of provenance is wrong by construction.

### The per-message run signature

**Every visible agent post ends with the run signature, appended by the surface adapter**: the runtime tile, then `model → harness → thinking`. Provenance lives where it changes — a mid-thread model or thinking switch simply shows on the posts where it happened, and old signatures remain historical truth.

- **Harness:** the delivering harness tile. Omitted for native local models, which shortens the signature.
- **Model:** the resolved session model tile, read off the runtime and not the config default.
- **Thinking:** the resolved active-session reasoning level, normalized to `off`, `low`, `medium`, `high`, `max`, or `auto`. `auto` means the provider/runtime chooses. If the adapter cannot prove the effective value, it omits the tile and logs `thinking_unknown`; it never guesses from model family or raw token budget.

Which glyph maps to which model or harness is a runtime lookup owned by the instance, not a rule this spec fixes. Agents never type the signature themselves — the adapter appends it, and a hand-typed copy duplicates it.

### Transitions

**The tile is written by the surface adapter; agents never write reactions themselves.** The agent ends its turn in the right state — that is what the closing header is — and the adapter derives the tile from it. With one tile there is no order contract and nothing to re-lay: the adapter sets, swaps, or removes the status tile, and that is the whole write surface.

**A tile a human holds is never removed and never co-reacted**, and a human-held lifecycle tile owns the state outright — the adapter adds nothing beside it. Non-tile reactions are never touched.

**✅ is the human's decision** — their word in the thread or their own ✅ on the root. The word triggers the close-out and the adapter renders the tile; never ask for the reaction when the word was given.

**When a write fails the adapter journals the fault for scheduled review — never a post in the thread.** The journal and its digest are the monitor; a tile problem is cosmetic and must not cost the human a read. An unreported failure is how an agent believes it set a state it never set, so every fault and recovery is journaled.

**Cleanup is forward-only.** Roots from the retired provenance-strip era keep their old tiles until the thread sees another send, at which point the adapter removes its own legacy tiles; dormant threads stay as they are.

Examples:
- Ordinary working turn → root has no tile; the reply ends `:lobster:` `:m_opus:` `:h_cc:` `:think_off:`
- Waiting on a go → root ❓; the asking post carries its own signature
- Long run → root 🔄 from the kickoff note, swapped for the closing state when the turn stops

Carve-outs — channels that get neither tile nor signature — live in the surface spec.

## Changelog

- **2026-08-18** — RCR 2026-08-18-01: the root shrank to the status tile alone; provenance moved to the per-message run signature; identity tiles and combined readings retired; cleanup forward-only.
- **2026-08-17** — RCR 2026-08-17-01/-02: status first, re-laid by a multi-account adapter; absence means active; 🔄 restricted to long runs via the kickoff note; faults journal-only.
- **2026-08-15** — RCR 2026-08-15-01: adapter named the strip's writer everywhere, ✅'s two triggers explicit, and the scheduled and close-out headers added.
- **2026-08-14** — Adapter got sole ownership of the strip, ✅ became the human's, re-lay failures route to a reviewed journal, the contract became right tiles in canonical order.
- **2026-08-08** — Added thinking provenance after each model tile (`off`→`auto`), resolved from the active session, omitted when unknown.
- **2026-07-23/28** — Strip moved to the thread root; "blocked" split into states naming what the human owes; `:no_entry_sign:`, ▶️, 👀, 📌, and the handshakes retired; states and closing headers became one vocabulary.
