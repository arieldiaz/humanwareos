# Reply shape

How agent conversations and replies are structured, on any surface. Surface mechanics: `docs/slack-style.md` / `docs/buzz-style.md`; lifecycle states: `docs/status-framework.md`; layer 2: `docs/agent-context-hierarchy.md`.

Budget: 500 words.

## Replies should be succinct and accurate

Headers and bullets when the human must act on several things or compare options; otherwise paragraphs. No consultant theater: extra headings, labeled paragraphs, actionless action sections, repeated conclusions. When in doubt, write prose and stop sooner.

The closing turn header is always earned, even on a one-liner — except the goal post, whose header moves to the turn's last message.

**A turn expected to exceed five minutes opens with a one-line kickoff note**, headerless — it signals 🔄 (`docs/status-framework.md`). Shorter turns send no interim messages.

## Conversation topology

**Only the human creates roots**; sub-agent and multi-model work goes into the existing thread. Exception: an approved **spin-out**, whose root you create and work that turn.

**The first agent post in a work thread is one short `Goal:` line**, detail in replies that turn. One independently closeable item, one root; a root without worked replies is only an announcement. Scheduled and agent-initiated posts follow the same shape — short root, body threaded, run ending silently; automatic final-text delivery is for one-line notices, and structured-capable jobs carry this instruction in their payload.

An explicit @mention always gets a response — a reaction alone when acknowledgment is enough; guest and trigger rules may narrow this.

## Three sections to each reply

A structured reply has three H2 sections; short prose keeps only the last.

1. `## TLDR` — one to three plain sentences sufficient for the decision.
2. `## Background` — brief context; no critical fact lives only here.
3. `## ❓ Clarify` or `## ✋ Act` — minimal numbered steps: Act only work needing the human's hands, Clarify only questions blocking progress. A parking turn ends `## 🗓️ Scheduled`; a close-out, the shape below. Semantics: `docs/status-framework.md`.

## Shape by situation

- **Bugs, incidents, postmortems** → what happened, cause, recommendation, whether the human must act. Detail lives in the commit or worklog.
- **Teaching** → answer first, keep the context that teaches, skimmable.
- **Exploring / thinking aloud** → prose without forced resolution; the closing header carries one light standing offer.
- **Long prose** → descriptive `###` headings after about three paragraphs. Bold labels are not headings.
- Never a loose closing paragraph, forced CTA, or internal action phrased as their instruction.

## Session close-out

After the human approves closure: a one-line closed statement, then the detail as its own reply — next step, then `## Run` as four bullets: elapsed · turns · model; words and tokens in/out · context peak (% of window when known); API cached and uncached · `Actual: $0 on sub`; one efficiency observation. The instance's thread-stats tool generates these — never hand-write them. It ends `## Next step` + `## Run`, never Clarify or Act.

Each summary is saved as markdown at the instance-defined path — chat expires; the file is the record.
