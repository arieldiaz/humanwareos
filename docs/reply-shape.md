# Reply shape

How an agent reply is structured, on any surface. Slack mechanics are `docs/slack-style.md`; lifecycle states are `docs/status-framework.md`. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 1,500 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped.

## The one thing to get right

**Most replies should be short prose. Structure is earned, not default.**

Headers and bullets are for when the human has to *act* on several separate things, or compare several options. Everything else — answers, opinions, thinking together, "here's what I found" — is paragraphs. A three-answer reply does not need three headings; it needs three paragraphs.

The failure mode is always the same direction: turning a conversation into a consultant deliverable. Signs you have done it: more than two headings, a bolded label on every paragraph, an "Action Required" section listing something that is not an action, a closing line that restates what you just said, or explaining your reasoning about a tool instead of reporting the result. When in doubt, write it as prose and stop sooner.

**One header is always earned:** the closing turn header. A one-line prose answer still gets it. The single exception is a goal post, which carries the goal line alone and hands its closing header to the last message of the turn — `docs/slack-style.md`.

## The three areas

A structured reply has exactly three areas, in this order.

1. **An opening summary** — one to three sentences of plain prose, no heading, no bold, no bullets, carrying *all* the context: what happened, what it means, and anything that went wrong. They should be able to stop reading here and be correctly informed. This is a summary, not a token: a literal `TLDR:` prefix is allowed where it helps and never required.
2. **Details** — one or several `## ` sections. This is where the work shows.
3. **The closing turn header** — `## ❓ Clarify` or `## ✋ Act`, exactly one, minimal and numbered. Which to pick: `docs/status-framework.md`.

**Lead the opening summary with the bad news.** If something went wrong, you were wrong, a call was made under uncertainty, or the plan changed — that goes in the summary, before the good news, in your own words. Then give each of those its own section below so it is visible, not folded into a paragraph about something else.

**Detail in area 2 is sized by what they need, not by how much you did.** Keep what they must act on, verify, or would be wrong without: what was done, what was tried, what is blocked and why, the paths and commits. Cut proof of work — provenance nobody asked for, how confident you are, which docs you checked, the options you rejected, a caveat on a claim nobody disputed. Every sentence earns its place or moves to the commit message. Under-reporting is also a defect, but bloat is the one that actually happens.

**DRY across the whole message.** Any fact stated twice is a defect: say it once, in the place it belongs.

**Name each section for what is actually in it.** Section headers are written fresh for the message — `## What I found before merging`, `## How each conflict resolved`, `## Needs a second pair of eyes`. A situational header lets them skip a section they do not need; a generic one (`## Details`, `## Notes`, `## Summary`) makes them read it to find out. Two to five sections is the working range. The close-out set below is the only place headers are prescribed.

## Shape by situation

**Anything with work they have to do by hand** gets an explicit split: what is done, and what needs them, under `## Action Required`. Mandatory whenever it applies, and it survives every brevity rule — a manual step mentioned in passing gets lost across machines. The action sentence carries the most convenient deep link the system permits — the exact project, config, record, or control, never a dashboard or home page when a closer target is known — and names the exact field or key. If the action is "reply to confirm," the requested reply goes in quotes, defaulting to `"done"`. If nothing needs them, say so in one line. When the turn closes on `## ✋ Act`, that step is *also* in this split — the closing header points at it, it does not replace it.

**Bugs and incidents:** the fix, one line of cause, then whether anything needs them. No evidence trail, no file:line, no config mechanics, no git provenance, no menu of options. Detail goes in the commit message or a worklog.

**Postmortems:** what happened, the recommendation, what you need from them (often just approval). Three short sections, then stop. Never explain the mechanism twice.

**Teaching and how-to:** lead with the answer, keep the context that teaches — they want to understand, not just execute — but make it skimmable.

**When they are exploring, do not push to resolution.** In brainstorming and thinking-out-loud threads the exploration is the point, not a detour on the way to a deliverable. Do not end an exploratory turn by proposing to convert it into something, do not narrow toward a decision they have not asked for, and do not treat an unshipped idea as an open loop that needs closing. Keep opening the subject up. The closing header still appears, but carries a *light standing offer* rather than a decision request — and having been offered once, it stops being asked.

**Thinking out loud** — open-ended, no deliverable: real prose. No headers, no bullets, no CTA. Engage with the idea, offer a genuine reframe, ask a real question.

**Long prose replies get headings too — length is the trigger, not format.** Conversation mode licenses *prose instead of terse bullets*; it never licensed an unbroken block. Past roughly three paragraphs, or whenever the answer turns more than once, break it with real `## ` headings so they can find their way back in. The paragraphs stay prose; the separators just say where they are. A bolded lead-in sentence is not a heading.

**Never leave a loose closing paragraph or a forced CTA**, and never phrase an internal action as an instruction to them. The closing turn header is the sanctioned closer and replaces both.

## Session close-out

Bullets beat prose here, and every section carries a real `## ` heading — a bolded label is not a heading. The canonical set, in order: `## Done`, `## Action Required` (omitted only when nothing needs them, which is then stated in one line), `## Open Threads`, `## Session State` holding the honest all-clear, then the closing turn header. An unfinished agent or a running job gets named, not rounded up to done.

**The Slack close-out is not the record.** Before the close-out message goes out, write the durable session summary at the path the instance defines — one file per session, a page or less: what was decided, what shipped with commits or other proof, what is still open, where the detail lives. Chat history expires; that file is what a later session re-orients from. `## Session State` may not report an all-clear until the file exists and is committed.

**The final message, after the human has approved ✅**, is a different shape and ends with exactly two sections. Drop `## Session State` and the dangling "ready to close" line — the close *is* the conclusion.

1. `## Next step` — usually one line: nothing, marking it closed. If something genuinely carries forward, that is the line instead.
2. `## Run` — the execution summary, in bullets, generated by the instance's thread-stats tool. Never hand-write these numbers.

```
## Run
- 8.3h · 266 turns · opus · 16 msgs from you / 15 from me
- 1,151 words in / 6,080 out · 55.2M tokens in / 149k out
- API list: $62 cached / $280 uncached · Actual: $0 on sub
- Efficiency: two full reads of a 500-line spec cost ~40k in; grep the section first next time
```

Token counts come from the harness transcript's per-turn `usage` records — the only place real numbers exist. A chat gateway's own session log holds visible messages only and undercounts by roughly 100×. The dollar figure is a counterfactual: what the work would have cost metered, against what was actually billed on the subscription. The cost bullet is numbers, not narration. Both API figures always appear: the cached/uncached ratio is what shows caching earning its keep.

The last bullet is the only one you write yourself: one or two concrete efficiency observations **from this thread** — a wasted full-file read, a subagent that should have been a grep, a model tier heavier than the work needed, a session that should have been sunset earlier. It is a post-mortem, not a disclaimer: no generic advice. If the run was genuinely efficient, say that in a few words and stop.
