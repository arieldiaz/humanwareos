# Status framework

The shared status taxonomy for Life OS and any instance built on it. Every item is in exactly one lifecycle state — there is nothing else. Agents (Liv 🦋 / Max 🦊) signal the state as part of the run strip on the human's thread root. **Lifecycle status is always the first reaction on the strip**, followed by an `agent → harness → model` triplet per agent in the thread.

Budget: 1,800 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The states

There are four *phases*, and the phase where the ball is in the human's court has three flavors, because "blocked on you" is useless without saying what you owe.

**On the agent**

- 🔄 `:arrows_counterclockwise:` **in-process** — actively being worked.

**On the human** — the agent has stopped and cannot proceed without them.

- ❓ `:question:` **clarify** — they owe an *answer*. The agent has no concrete plan yet.
- ▶️ `:arrow_forward:` **approve** — they owe a *word*. The plan is laid out and the agent will run it on a go.
- ✋ `:raised_hand:` **act** — they owe *work*. Something only they can do: their identity, a credential, a vendor console, their hands.

**Parked**

- 🗓️ `:calendar:` **scheduled** — flagged to resurface at a set time (reminder/cron set). **No resurface date = kill it, don't park it.** This is an outcome of an approve, not a fourth thing the agent can ask for.

**Closed**

- ✅ `:white_check_mark:` **done** — the user-level outcome is shipped / confirmed / complete. Finishing an agent turn, draft, commit, or subtask is not enough; the human confirms the item is done.

**There is no generic "blocked" state and `:no_entry_sign:` is retired** — it was doing three jobs badly, and the whole value of a status glyph in the channel list is that it says what to do about it. Waiting on the outside world (a vendor, a build, a third party) is not a state of its own: if it has a resurface date it is 🗓️, and if it does not, it is still 🔄 and on the agent to chase.

## One vocabulary, two surfaces

**These are the same glyphs that close every chat message**, as the `## ❓ Clarify` / `## ▶️ Approve` / `## ✋ Act` header — same character, same meaning, one on the root strip and one at the foot of the reply. Formatting rules for the header live with the surface (`docs/slack-style.md`); this file owns what the glyphs mean and which one to pick.

So a turn's closing header and the strip transition are one decision, not two, and they can never disagree: when a reply ends in `## ✋ Act`, the strip's status slot becomes ✋ in the same turn. 🔄 is the only state that is never a header — it means the agent hasn't stopped yet.

**The header is the recommendation.** Naming which state the turn ended in is the whole point: the human should know from the header alone whether they owe an answer, a "go," or work — before reading a word under it.

**Pick the lowest one that is honest.** Act only when the step genuinely needs their identity, a credential, a decision, or their hands. Before writing an Act step, ask whether you could do it yourself with the tools and access you have — merging a branch, editing config, restarting a service, filing the PR. If you could, it is Approve. Handing them work you were capable of doing is the failure this ordering exists to catch. Reaching for Clarify because it is the cheapest turn for you is the other one.

**Each step is as brief as physically possible and DRY against the rest of the message.** The step is the instruction and nothing else — the why, the branch name, the repo, the tradeoff all appeared in a section above, and repeating them here is the most common way this section bloats. They glance up for detail. If a step cannot be understood by glancing up, the section above it is the thing to fix.

**Only one header per message.** If you need an answer *and* have a plan contingent on it, that is Clarify and the plan waits. If part of the work needs them and part needs a go, that is Act, and the approval rides along in the body.

**Approve has a high bar, and work they have not read yet almost never clears it.** Approve means the thinking is finished and one word launches it. A first draft, a new piece of writing, an analysis they are seeing for the first time — those are Clarify, because nobody can approve what they have not evaluated yet. The reliable tell is the body: if the numbered steps are questions, the header was wrong no matter how finished the work underneath it feels.

**Clarify has a budget: batch it, and cap it at three.** Clarify is the cheapest turn for you and the most expensive for them. Every ambiguity goes in one message, never a drip across turns. If you cannot get under three questions, the right move is usually to Act on the confident majority and flag the rest as reversible assumptions — one ▶️ Approve beats five questions. Clarify is for when you genuinely have no concrete plan, or when the next move waits on their read of something new; not for de-risking a plan you already have.

**When the work is done, ▶️ Approve asks them to close the thread** — "Recommend closing this. Say the word and I'll mark it done." Never pair Approve with a step that asks for nothing: Approve means they owe a *word*, and the message cannot declare a closure it does not have. Done work awaiting sign-off is a real Approve, not an empty one, and it does not need a fourth header.

Any of the three may draw a clarifying question back instead of a "go." That is expected and needs no invitation. This is deliberately not an OODA loop — OODA is a single actor's loop; this is a two-actor handoff.

## Pickup & who acted

The agent's **identity reaction** (🦋 Liv / 🦊 Max) is the "I've got it" signal — there's no separate 👀. Combine identity with state to read who did what:

- 🦋✅ = Liv done · 🦊✅ = Max done
- 🦋🗓️ = Liv scheduled a follow-up · 🦊❓ = Max is waiting on an answer

## The run strip

Before an agent's first visible response in a thread, it reacts to the human's root message with the run strip. The strip is the durable thread-level ownership and lifecycle record; a per-message reply signature covers which runtime produced an individual message.

**Order is fixed and is the whole point of the strip:**

1. **Lifecycle status — always first, always exactly one.** One state for the thread, not per agent: `:arrows_counterclockwise:` while active, then one of `:question:`, `:arrow_forward:`, `:raised_hand:`, `:calendar:`, or `:white_check_mark:` as the outcome, matching the reply's closing header. `:white_check_mark:` requires the human to confirm the user-level outcome is complete; finishing an agent turn, draft, commit, or subtask does not count.
2. **Then one triplet per agent, in `agent → harness → model` order**, agents ordered by first involvement in the thread:
- **Agent:** `:butterfly:` for Liv, `:fox_face:` for Max.
- **Harness:** the delivering harness tile. Omitted for native local models, which collapses that agent's triplet to a pair.
- **Model:** the resolved session model tile, read off the runtime line and not the config default — a thread stays on the model it started with even after a pin flip.

Multiple agents and multiple models in one thread are fine — the strip just grows by whole triplets. Two agents reads `status · liv harness model · max harness model`.

Which glyph maps to which model or harness is a runtime lookup owned by the instance, not a rule this spec fixes. The instance keeps a tile table and this spec keeps the ordering contract.

### Transitions

**Any platform that orders reactions by first-added time — Slack included — forces a re-lay of the strip on every lifecycle transition.** Removing 🔄 and adding ✅ would park ✅ at the *end*. The transition procedure is therefore: read the root's current reactions, remove every strip reaction, then re-add them in canonical order. Non-strip reactions (anything a human added) are left alone. An agent joining a thread that already has a strip appends its own triplet and does not need to re-lay, since triplets are ordered by arrival anyway. Never blindly add a lifecycle reaction, and never leave two lifecycle reactions up. If the runtime model or harness changes mid-thread, replace that agent's corresponding tile before the next visible reply.

Examples:
- Max on Opus via Claude Code, working → 🔄 🦊 `:h_cc:` `:m_opus:`
- Max on GPT via Codex, done → ✅ 🦊 `:h_codex:` `:m_gpt:`
- Liv on a native Llama fallback, waiting on a go → ▶️ 🦋 `:m_llama:`
- Both agents in one thread, working → 🔄 🦋 `:h_cc:` `:m_opus:` 🦊 `:h_codex:` `:m_gpt:`

Surface-specific carve-outs — channels that get no strip at all — live with the surface: `docs/slack-style.md`.

## Changelog

- **2026-07-26** — Split "blocked" into ❓ clarify / ▶️ approve / ✋ act and retired `:no_entry_sign:`. The three are simultaneously the lifecycle states and the closing header of every reply, so the strip and the message can no longer disagree. ❓ returns with a defined meaning after being dropped as a handshake reaction on 2026-07-23 — it is now a lifecycle state, not an ack.
- **2026-07-25** — Fixed the run-strip order: status first *always*, then `agent · harness · model` per agent. Because reactions sort by first-added time, a lifecycle transition now re-lays the whole strip instead of appending the new state at the end.
- **2026-07-23** — Made the thread root the canonical home for the complete run strip. Pickup must land before the first visible agent reply; lifecycle replaces in place while owner/model/harness persist.
- **2026-07-23** — Established as a global framework, then reduced to its core. Removed 👀 (pickup is the identity reaction), 📌 parked (replaced by schedule-or-kill under 🗓️), and the handshake reactions 🎯/❓/🧠/🙈 — the thread itself carries acknowledgment.
