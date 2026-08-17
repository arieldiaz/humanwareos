# Status framework

The shared status taxonomy for Humanware OS and any instance built on it. Every item is in exactly one lifecycle state. Agents (Liv 🦋 / Max 🦊) signal it in the run strip on the human's thread root.

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

**These are the same glyphs that close every chat message** — `## ❓ Clarify`, `## ✋ Act`, `## 🗓️ Scheduled`, or the close-out's `## Run`, which is ✅'s header — same meaning on the root strip and at the foot of the reply. This file owns the semantics; each surface spec owns rendering.

So a turn's closing header and the strip transition are one decision, not two, and they can never disagree: when a reply ends in `## ✋ Act`, the strip's status slot becomes ✋ in the same turn. 🔄 is the only state that is never a header — it means the agent hasn't stopped yet.

**The header is the recommendation.** Naming which state the turn ended in is the whole point: the human should know from the header alone whether they owe an answer or have to go do something — before reading a word under it.

**Act only when the step genuinely needs their hands** — their identity, a credential, a vendor console, physical access. Before writing an Act step, ask whether you could do it yourself with the tools and access you have. If you could, do it and do not ask. Handing them work you were capable of doing is the failure this ordering exists to catch. Reaching for Clarify because it is the cheapest turn for you is the other one.

**Each step is as brief as physically possible and DRY against the rest of the message.** The step is the instruction and nothing else — the why, the branch, the tradeoff appeared in a section above; repeating them is how this section bloats. They glance up for detail; if a step cannot be understood by glancing up, fix the section above.

**Only one header per message.** If part of the work needs their hands and part needs a decision, that is Act, and the question rides along in the body.

**A "go" is a question, not a state of its own.** When you have a plan and want the green light, that is a Clarify question whose recommended answer you already wrote: say what you intend to do, and that you will do it unless they say otherwise. It never gets its own header, because from their side a go and an answer are the same action — reading one line and replying.

**Clarify has a budget: batch it, and cap it at three.** Clarify is the cheapest turn for you and the most expensive for them. Every ambiguity goes in one message, never a drip across turns. If you cannot get under three questions, the right move is usually to act on the confident majority and flag the rest as reversible assumptions. Work they have not read yet is never a one-word go: a first draft or a new analysis is a real question, because nobody can green-light what they have not evaluated.

**When the work is done, ask them to close the thread** — "Recommend closing this. Say the word and I'll mark it done." That is a Clarify, and it is the only ask in the message.

Any Clarify may draw a question back instead of a "go." That is expected and needs no invitation. This is a two-actor handoff: the state always makes clear which actor owns the next move.

## Pickup & who acted

The agent's **identity reaction** (🦋 Liv / 🦊 Max) is the "I've got it" signal — there's no separate 👀. Combine identity with state to read who did what:

- 🦋✅ = Liv done · 🦊✅ = Max done
- 🦋🗓️ = Liv scheduled a follow-up · 🦊❓ = Max is waiting on an answer or a go

The same glyphs mark ownership inline: when more than one actor shares a thread, an action or next-step line is prefixed with its owner — 🦋, 🦊, or 🙋 for the human. A single-agent thread stays unprefixed.

## The run strip

Before an agent's first visible response in a thread, the surface adapter lays the run strip on the human's root message: the durable thread-level ownership and lifecycle record. A per-message reply signature covers an individual message.

**The tiles, and the order they are laid in:**

1. **Lifecycle status — first, zero or one.** One state for the thread, not per agent: nothing while on the agent; one of `:question:`, `:raised_hand:`, `:calendar:`, or `:white_check_mark:` when a turn stops, matching the closing header; 🔄 while a long turn runs. It sits first: it is the tile the human scans for.

2. **One provenance group per agent, in `agent → harness → model → thinking` order**, agents ordered by first involvement in the thread:
- **Agent:** `:butterfly:` for Liv, `:fox_face:` for Max.
- **Harness:** the delivering harness tile. Omitted for native local models, which shortens that agent's provenance group.
- **Model:** the resolved session model tile, read off the runtime line and not the config default — a thread stays on the model it started with even after a pin flip.
- **Thinking:** the resolved active-session reasoning level, normalized to `off`, `low`, `medium`, `high`, `max`, or `auto`. `auto` means the provider/runtime chooses. If the adapter cannot prove the effective value, it omits the tile and logs `thinking_unknown`; it never guesses from model family or raw token budget.

Multiple agents, models, and thinking levels in one thread are fine — the strip grows by complete provenance groups. Two agents reads `status · liv harness model thinking · max harness model thinking`.

Thinking is provenance, not lifecycle. If it changes mid-thread, replace that agent's root thinking tile before the next reply; old per-message signatures remain historical truth. The levels are shared across surfaces; each surface owns its render adapter.

Which glyph maps to which model or harness is a runtime lookup owned by the instance, not a rule this spec fixes.

### Transitions

**The strip is written by the surface adapter; agents never write reactions themselves.** The agent ends its turn in the right state — that is what the closing header is — and the adapter derives the strip from it.

**The adapter re-lays the strip to canonical order — status first — on any send that finds it wrong; a canonical strip is a strict no-op.** Slack and Buzz order reactions by first-added time and only the account that added a reaction can remove it, so the adapter holds every agent's account and moves each tile with its own token: remove every agent-held tile, re-add in canonical sequence, verify once. Only a human-held tile is immovable — never removed, never co-reacted, excluded from the order contract; re-laid tiles land after it, which for a human ✅ still reads status-first. Non-strip reactions are never touched, a shared tile renders once, and changed provenance replaces only the changed tile.

**When a write fails the adapter journals the fault for scheduled review — never a post in the thread.** The journal and its digest are the monitor; a strip problem is cosmetic and must not cost the human a read. An unreported failure is how an agent believes it set a state it never set, so every fault and recovery is journaled.

**✅ is the human's decision** — their word in the thread or their own ✅ on the root. The word triggers the close-out and the adapter renders the tile; never ask for the reaction when the word was given.

Examples:
- Max on Opus via Claude Code, working an ordinary turn → 🦊 `:h_cc:` `:m_opus:` (no status tile)
- Max on GPT via Codex at high thinking, done → ✅ 🦊 `:h_codex:` `:m_gpt:` `:think_high:`
- Liv on a native Llama fallback with thinking off, waiting on a go → ❓ 🦋 `:m_llama:` `:think_off:`

Carve-outs — channels that get no strip — live in the surface spec.

## Changelog

- **2026-08-17** — RCR 2026-08-17-01/-02: status first, re-laid by a multi-account adapter; absence means active; 🔄 restricted to long runs via the kickoff note; faults journal-only.
- **2026-08-15** — RCR 2026-08-15-01: adapter named the strip's writer everywhere, ✅'s two triggers explicit, `## 🗓️ Scheduled` and `## Run` added to the closing headers.
- **2026-08-14** — Adapter got sole ownership of the strip, ✅ became the human's, re-lay failures route to a reviewed journal, the contract became right tiles in canonical order.
- **2026-08-08** — Added thinking provenance after each model tile (`off`→`auto`), resolved from the active session, omitted when unknown.
- **2026-07-23/28** — Strip moved to the thread root; "blocked" split into states naming what the human owes; `:no_entry_sign:`, ▶️, 👀, 📌, and the handshakes retired; states and closing headers became one vocabulary.
