---
name: rederive
description: Regenerate derived artifacts from the raw stream — because models improved, because the question changed, or because a derivation looks stale or wrong. Use for re-transcription, re-summarization, new indexes, or asking old events new questions.
---

# Rederive

## Overview

The payoff of keeping the stream sacred: any understanding can be rebuilt, better, later. Today's transcript is today's best effort; in two years a better model hears the hesitation in the same audio. Rederivation is also how you ask questions of your own history that you couldn't have thought to ask at capture time.

## When to use

Model capabilities jumped; a derived artifact seems wrong or thin; you have a new question ("what was I actually worried about in 2026?"); a periodic refresh of high-value derivations (key calls, decision logs).

## Process

1. **Identify sources from the stream, not from old derivations.** Old derived files tell you *what exists* (via provenance headers); the stream is what you actually read. Never derive from a derivation unless the raw source is genuinely gone.
2. **State the derivation question explicitly.** "Transcribe" and "what was the emotional temperature of this call" are different derivations of the same event. New questions are the main reason this skill exists — be ambitious with them.
3. **Route by tier.** Raw evidence never selects an execution provider implicitly. A cloud profile may receive a bounded raw item only with explicit per-item human approval; otherwise stop visibly when no approved private route exists. Rederivations that read only approved `generated/` text may use an allowed profile.
4. **Generate into `generated/`** with a full provenance header: sources, date, model/tool, derivation question, and data-scope decision. Overwrite the stale version or version it — deriver's choice; nothing here is precious.
5. **Diff against the old derivation when one exists.** Material differences are interesting twice: the new understanding itself, and what the gap says about what else derived-and-old might be wrong. Big gaps are worth a line in the stream ("re-transcription of X changed the record materially").
6. **Never touch the stream.** Rederivation reads history; it does not improve it. If a source event turns out to be mislabeled, the correction is a new event.

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "The old summary is probably fine" | Probably — which is why rederivation targets high-value events and new questions, not everything. But 'probably fine' from a two-year-old model is a hypothesis, not a fact. |
| "Just patch the raw file's sidecar to match" | The sidecar is part of the event. Append a correction event; never rewrite the past to agree with the present. |
| "Rederive everything, models got better" | Rederive what has a question attached. Bulk rederivation without questions is expensive noise. |

## Exit criteria

New derivations in `generated/` with complete provenance, meaningful diffs noted, evidence untouched.
