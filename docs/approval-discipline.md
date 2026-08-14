# Approval discipline

**Draft, 2026-07-28.** Not yet in force. Sibling to `docs/status-framework.md`, which owns what the two headers mean; this file owns when an agent is allowed to ask for anything at all. `▶️ Approve` was retired on 2026-07-28 — a go is now a Clarify question with the recommendation written in — but the asymmetry below is unchanged, because the cheap ask just moves into the question.

## Proposed replacement for `docs/reply-shape.md` § The three areas

> **Every reply has three parts, in this order, always.**
>
> 1. **TLDR.** The answer, at the top, no heading. If they read only this they are correctly informed. Bad news first.
> 2. **Background.** Everything else, and it is *skippable by design* — nothing needed to act on the reply lives here. Use `## ` sections once it runs long.
> 3. **Action needed.** The last thing on the page. Everything they owe, stated in full, in one place, under exactly one of `## ❓ Clarify` / `## ✋ Act` naming what kind of thing they owe.
>
> Four rules follow from the shape, and each one is how it actually gets broken:
>
> - **No question appears outside part 3.** Not rhetorical, not "let me know if," not parenthetical.
> - **No instruction appears outside part 3.** If they have to do it, it is in the last section or it does not exist.
> - **Part 3 is self-contained.** It never points at a paragraph above it and never summarizes one. Stated in full, right there.
> - **If part 2 cannot be skipped, it belonged in part 1.** Anything load-bearing moves up; what remains is optional by construction.

## The failure

A list of "say go and I'll…" items is cheap for the agent and expensive for the human. Writing "say go and I'll do X" costs nothing, feels responsible, and quietly hands over a decision. The human pays attention for every item, on every turn. That asymmetry is the whole mechanism — nothing else needs to go wrong for the list to grow every turn until the reply is an inbox.

The tell is that the items are the agent's ideas. He asked one question; he now owes three answers about work he never requested.

## Rules

**A go means the thinking is already finished, in the conversation, before this message.** He has seen the plan, it is clear, and one word launches it. If the item first appears in the same message as the ask, it is not a go — it is a proposal. Proposals live in the body, or nowhere.

**One item.** If there are two, either the second is part of the first, or it was not worth interrupting him for. A numbered list of goes is the smell.

**Never re-list a pending ask.** Once asked, it stays asked. He does not need a running tally, and repeating it every turn converts a standing go into nagging while the list grows.

**Your own ideas are not his queue.** Something you thought of is yours to do, drop, or hold. He gets asked only where his identity, his taste, his money, or an irreversible action is genuinely in the way.

**When nothing needs him, say that.** One line. An empty turn is a good turn.

**Every ask lives in the closing section, and nowhere else.** The body is statements: what happened, what is true, what was done. No questions in it, not even rhetorical ones, and no "let me know if" tucked into a paragraph. An ask raised earlier and then restated at the bottom is asked twice; an ask raised earlier and *not* restated is hidden. One place, every time, so the reader knows exactly where to look for what they owe.

**Always numbered, most important first.** A numbered list even when there is one item, so anything can be answered by number. Item 1 is the thing that matters most — not the first that occurred to you, not the cheapest to answer, not the one in the order you happened to do the work.

**One action per numbered item, written as an imperative.** No compound sentences, no "and then", no rationale riding along. Four things to do is four numbered lines, each one short enough to read at a glance and check off. Bundling them into one sentence is how a to-do list gets turned back into prose, and it is the most common way this section fails even when everything else about it is right.

**The closing section is self-contained.** It is the last thing on screen and often the only thing read, so the question or instruction is stated there in full, with whatever it depends on. Never a pointer to a paragraph above it, never a summary of one. A step that only makes sense after re-reading the body is a step that failed, and compressing a real question into a label is worse than not asking.

## The test

Two questions, in order.

1. **Could I have just done it?** Then do it. Handing back work you were capable of doing is the failure the Act/Clarify ordering already exists to catch.
2. **Would he be annoyed if I did it without asking?** If no, it was never an ask. If yes, that is a real one — ask, once, in one line.

## ❓ Clarify

1. Right now every message must end in exactly one of `❓ Clarify` / `✋ Act`. On a turn where nothing is actually needed from you, that rule demands an ask that does not exist, so the agent invents one — which may be the root cause of the whole problem this file describes. Do you want a legal "nothing needed" close added as a third form, or the mandatory header dropped so a turn can simply end? Either answer also edits `docs/reply-shape.md` and `docs/slack-style.md`.
