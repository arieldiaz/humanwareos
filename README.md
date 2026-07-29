# Humanware OS

**The open operating system for the human side of AI.**

Software runs computers. Firmware runs hardware. Humanware helps a person
remember, decide, create, and act—with AI agents that build context instead of
starting over.

Humanware OS is a small, opinionated framework for giving durable agents shared
memory, a clear operating loop, and access to the interfaces you already use.
It is not another chatbot, productivity template, or second-brain filing
system. It is the layer that helps the human stay oriented and in command.

Four principles shape it:

1. **Human in command.** Agents bring judgment and context forward. The human
   remains the author, owner, and final decision-maker.
2. **Durable relationships.** A small roster of agents learns how you work over
   time. Fewer agents, deeper context.
3. **Memory that compounds.** Every meaningful cycle writes back what it
   learned, so the next one starts smarter.
4. **Your interfaces.** Work where conversation already happens and speak
   naturally—including voice.

The framework is open. The implementation is personal. Fork the system, name
your agents, and let your version grow around the life and work it supports.

---

## Clarify or Act

Humanware OS makes the handoff between human and agent explicit. Every active
thread starts 🔄 with the agent. When the agent stops, there are only two
questions:

- ❓ **Clarify** — the human owes an answer, judgment call, or go.
- ✋ **Act** — the human owes work only they can do with their identity, access,
  or hands.

Everything else is either 🗓️ scheduled to resurface at a real time or ✅ done
after the human confirms the outcome. There is no generic “blocked” state and
no open-ended someday pile.

The same language appears twice: as the status emoji on the thread and as the
final heading in the agent’s reply. The thread can be understood from the
channel list before anyone opens it.

## A visible record of who worked

The thread’s emoji strip carries provenance as well as status:

```
🔄 · 🦊 · Codex · GPT
```

The first emoji is the lifecycle state. Then each contributor adds an
agent → harness → model triplet:

- 🦋 **Liv** — personal Chief of Staff and system cadence.
- 🦊 **Max** — work, strategy, products, and tradeoffs.
- The harness and model tiles record which runtime produced the work.

The result is a compact answer to three questions: where is this, who owns it,
and what intelligence did the work? See
[docs/status-framework.md](docs/status-framework.md) for the complete contract.

## The skills underneath

Agents use a small set of editable skills to capture, make sense of, execute,
review, and compound work:

| Command | What it does |
|---------|--------------|
| `/observe` | Capture raw input into the append-only stream. |
| `/orient` | Connect the current situation to strategy and memory. |
| `/decide` | Commit to a plan with explicit done criteria. |
| `/act` | Execute in thin, proportionally verified slices. |
| `/review` | Compare intent with what actually happened. |
| `/compound` | Write the durable lesson back into the system. |
| `/rederive` | Regenerate derived artifacts as models improve. |

## Directory map

```
humanware-os/
├── README.md            ← you are here
├── AGENTS.md            ← operating rules every agent session loads
├── STRATEGY.md          ← durable anchor: who you are, what matters, current tracks
├── STREAM.md            ← spec for the EXTERNAL stream store (the stream itself
│                          lives outside this repo — mostly A/V; see STREAM.md)
├── ops/                 ← the capture→sync→transcribe→backup pipeline
├── infra/               ← instance infrastructure. secrets/ = the secrets
│                          layer, one source of truth for keys (Doppler by
│                          default — see its runbook.md)
├── derived/             ← transcripts, summaries, indexes. Disposable, rederivable.
├── memory/              ← compounded learnings. The part that makes you smarter.
│   ├── index.md         ← map of what's in memory; read this first
│   ├── lessons/         ← one file per durable lesson
│   └── patterns/        ← recurring shapes you've noticed in your own life/work
├── agents/              ← the durable agents: Liv (Chief of Staff), Max (CEO).
│                          Few agents, many hats — see agents/README.md
├── skills/              ← the 7 loop skills (the hats). Editable; /compound may edit them.
├── commands/            ← thin slash-command wrappers
└── .claude-plugin/      ← manifest so this installs as a plugin
```

## Agents: few loops, many hats

Where most frameworks spawn an agent per task, Humanware OS keeps **a small
roster of durable agents**—persistent working relationships that accumulate
context—and has them wear skills as hats. [Liv](agents/liv.md) (personal Chief
of Staff) runs life outside work and the loop itself. [Max](agents/max.md)
(CEO) runs work: strategy, tracks, tradeoffs, and the discipline of not doing
things. You are the board. Continuity is the point: ephemeral agents start from
zero every time; durable agents compound. Details in
[agents/README.md](agents/README.md).

## Day to day

**Capture constantly, process on your schedule.** The stream is a drop zone — the cost of capture must stay near zero or you'll stop doing it. Recordings are ingested automatically by the `ops/` pipeline (record and forget); screenshots, articles, and quick text events go into the spool with a one-line sidecar if you have 10 seconds of context to add. That's `/observe`. No sorting, no tagging taxonomy, no guilt.

**Daily (minutes):** `/observe` all day as things happen. Once a day, ask Liv what's on deck — she glances at the stream's new arrivals and runs `/orient` on anything that pulls. Most things need nothing.

**Per piece of real work:** run the loop. `/orient` on the problem → `/decide` a small plan → `/act` → `/review`. For tiny tasks, collapse the middle — the loop is a shape, not a form to fill out.

**Weekly (30–60 min):** `/review` the week with Liv against STRATEGY.md, then `/compound`. This is the non-negotiable one — and insisting on it is literally Liv's job. Also skim `memory/index.md` — if it's getting stale or bloated, prune.

**Quarterly:** revisit STRATEGY.md with Max. Run `/rederive` on anything worth refreshing — old voice notes with a better transcription model, an old year's stream with a "what was I actually worried about in 2026?" question you couldn't have asked before.

## Using with Obsidian

This repo *is* an Obsidian vault — open the folder in Obsidian and you're done. Obsidian is the human surface (essays, weekly reviews, wandering memory via backlinks and graph); AI agents are the loop-runners, working the same files through any AGENTS.md-aware coding agent and local models. Same markdown, two lenses, no migration ever.

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

**Privacy tiers** (enforced by AGENTS.md, honored by every agent):

| Tier | What | Where it may go |
|------|------|-----------------|
| 0 | Raw stream data (audio, video, images, exports, sidecars) | This network only. Derivation by **local models** (Whisper + Qwen on the mini). Never into cloud-model context, never to a remote. |
| 1 | `derived/` | Local by default. A specific artifact may be shared into a cloud-agent session deliberately, per item. |
| 2 | `memory/`, `STRATEGY.md`, skills, this README | Curated text. This is what cloud agents load and work from. |

The flow: record anywhere → auto-ingest to the spool → sync to the mini → Whisper transcribes with timestamps into `derived/` → cloud agents do the high-level loop work from tiers 1–2. Cloud models bring judgment; local models bring eyes and ears. As local models improve, `/rederive` re-runs the eyes-and-ears layer — which is the whole bet.

**Backups replace git for the stream.** The mini is the single canonical copy (the MacBook deliberately keeps nothing), so the NAS backup is not optional — it's the other half of the design. NAS snapshots guard against ransomware/fat-fingers; a periodic offline or offsite encrypted copy on top guards against the failure modes a powered-on box can't. Append-only data backs up incrementally for free.

## Why the stream is sacred

Humanware OS follows one rule from the
[event-stream idea](https://x.com/EXM7777/status/2073045719020343705):
**capture is write-once, understanding is re-runnable.** Today's transcription
of a voice note is today's best effort. In two years, a better model may hear
what today's missed. If you saved only the transcript, that context is gone.

- The stream is legally read-only in this house. Agents refuse to edit it. You should too.
- Nothing in `derived/` is precious. Delete freely; `/rederive` rebuilds.
- `memory/` sits in between — it's derived, but it's *curated* derivation. It gets pruned and rewritten, with the stream as its audit trail.

## Customizing (please do)

Everything here is a draft of your system, not the system. The skills are prose — edit them the way you'd edit an essay. When `/compound` surfaces a lesson about the *process itself* ("I always over-plan", "reviews work better as voice notes"), let it edit the skill files. The framework is inside its own loop.

### The template/instance pattern

This repo is the public framework, meant to stay generic. Your life goes in a private instance — full mechanics in [docs/adopt.md](docs/adopt.md):

1. **Create your instance:** run the installer to clone this framework into a
   private instance while keeping Humanware OS wired as the `upstream` remote.
   The instance is where `STRATEGY.md` gets filled, `memory/` accumulates, and
   your machines' config lives. Nothing personal belongs in the framework repo.
2. **Pull framework improvements down** with `git fetch upstream && git merge upstream/main` — the shared merge-base keeps these small and clean.
3. **Send improvements back — deliberately, never wholesale.** When living in your instance produces a structural improvement (a sharper skill, a better rule, a pipeline fix), *genericize it* — strip names, paths, personal context — commit it on a branch cut from `upstream/main`, and PR it here. The flow is one-way by default: instance → template only by extraction, template → instance by merge.
4. Keep agent definition files template-clean in your instance too: what Liv and Max *are* belongs in `agents/`; what they *know about you* belongs in your `memory/`. This keeps upstream merges painless and your private context private.

The framework is the transferable part (loop, tiers, stream discipline); the `ops/` pipeline assumes two Macs and a NAS and will need adapting to your hardware. `STRATEGY.md` and `memory/` ship empty on purpose — they're yours to fill, and they're the whole point.

**Status:** v0.1 — the framework is thought through; the pipeline scripts are a working first draft, not yet hardened by months of daily use. Issues and war stories welcome.

## Install

Humanware OS has no runtime or package-manager dependency. Create a local
instance with one command:

```
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware
```

To create and push a new private GitHub instance in the same step:

```
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware --repo YOUR-GITHUB-USER/my-humanware
```

The second form requires the
[GitHub CLI](https://cli.github.com/) to be installed and authenticated. The
installer preserves shared Git history and leaves the public framework as the
`upstream` remote, so future updates are:

```
git fetch upstream
git merge upstream/main
```

Open the new folder in any `AGENTS.md`-aware coding agent; `AGENTS.md` does the
rest. See [docs/adopt.md](docs/adopt.md) for the repository model, privacy
boundary, and contribution flow.

## Sources & inspirations

This framework stands on three borrowed ideas, remixed:

- **The compounding loop and strategy anchor** — [Every's compound engineering](https://github.com/EveryInc/compound-engineering-plugin) ([essay](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents)): each unit of work should make the next one easier. Generalized here from code to everything.
- **Prose-workflow skills with anti-rationalization tables** — [Addy Osmani's agent-skills](https://github.com/addyosmani/agent-skills): skills as workflows agents follow, with excuses pre-rebutted. Borrowed the form, dropped the TDD liturgy.
- **Event-stream everything** — [Machina's "How to build a second brain" article](https://x.com/EXM7777/status/2073045719020343705): capture raw and append-only, derive understanding, re-derive as models improve.

## License

[MIT](LICENSE).
