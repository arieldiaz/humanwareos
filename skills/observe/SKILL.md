---
name: observe
description: Capture raw input into the append-only event stream. Use when anything arrives — a voice note, screenshot, article, call recording, thought, decision — that might matter later. Capture first, judge never.
---

# Observe

## Overview

Get the raw thing into the external stream at near-zero cost, in its rawest available form, with capture-time context. This is the foundation of everything else: you can't rederive what you didn't keep.

## When to use

Something arrived. That's the whole trigger. If you're debating whether it's worth capturing, it is — the filter lives at derivation time, not capture time.

## Process

1. **Recordings take care of themselves.** Audio/video captured on the Macs is auto-ingested, synced to the mini, and transcribed by the `ops/` pipeline. For those, /observe's only optional job is a sidecar note while context is fresh.
2. **For everything else, take the rawest form available.** Full article text over URL alone (pages die — save both), original file over description of the file.
3. **Place it in the spool:** `$STREAM_LOCAL/YYYY/MM/DD/HHMM-short-slug.ext` (the external stream — never inside this repo; see STREAM.md). Use the actual event time if known, capture time otherwise. The pipeline handles the rest.
4. **Write the sidecar** (`same-name.md`, 1–2 lines): what this is, why it caught attention. Ask the human for this if they haven't said — one inline question, and accept "skip."
5. **Stop.** No tagging, no filing, no summarizing, no "while I'm here." If a generated artifact is wanted now, that's a separate step into `generated/` with a provenance header.

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "I'll clean this up and save a nicer version" | The nicer version is a derivation. Save the mess; the mess is the data. |
| "This duplicates something already captured" | Duplicates are harmless. Missing events are not. |
| "Let me reorganize the stream while I'm in here" | The evidence stream is append-only. Organizing is what `generated/` indexes are for. |
| "This is too trivial" | Ten seconds of storage vs. an unanswerable question in three years. Capture it. |

## Exit criteria

The raw file and (usually) a sidecar exist in today's spool directory, correctly named, and nothing pre-existing in the stream was touched.
