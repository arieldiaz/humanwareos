# Status framework

The shared status taxonomy for Humanware OS and any instance built on it. Every item is in exactly one lifecycle state. Agents (Liv 🦋 / Max 🦊) signal it in the run strip on the human's thread root. **Lifecycle status is always first**, followed by an `agent → harness → model → thinking` provenance group per agent.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The states

There are four *phases*, and the phase where the ball is in the human's court has two flavors, because "blocked on you" is useless without saying what you owe. The split is exactly one question: **do they have to answer something, or do they have to go do something?**

**On the agent**

- 🔄 `:arrows_counterclockwise:` **in-process** — actively being worked.

**On the human** — the agent has stopped and cannot proceed without them.

- ❓ `:question:` **clarify** — they owe an *answer*. A choice, a judgment call, or a go on a plan.
- ✋ `:raised_hand:` **act** — they owe *work*. Something only they can do with their hands: their identity, a credential, a vendor console.

**Parked**

- 🗓️ `:calendar:` **scheduled** — flagged to resurface at a set time (reminder/cron set). **No resurface date = kill it, don't park it.** This is an outcome of a decision, not a third thing the agent can ask for.

**Closed**

- ✅ `:white_check_mark:` **done** — the user-level outcome is shipped / confirmed / complete. Finishing an agent turn, draft, commit, or subtask is not enough; the human confirms the item is done.

**There is no generic "blocked" state and `:no_entry_sign:` is retired** — it was doing three jobs badly, and the whole value of a status glyph in the channel list is that it says what to do about it. Waiting on the outside world (a vendor, a build, a third party) is not a state of its own: if it has a resurface date it is 🗓️, and if it does not, it is still 🔄 and on the agent to chase.

## One vocabulary, every surface

**These are the same glyphs that close every chat message**, as the `## ❓ Clarify` / `## ✋ Act` header — same character and meaning on the root strip and at the foot of the reply. This file owns the semantics; each surface spec owns rendering.

So a turn's closing header and the strip transition are one decision, not two, and they can never disagree: when a reply ends in `## ✋ Act`, the strip's status slot becomes ✋ in the same turn. 🔄 is the only state that is never a header — it means the agent hasn't stopped yet.

**The header is the recommendation.** Naming which state the turn ended in is the whole point: the human should know from the header alone whether they owe an answer or have to go do something — before reading a word under it.

**Act only when the step genuinely needs their hands** — their identity, a credential, a vendor console, physical access. Before writing an Act step, ask whether you could do it yourself with the tools and access you have: merging a branch, editing config, restarting a service, filing the PR. If you could, do it and do not ask. Handing them work you were capable of doing is the failure this ordering exists to catch. Reaching for Clarify because it is the cheapest turn for you is the other one.

**Each step is as brief as physically possible and DRY against the rest of the message.** The step is the instruction and nothing else — the why, the branch name, the repo, the tradeoff all appeared in a section above, and repeating them here is the most common way this section bloats. They glance up for detail. If a step cannot be understood by glancing up, the section above it is the thing to fix.

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

Before an agent's first visible response in a thread, it reacts to the human's root message with the run strip. The strip is the durable thread-level ownership and lifecycle record; a per-message reply signature covers which runtime produced an individual message.

**Order is fixed and is the whole point of the strip:**

1. **Lifecycle status — always first, always exactly one.** One state for the thread, not per agent: `:arrows_counterclockwise:` while active, then one of `:question:`, `:raised_hand:`, `:calendar:`, or `:white_check_mark:` as the outcome, matching the reply's closing header.
2. **Then one provenance group per agent, in `agent → harness → model → thinking` order**, agents ordered by first involvement in the thread:
- **Agent:** `:butterfly:` for Liv, `:fox_face:` for Max.
- **Harness:** the delivering harness tile. Omitted for native local models, which shortens that agent's provenance group.
- **Model:** the resolved session model tile, read off the runtime line and not the config default — a thread stays on the model it started with even after a pin flip.
- **Thinking:** the resolved active-session reasoning level, normalized to `off`, `low`, `medium`, `high`, `max`, or `auto`. `auto` means the provider/runtime chooses. If the adapter cannot prove the effective value, it omits the tile and logs `thinking_unknown`; it never guesses from model family or raw token budget.

Multiple agents, models, and thinking levels in one thread are fine — the strip grows by complete provenance groups. Two agents reads `status · liv harness model thinking · max harness model thinking`.

Thinking is provenance, not lifecycle. If it changes mid-thread, replace that agent's root thinking tile before the next reply; old per-message signatures remain historical truth. The semantic levels are shared across surfaces, while each surface owns its asset/render adapter.

Which glyph maps to which model or harness is a runtime lookup owned by the instance, not a rule this spec fixes. The instance keeps a tile table and this spec keeps the ordering contract.

### Transitions

**The strip is written by the surface adapter; agents never write reactions themselves.** One writer is the whole reason the order is stable. The agent ends its turn in the right state — that is what the closing header is — and the adapter derives the strip from it.

**Any platform that orders reactions by first-added time — Slack and Buzz included — forces a re-lay on every transition**, because removing 🔄 and adding ✅ would park ✅ at the end. The whole strip comes off and goes back on in canonical order, leaving human reactions alone and never leaving two lifecycle reactions. A second agent contributes its provenance group; a tile they share can only render once. Changed provenance replaces that agent's tiles.

**When the adapter cannot finish a re-lay it reports in the thread, never only to a log** — an unreported failure is how an agent comes to believe it set a state it never set.

**Only the human sets ✅**, by reacting on the root or saying the word. It is the one transition an agent cannot make alone.

Examples:
- Max on Opus via Claude Code, working → 🔄 🦊 `:h_cc:` `:m_opus:`
- Max on GPT via Codex at high thinking, done → ✅ 🦊 `:h_codex:` `:m_gpt:` `:think_high:`
- Liv on a native Llama fallback with thinking off, waiting on a go → ❓ 🦋 `:m_llama:` `:think_off:`
- Both agents in one thread, working → 🔄 🦋 `:h_cc:` `:m_opus:` `:think_auto:` 🦊 `:h_codex:` `:m_gpt:` `:think_high:`

Surface-specific carve-outs — channels that get no strip — live in the applicable surface spec.

## Changelog

- **2026-08-14** — Gave the surface adapter sole ownership of the strip, made ✅ the human's to set, and required re-lay failures to surface in the thread.
- **2026-08-08** — Added provider-neutral thinking provenance after each model tile: `off / low / medium / high / max / auto`, resolved from the active session and omitted when unknown.
- **2026-07-28** — Retired ▶️ approve and `:arrow_forward:`. Two human-facing states remain: ❓ answer something, ✋ go do something.
- **2026-07-26** — Split "blocked" into ❓ clarify / ▶️ approve / ✋ act and retired `:no_entry_sign:`. The three are simultaneously the lifecycle states and the closing header of every reply, so the strip and the message can no longer disagree.
- **2026-07-25** — Fixed the run-strip order: status first *always*, then `agent · harness · model` per agent.
- **2026-07-23** — Made the thread root the canonical home for the strip. Established as a global framework, then reduced to its core: removed 👀, 📌 parked, and the handshake reactions 🎯/❓/🧠/🙈.
