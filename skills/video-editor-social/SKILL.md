---
name: video-editor-social
description: Turn recorded audio or video into transcript-based editing plans, highlights, clips, captions, chapters, and social publishing assets. Use for OBS recordings, talks, demos, interviews, long voice notes, podcast/video sessions, marker-driven clipping, caption generation, YouTube chapters, short-form clips, and repurposing recordings for social channels without copying any vendor-specific editor workflow.
---

# Video Editor Social

## Overview

This is the transcript-first editing and repurposing layer. Recording happens elsewhere; this skill turns a completed recording into derived artifacts: normalized transcripts, marker-aware highlights, candidate clips, caption instructions, chapter lists, ffmpeg cut plans, edit decision lists, and channel-specific publishing copy.

Keep the skill capability-oriented. Do not name or model it after a specific editor, capture device, or controller. Product-specific integrations belong in adapters; creator-specific taste belongs in the private instance or memory.

## Inputs

Supported media: `wav`, `m4a`, `mp3`, `mp4`, `mov`, `mkv`.

Supported text and metadata: `json`, `srt`, `vtt`, `txt`, OBS metadata, controller markers, cursor metadata, project context, and sidecar notes.

Prefer local transcript engines that preserve timestamps: Whisper, Whisper.cpp, or WhisperX. Treat JSON as the canonical transcript shape when available; derive `txt`, `srt`, and `vtt` from it.

## Privacy And Routing

1. **Work from derived text first.** Transcripts and marker files are the normal working set. Read raw video only when the human explicitly grants access to that item or when a local model/tool performs the analysis.
2. **Keep raw media local.** Audio/video frames are Tier 0 in a Life OS stream. Cloud agents may plan, score, and write from transcripts; local tools such as Whisper, Qwen, ffmpeg, and computer-vision scripts touch raw media.
3. **Write outputs as derivations.** Clips, captions, edit lists, chapters, and publishing copy go under `derived/` with provenance. Never modify the source recording.

## Workflow

1. **Locate the source event and transcript.** If no timestamped transcript exists, route to `/rederive` or the local transcription pipeline before editing.
2. **Normalize the transcript.** Preserve timestamps, speaker labels when available, paragraph breaks, and source metadata. Prefer a single canonical JSON transcript plus export formats as needed.
3. **Ingest markers.** Treat manual markers from keyboard, OBS, MIDI, controller, JSON imports, or future APIs as first-class high-signal objects. For each marker, inspect roughly 90 seconds before and after it before running broader detection.
4. **Find candidate moments.** Score clips for clarity, novelty, emotion, story density, usefulness, quotability, standalone value, project relevance, and taste fit if an override supplies taste.
5. **Return several views.** When useful, label candidates by angle: viral, intellectual, educational, personal, story, founder, relationship, product-demo, philosophical, or tactical. Do not force every recording into every angle.
6. **Select clips.** Good clips begin near the idea, end on a completed thought, work standalone, and contain one main idea. Avoid logistics, excess setup, generic advice, shallow outrage, and filler.
7. **Plan edits.** Produce in/out timestamps, rationale, caption guidance, visual enhancement notes, and ffmpeg commands or edit decision lists. Cut with stream copy when acceptable; re-encode only when the target format needs it.
8. **Generate publishing assets.** Produce only the assets that fit the clip or recording: short title, long title, X post, YouTube description, YouTube chapters, Shorts title, Reels caption, Notion summary, or Substack seed draft.
9. **Leave provenance.** Every output bundle should state source event path or id, transcript path, marker source, model/tool choices, date, and what was generated locally versus by a cloud agent.

## Marker Schema

Use this minimal marker shape unless an adapter provides a richer one:

```json
{
  "timestamp": "00:14:32.000",
  "type": "highlight",
  "label": "clip this",
  "source": "manual"
}
```

Manual markers override generic AI curiosity. If a manually marked area seems weak, still explain why it might not work as a clip instead of silently dropping it.

## Visual Enhancements

This skill can suggest lightweight visual enhancement instructions, not full-editor timelines.

Use cursor emphasis when cursor metadata or frame analysis supports it:

- cursor halo
- click pulse
- cursor enlargement
- cursor focus

Use smart zoom when code or UI is small, the cursor pauses, the transcript says "look here", "notice", or "key point", or a marker exists near the moment.

Default smart zoom parameters:

```yaml
scale: 1.4
max_scale: 1.8
duration: 0.35
padding_px: 120
```

## Captions And Chapters

Captions should be readable, clean, minimal, and faithful to the speaker's voice. Avoid spammy kinetic-caption tropes unless the human explicitly asks for that style.

Create chapters around markers, topic changes, demo transitions, project transitions, and completed ideas. Generate YouTube chapters, Notion sections, or transcript sections as separate outputs when needed.

## Controller Abstraction

Treat physical controls as generic marker sources. Life OS should define actions, not device-specific identity:

- `highlight`
- `clip-this`
- `mistake-cut`
- `chapter`
- `product-demo`
- `personal-story`
- `project-moment`
- `publish-target`
- `zoom-intensity`
- `caption-density`

Device-specific mappings belong in the private instance.

## Output Bundle

For a completed pass, create or update a bundle like:

```text
derived/video-editor-social/<event-slug>/
|-- README.md
|-- transcript.normalized.json
|-- highlights.json
|-- clips.edl.json
|-- captions.srt
|-- chapters.md
`-- publishing.md
```

Only include files actually produced. The `README.md` should contain provenance, candidate clip table, selected outputs, and rederivation notes.

## Rationalizations

| Excuse | Rebuttal |
|--------|----------|
| "Just skim for punchy lines" | Good clips often depend on setup, release, and completed thought. Read enough transcript to defend the edit. |
| "A marker means auto-publish it" | A marker is high-signal, not a publishing decision. It earns review first. |
| "Every clip needs every channel" | Repurposing should respect fit. Some moments are good chapters, not shorts. |
| "Fix it by editing the source file" | Source recordings are stream history. Create derived clips and edit lists; leave the original untouched. |

## Exit Criteria

The recording has a timestamped transcript or a clear local transcription route; candidate moments are scored with reasons; selected clips have precise in/out points and edit instructions; captions, chapters, and publishing copy exist where useful; provenance makes the bundle rederivable; raw media remains untouched.
