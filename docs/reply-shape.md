# Reply shape

How an agent conversation and reply are structured, on any surface. Surface mechanics: `docs/slack-style.md` or `docs/buzz-style.md`; lifecycle states: `docs/status-framework.md`. Layer 2 spec — `docs/agent-context-hierarchy.md`.

Budget: 500 words.

## Replies should be succinct and accurate

Use headers and bullets when the human must act on several things or compare options. Answers, opinions, and thinking together are paragraphs. Avoid consultant theater: extra headings, labeled paragraphs, actionless action sections, and repeated conclusions. When in doubt, write prose and stop sooner.

One header is always earned: the closing turn header, even on a one-line answer. Sole exception: the goal post below, which hands its header to the turn's last message.

**A turn expected to exceed five minutes opens with a one-line kickoff note** with no closing header; the adapter reads a headerless reply as 🔄 in-process. Shorter turns send no interim messages.

## Conversation topology

**Only the human creates roots.** Collect sub-agent and multi-model work into the existing thread. The exception is an approved **spin-out**: create its root and begin work that turn.

**The first agent post in a work thread is one short `Goal:` line.** Put detail in replies that turn. Lay the root strip before the first substantive reply. One independently closeable item gets one root; a root without worked replies is only an announcement.

An explicit @mention always gets a response; when acknowledgment is enough, a reaction is the whole turn. Surface guest and trigger rules may narrow this.

## Three sections to each reply

A structured reply has three H2 sections. A short prose answer keeps only the last.

1. `## TLDR` — one to three plain sentences sufficient for the decision.
2. `## Background` — brief context; no critical fact lives only here.
3. `## ❓ Clarify` or `## ✋ Act` — minimal numbered steps. Act contains only work requiring the human's hands; Clarify contains questions needed to proceed. A parking turn ends `## 🗓️ Scheduled`; a close-out ends with the shape below. Semantics: `docs/status-framework.md`.

## Shape by situation

- **Bugs and incidents** → fix, cause, and whether the human must act. Detail lives in the commit or worklog.
- **Postmortems** → what happened, recommendation, and human action. Three short sections.
- **Teaching** → answer first, keep the context that teaches, skimmable.
- **Exploring / thinking aloud** → prose without forced resolution. The closing header carries one light standing offer.
- **Long prose** → descriptive `###` headings after about three paragraphs. Bold labels are not headings.
- Never a loose closing paragraph, forced CTA, or internal action phrased as their instruction.

## Session close-out

After the human approves closure, send a one-line closed statement, then the detail as its own reply — next step and measured stats from the harness usage records, ending `## Next step` + `## Run`, never Clarify or Act; the adapter reads `## Run` as ✅.

Each session summary is also saved as markdown at the instance-defined path — chat history expires; the file is the durable record.
