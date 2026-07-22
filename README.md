# life-os

**An operating system for a life that compounds.**

Not a productivity template. Not a second-brain filing system. A small, opinionated framework for running your life the way good systems run: raw history you never lose, a loop you actually follow, and memory that makes every cycle smarter than the last. Built to be worked by AI agents (cloud for judgment, local for privacy) and edited like an essay.

Three ideas, fused:

1. **Event-stream everything.** Raw inputs — voice notes, screenshots, articles, call recordings, journal fragments — land in an append-only stream and are never edited. They are history. Everything useful (transcripts, summaries, plans, indexes) is *derived* from the stream and can be thrown away and re-derived later with better models. The stream is the source of truth; everything else is a cache. (Concept via [Machina's second-brain article](https://x.com/EXM7777/status/2073045719020343705).)
2. **A loop, not a pipeline.** Work moves through an OODA-shaped cycle — observe, orient, decide, act — plus review. Not just for code: for decisions, writing, health, projects, anything.
3. **Compounding.** Every cycle ends by writing back what was learned, so the next cycle starts smarter. This is the whole point. A system that doesn't compound is just a filing cabinet.

Borrowed with gratitude and skepticism: the prose-workflow style from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), the compounding loop and strategy anchor from [Every's compound engineering](https://github.com/EveryInc/compound-engineering-plugin). Dogma left at the door — no TDD religion, no Google worship. Verification is proportional to stakes, not ritual.

---

## The loop

```
            ┌──────────────────────────────────────────┐
            │                                          │
            ▼                                          │
  OBSERVE ──▶ ORIENT ──▶ DECIDE ──▶ ACT ──▶ REVIEW ──▶ COMPOUND
  capture     make        commit     do      compare    write it
  raw, no     sense,      to a      the      intent     back so
  judgment    connect     plan      work     vs result  next loop
              to memory                                 is easier
              & strategy

  REDERIVE runs orthogonally: regenerate any derived artifact
  from the stream whenever models or your questions improve.
```

| Command | Skill | What it does |
|---------|-------|--------------|
| `/observe` | [skills/observe](skills/observe/SKILL.md) | Capture raw input into the stream. Append-only, timestamped, never edited. |
| `/orient` | [skills/orient](skills/orient/SKILL.md) | Make sense of what's in front of you. Pull in STRATEGY.md and memory. Ask questions inline, one at a time. |
| `/decide` | [skills/decide](skills/decide/SKILL.md) | Turn orientation into a small, committed plan with explicit "done" criteria. |
| `/act` | [skills/act](skills/act/SKILL.md) | Execute in thin slices. Verify proportional to stakes. |
| `/review` | [skills/review](skills/review/SKILL.md) | Compare what happened to what was intended. Multiple lenses, no self-congratulation. |
| `/compound` | [skills/compound](skills/compound/SKILL.md) | Distill the cycle into memory. Update skills themselves when a lesson is structural. |
| `/rederive` | [skills/rederive](skills/rederive/SKILL.md) | Regenerate derived artifacts from the raw stream. |
| `/video-editor-social` | [skills/video-editor-social](skills/video-editor-social/SKILL.md) | Turn recordings into transcript-based highlights, clips, captions, chapters, and publishing assets. |

## Directory map

```
life-os/
├── README.md            ← you are here
├── CLAUDE.md            ← operating rules every agent session loads
├── STRATEGY.md          ← durable anchor: who you are, what matters, current tracks
├── STREAM.md            ← spec for the EXTERNAL stream store (the stream itself
│                          lives outside this repo — mostly A/V; see STREAM.md)
├── ops/                 ← the capture→sync→transcribe→backup pipeline
├── derived/             ← transcripts, summaries, indexes. Disposable, rederivable.
├── memory/              ← compounded learnings. The part that makes you smarter.
│   ├── index.md         ← map of what's in memory; read this first
│   ├── lessons/         ← one file per durable lesson
│   └── patterns/        ← recurring shapes you've noticed in your own life/work
├── agents/              ← the durable agents: Liv (Chief of Staff), Max (CEO).
│                          Few agents, many hats — see agents/README.md
├── skills/              ← loop and capability skills (the hats). Editable; /compound may edit them.
├── commands/            ← thin slash-command wrappers
└── .claude-plugin/      ← manifest so this installs as a plugin
```

## Agents: few loops, many hats

Where most frameworks spawn an agent per task, life-os keeps **a small roster of durable agents** — persistent working relationships that accumulate context — and has them wear the skills as hats. [Liv](agents/liv.md) (Chief of Staff) runs the week: triage, orientation, reviews, memory curation. [Max](agents/max.md) (CEO) runs the quarter: strategy, tracks, tradeoffs, the discipline of not doing things. You are the board. Continuity is the point: ephemeral agents start from zero every time; durable agents compound, which is the same bet the rest of this system makes. Details and rules in [agents/README.md](agents/README.md).

## Day to day

**Capture constantly, process on your schedule.** The stream is a drop zone — the cost of capture must stay near zero or you'll stop doing it. Recordings are ingested automatically by the `ops/` pipeline (record and forget); screenshots, articles, and quick text events go into the spool with a one-line sidecar if you have 10 seconds of context to add. That's `/observe`. No sorting, no tagging taxonomy, no guilt.

**Daily (minutes):** `/observe` all day as things happen. Once a day, ask Liv what's on deck — she glances at the stream's new arrivals and runs `/orient` on anything that pulls. Most things need nothing.

**Per piece of real work:** run the loop. `/orient` on the problem → `/decide` a small plan → `/act` → `/review`. For tiny tasks, collapse the middle — the loop is a shape, not a form to fill out.

**Weekly (30–60 min):** `/review` the week with Liv against STRATEGY.md, then `/compound`. This is the non-negotiable one — and insisting on it is literally Liv's job. Also skim `memory/index.md` — if it's getting stale or bloated, prune.

**Quarterly:** revisit STRATEGY.md with Max. Run `/rederive` on anything worth refreshing — old voice notes with a better transcription model, an old year's stream with a "what was I actually worried about in 2026?" question you couldn't have asked before.

## Using with Obsidian

This repo *is* an Obsidian vault — open the folder in Obsidian and you're done. Obsidian is the human surface (essays, weekly reviews, wandering memory via backlinks and graph); AI agents are the loop-runners, working the same files through Claude Code / Cowork and local models. Same markdown, two lenses, no migration ever.

Settings that keep the vault portable:

- **Files & Links → Use [[Wikilinks]]: OFF.** Standard markdown links only, so every file works outside Obsidian.
- The stream is **not** part of the vault — it's audio/video/photos handled by the `ops/` pipeline outside this repo. Obsidian sees the text layers: essays, `derived/` transcripts, `memory/`, strategy.
- `.gitignore` already excludes per-machine workspace state; shared plugin/theme config can be tracked if you want both Macs to match.

## Stream data architecture (external, local-only)

**The stream lives entirely outside this repo** — it's mostly voice, video, photos, and screenshots, and it never touches git or the cloud. Full spec and topology in [STREAM.md](STREAM.md); working machinery in [ops/](ops/README.md). The short version:

```
 MacBook ──spool──▶ Mac mini ──nightly──▶ QNAP NAS
 capture only       canonical store        stream backup +
 (auto-ingested,    Whisper transcribe     video archive
  synced, then      Qwen derivation        (ethernet to mini)
  deleted locally)  serves live sessions
```

**Privacy tiers** (enforced by CLAUDE.md, honored by every agent):

| Tier | What | Where it may go |
|------|------|-----------------|
| 0 | Raw stream data (audio, video, images, exports, sidecars) | This network only. Derivation by **local models** (Whisper + Qwen on the mini). Never into cloud-model context, never to a remote. |
| 1 | `derived/` | Local by default. A specific artifact may be shared into a cloud-agent session deliberately, per item. |
| 2 | `memory/`, `STRATEGY.md`, skills, this README | Curated text. This is what cloud agents load and work from. |

The flow: record anywhere → auto-ingest to the spool → sync to the mini → Whisper transcribes with timestamps into `derived/` → cloud agents (Claude et al.) do the high-level loop work from tiers 1–2. Cloud models bring judgment; local models bring eyes and ears. As local models improve, `/rederive` re-runs the eyes-and-ears layer — which is the whole bet.

**Backups replace git for the stream.** The mini is the single canonical copy (the MacBook deliberately keeps nothing), so the NAS backup is not optional — it's the other half of the design. NAS snapshots guard against ransomware/fat-fingers; a periodic offline or offsite encrypted copy on top guards against the failure modes a powered-on box can't. Append-only data backs up incrementally for free.

## Why the stream is sacred

This repo's relationship to the [event-stream idea](https://x.com/EXM7777/status/2073045719020343705) is: **capture is write-once, understanding is re-runnable.** Today's transcription of a voice note is today's best effort. In two years, a better model re-reads the same audio and hears the hesitation before you said yes. If you'd saved only the transcript, that's gone. So:

- The stream is legally read-only in this house. Agents refuse to edit it. You should too.
- Nothing in `derived/` is precious. Delete freely; `/rederive` rebuilds.
- `memory/` sits in between — it's derived, but it's *curated* derivation. It gets pruned and rewritten, with the stream as its audit trail.

## Customizing (please do)

Everything here is a draft of your system, not the system. The skills are prose — edit them the way you'd edit an essay. When `/compound` surfaces a lesson about the *process itself* ("I always over-plan", "reviews work better as voice notes"), let it edit the skill files. The framework is inside its own loop.

### The template/instance pattern

This repo is a **GitHub template**, meant to stay generic. Your life goes in a private instance:

1. **Create your instance:** "Use this template" (or fork) → a *private* repo named `<you>-os`. That's where STRATEGY.md gets filled, `memory/` accumulates, and your machines' config lives. Nothing personal ever goes in the template.
2. **Wire the upstream:** in your instance, `git remote add upstream https://github.com/arieldiaz/life-os.git`. Pull framework improvements down with `git fetch upstream && git merge upstream/main` (expect small, clean merges — the template only holds generic files).
3. **Send improvements back — deliberately, never wholesale.** When living in your instance produces a structural improvement (a sharper skill, a better rule, a pipeline fix), *genericize it* — strip names, paths, personal context — commit it on a branch cut from `upstream/main`, and PR it here. The flow is one-way by default: instance → template only by extraction, template → instance by merge.
4. Keep agent definition files template-clean in your instance too: what Liv and Max *are* belongs in `agents/`; what they *know about you* belongs in your `memory/`. This keeps upstream merges painless and your private context private.

The framework is the transferable part (loop, tiers, stream discipline); the `ops/` pipeline assumes two Macs and a NAS and will need adapting to your hardware. `STRATEGY.md` and `memory/` ship empty on purpose — they're yours to fill, and they're the whole point.

**Status:** v0.1 — the framework is thought through; the pipeline scripts are a working first draft, not yet hardened by months of daily use. Issues and war stories welcome.

## Install

```
/plugin marketplace add arieldiaz/life-os
/plugin install life-os
```

Or just open this folder in Claude Code / Cowork — `CLAUDE.md` does the rest.

## Sources & inspirations

This framework stands on three borrowed ideas, remixed:

- **The compounding loop and strategy anchor** — [Every's compound engineering](https://github.com/EveryInc/compound-engineering-plugin) ([essay](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents)): each unit of work should make the next one easier. Generalized here from code to everything.
- **Prose-workflow skills with anti-rationalization tables** — [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills): skills as workflows agents follow, with excuses pre-rebutted. Borrowed the form, dropped the TDD liturgy.
- **Event-stream everything** — [Machina's "How to build a second brain" article](https://x.com/EXM7777/status/2073045719020343705): capture raw and append-only, derive understanding, re-derive as models improve.

Plus a general OODA-loop shape (Boyd), because observe–orient–decide–act was the right skeleton all along.

## License

[MIT](LICENSE).
