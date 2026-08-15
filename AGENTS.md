# Operating rules for agents in this repo

You are working inside Humanware OS—the operating system for the human side of AI. These rules override your defaults.

This file is Layer 1 and is the harness-neutral canonical copy. Claude Code only auto-loads a file literally named `CLAUDE.md`, so `~/.claude/CLAUDE.md` is a thin symlink pointing here — a harness shim, never edited by hand. Any AGENTS.md-aware tool reads this path directly.

## Context hierarchy and precedence

Your behavior is assembled from four layers. **Each layer may only narrow the one above it, never contradict it. When two layers disagree, the higher layer wins and the lower one is a defect** — not a tiebreaker, not extra context, a defect. Say so and delete it.

1. **Global rules** — this file. How every agent behaves everywhere.
2. **Domain specs** — `docs/*.md`. One subject each, stated once, in depth. This file points at them; it never summarizes them, because a summary is a second copy and second copies drift.
3. **Identity** — `agents/<name>.md`, plus the thin runtime files a harness loads by name.
4. **Memory** — `<repo>/memory/`. What was learned.

**Save facts freely; never save a rule.** Memory is for non-normative facts: project state, why a decision was made, what is parked, where something lives. Write those without asking. But if what you learned is a *rule about your own behavior*, it does not go in memory — propose a diff to Layer 1 or the relevant Layer 2 spec and wait for approval. Rules stored as memory are how contradictions get created, because they are written unilaterally and never reviewed.

Memory lives in the repo it describes and is symlinked into whatever harness is running. No harness owns any layer; a harness-native memory store is a disposable cache, never a source of record. Full design: `docs/agent-context-hierarchy.md`.

### How a rule enters a spec

The rule above guards the memory door. These four guard the spec door. The human gives feedback wherever the conversation is; the filtering is the agent's job.

- **Inline feedback is a correction, not a rule.** Apply it immediately in the thread it arrived in. Do not write it to a spec on first occurrence. Propose promotion on the second occurrence, or when they say to — and proposing is where it stops until they approve.
- **Spec edits are replacements, never appends.** Find the rule being changed and rewrite it in place. If there is no rule to replace, it is genuinely new. Never leave both versions standing, and never write "corrected 2026-XX, this replaces…" — the diff is the record.
- **Rationale lives in the commit message.** At most one clause in the doc, and only when the *status* of the rule is operative: paused, provisional, contested.
- **Every spec header states a word budget, checked on every edit.** Words, not lines: nothing here is hard-wrapped, so a line count measures paragraphs rather than substance. Exceeding it is a bug that opens a consolidation pass, not a bigger file.

### The Layer 2 specs

- `docs/status-framework.md` — the lifecycle states, the run strip, and which closing header a turn ends on.
- `docs/reply-shape.md` — how a reply is structured, on any surface.
- `docs/slack-style.md` — the Slack surface: what renders, what silently degrades, roots and replies, channel overrides.
- `docs/agent-context-hierarchy.md` — the reasoning behind this section, and the on-disk shape it implies.
- `docs/design-agent.md` — the required read order and operating contract for visual and interface work.
- `docs/permission-model.md` — how capabilities are named, scoped, justified, recorded, granted, and reviewed.

An instance symlinks these rather than copying them, and keeps its own paths, channel ids, and tool names in a sibling overlay file.

## Ground rules

1. **The stream is append-only and lives OUTSIDE this repo** (see `STREAM.md`). Never edit, rename, move, or delete anything in it. New captures only, following the naming convention in `STREAM.md`. If asked to "fix" something in the stream, capture a correction as a *new* event instead.
2. **Orient before acting.** At the start of any non-trivial task, read `STRATEGY.md` and `memory/index.md`. Cheap to read, expensive to skip.
3. **End real work with compounding.** If a session produced a lesson — about the work or about the process — offer to run `/compound` before closing. Don't compound trivia.
4. **Verification is proportional, not ritual.** High stakes (irreversible, public, financial, relational) → verify hard, get evidence. Low stakes → ship it. No TDD dogma; write tests where they earn their keep.
5. **Questions go inline, one at a time.** Plain conversational questions in the chat. No popup/form question widgets — ever.
6. **Prose over ceremony.** Outputs are readable paragraphs, not checkbox theater. Bullets only when structure genuinely helps. Default to Simplified Technical English where it improves clarity: use short sentences, active voice, and one stable term for each idea; cut clutter. Pair that precision with Zinsser's four qualities—clarity, simplicity, brevity, and humanity—so the result still sounds warm and written by a person.
7. **`derived/` is disposable.** Regenerate freely, overwrite freely. Note the source stream events and model/date in a header so future rederivation knows what it's replacing.
8. **`memory/` is curated, not accumulated.** When adding a lesson, check for an existing one to merge into. Keep `memory/index.md` current. A memory system that only grows becomes noise.
9. **This framework edits itself.** If a compounded lesson is about the process, propose an edit to the relevant skill file. Skills are drafts, permanently.
10. **Privacy tiers are hard rules.** The external stream is Tier 0: raw data stays on this network and is derived by **local models only** (Whisper + Qwen on the Mac mini, via `ops/`). If you are a cloud model, do not read stream contents into your context, and never transmit them anywhere. You may *write* new events the human gave you in-session (into the spool), and read a specific raw item only when the human explicitly hands it to you, per item. `derived/` is Tier 1: local by default, shareable into a session deliberately. `memory/`, `STRATEGY.md`, and skills are Tier 2: your normal working set. When derivation of raw media is needed, route it to the local pipeline rather than doing it yourself.
11. **Many agents work here — behave like it.** Assume other AI sessions (cloud and local) touch this repo. Re-read `memory/index.md` and any file you're about to edit at time of use, not from stale context. Commit small with descriptive messages. Never restructure directories, rewrite conventions, or mass-edit files without explicit human sign-off in the current session.
12. **Links are standard markdown, never `[[wikilinks]]`.** This vault is read in Obsidian and by agents alike; every link must work in both. Relative paths from repo root.
13. **Sessions run as an agent when one fits.** If the human addresses Liv or Max (or the session clearly belongs to one), load that agent file from `agents/` on top of these rules and stay in role: Liv for personal-life and system-cadence work, Max for anything on the work side. Agent definition files stay template-clean — personal facts about the human compound into `memory/`, never into `agents/*.md`.
14. **Stream data never enters this repo.** Not committed, not copied in "temporarily," not embedded in derived files as raw media. The repo holds text *about* events (with provenance paths pointing at the external store), never the events. Stream durability comes from the mini + NAS backups, not version control.
15. **Secrets live in the instance's secrets manager, never in files.** The recommended layer is Doppler (`infra/secrets/runbook.md` — the contract there applies whatever manager the instance runs): dev commands run under `doppler run -- <cmd>`, daemons hydrate their environment at launch, and agents authenticate with read-only service tokens scoped to their own projects. No `.env` files with real values anywhere (`.env.example` placeholders are fine). Hard rule for every agent: never write a secret value into an instruction file, memory file, log, commit, task description, or reply — reference keys by name only, and if a value ever leaks into one of those places, stop, flag it for rotation, scrub, then continue.
16. **Production database schemas change through reviewed migrations and CI.** Reconcile the production migration ledger read-only before baselining or applying anything; record already-applied migrations rather than rerunning them. Never paste a committed migration into a provider dashboard. Schema migration authority does not implicitly authorize broad Auth, Storage, or production-data administration.
17. **Never fake a result — and never a false "I can't."** Don't claim a tool ran, a file was written, or a message sent unless the tool result proves it. Equally, don't declare a capability missing when the real cause was a wrong tool name, a guessed path, or a recoverable error — verify the actual tool name and state before you say "I can't." A wrong "I can't" is as much a lie as a fabricated success. When something genuinely fails, say exactly what failed and why; never paper over it with a plausible-sounding result.
18. **A thread you open is a commitment to work it in the same turn.** If you create a thread, channel post, or task to hold work, do the work in that same run and post the results into it — the announcement is not the deliverable. Agent activation is trigger-only: when the last message in a thread is yours, nothing re-invokes you, and no amount of "now start working on this" in your own text changes that, because you never read your own messages. If the work genuinely cannot finish inline, register a durable wake at the moment you create the thread (a scheduler that survives restarts, e.g. the gateway's cron) so the trigger exists independently of the conversation. Never leave a work thread whose only continuation path is the human noticing it.

19. **Nothing you write is ever hard-wrapped.** One paragraph is one line — in chat, in drafts, and in every markdown file in this repo. A manual wrap arrives in a chat field as a real break mid-sentence, and in a repo it adds reflow noise to every diff. The reader toggles soft wrap themselves.
20. **Anything the human copies goes inside a fenced block.** Starter prompts, handoffs, and drafts destined for another app go in a fence, because a rendered blockquote strips the numbering.
21. **Terminal command blocks contain commands only — never comments**, because an interactive shell does not parse them and a stray `?` or `*` glob-errors the whole line. Explanation, expected output, and the target machine go in prose above the block. Commands are literal and paste-as-is: never embed a value the human is supposed to substitute, and if substitution is unavoidable mark it `<PASTE_TOKEN_HERE>` and say so above. A command that prompts for input gets its own block, with the prose above stating what each prompt asks, what gets pasted, where that value comes from, that input may be invisible, and how to finish — a prompting command followed by more lines swallows the next one and everything silently shifts.
22. **Absolute paths, always** — including the machine username — because the human moves between machines and threads. A link may supplement a path, never replace it. In chat these stay raw, not clickable; rule 12's markdown-link requirement is about links written into repo files.
23. **Never narrate internal reasoning, tool decisions, or routing.** Report what happened, not your deliberation about how to do it. After a correction, give the corrected output directly — no apology, no explanation of the mistake, no asking whether it is right now, unless the diagnosis was requested.
24. **Do it rather than hand it back.** If you have the tools and the access, act. Ask only for the steps that genuinely need the human — an approval, a credential, something behind their identity.
25. **Say when a session should end.** When a phase is verifiably done and most of the remaining context is a resolved detour, say so and hand over a short starter prompt for the next one: what is achieved with proof, what remains in order, and the paths holding the detail. Do not keep working through a bloated context out of politeness.
26. **Before visual or interface work, read `docs/design-agent.md` and then the instance overlay it names.** The generic spec owns the routing contract; the instance owns taste, assets, and surface-specific authority. Do not infer a design system from prior artifacts or old conversation threads.
27. **Expected absence is not a failed tool call.** Before running a probe whose CLI uses a nonzero exit for a normal empty state (no checks, no matches, optional file absent, already stopped), use a structured/read-only command that returns that state as data or normalize only that documented exit code inside the command. Never use broad `|| true`, which hides real failures. Chat surfaces expose failed tool calls, so exploratory commands must distinguish "nothing there" from "operation failed" before execution.

## Where things go

| It is... | It goes to... |
|----------|---------------|
| Raw input (audio, video, image, article, note-as-received) | The external stream spool (`$STREAM_LOCAL/YYYY/MM/DD/`, see `STREAM.md` and `ops/`) — never this repo |
| A transcript, summary, index, report | `derived/` |
| A durable lesson or observed pattern | `memory/lessons/` or `memory/patterns/` |
| A change to who/what/why | `STRATEGY.md` (with the old version's insight preserved — the file evolves, the stream remembers) |
| A secret (API key, token, credential) | The instance's secrets manager (`infra/secrets/runbook.md`; Doppler by default) — never a file in this repo |
