# Operating rules for agents in this repo

You are working inside a life-os — the operating system for its owner's life. These rules override your defaults.

## Ground rules

1. **The stream is append-only and lives OUTSIDE this repo** (see `STREAM.md`). Never edit, rename, move, or delete anything in it. New captures only, following the naming convention in `STREAM.md`. If asked to "fix" something in the stream, capture a correction as a *new* event instead.
2. **Orient before acting.** At the start of any non-trivial task, read `STRATEGY.md` and `memory/index.md`. Cheap to read, expensive to skip.
3. **End real work with compounding.** If a session produced a lesson — about the work or about the process — offer to run `/compound` before closing. Don't compound trivia.
4. **Verification is proportional, not ritual.** High stakes (irreversible, public, financial, relational) → verify hard, get evidence. Low stakes → ship it. No TDD dogma; write tests where they earn their keep.
5. **Questions go inline, one at a time.** Plain conversational questions in the chat. No popup/form question widgets — ever.
6. **Prose over ceremony.** Outputs are readable paragraphs, not checkbox theater. Bullets only when structure genuinely helps. Keep visible work updates as part of the conversation; don't replace them at the end with a sanitized recap. Final replies should continue the thread in plain prose, not collapse the work into a file inventory or change list unless the human asks for it. In chat, cite local files only when they materially help, and write them as plain raw paths like `path/to/file.md` or `/absolute/path/file.md`; never turn local file paths into clickable Markdown links.
7. **`derived/` is disposable.** Regenerate freely, overwrite freely. Note the source stream events and model/date in a header so future rederivation knows what it's replacing.
8. **`memory/` is curated, not accumulated.** When adding a lesson, check for an existing one to merge into. Keep `memory/index.md` current. A memory system that only grows becomes noise.
9. **This framework edits itself.** If a compounded lesson is about the process, propose an edit to the relevant skill file. Skills are drafts, permanently.
10. **Privacy tiers are hard rules.** The external stream is Tier 0: raw data stays on this network and is derived by **local models only** (Whisper + Qwen on the Mac mini, via `ops/`). If you are a cloud model, do not read stream contents into your context, and never transmit them anywhere. You may *write* new events the human gave you in-session (into the spool), and read a specific raw item only when the human explicitly hands it to you, per item. `derived/` is Tier 1: local by default, shareable into a session deliberately. `memory/`, `STRATEGY.md`, and skills are Tier 2: your normal working set. When derivation of raw media is needed, route it to the local pipeline rather than doing it yourself.
11. **Many agents work here — behave like it.** Assume other AI sessions (cloud and local) touch this repo. Re-read `memory/index.md` and any file you're about to edit at time of use, not from stale context. Commit small with descriptive messages. Never restructure directories, rewrite conventions, or mass-edit files without explicit human sign-off in the current session.
12. **Links inside repo files are standard markdown, never `[[wikilinks]]`.** This vault is read in Obsidian and by agents alike; every written link must work in both. Relative paths from repo root. This repo-writing rule does not override the chat rule above: local paths in agent replies stay raw, not clickable.
13. **Sessions run as an agent when one fits.** If the human addresses Liv or Max (or the work clearly belongs to one), load that agent file from `agents/` on top of these rules and stay in role: Liv for operational/cadence work, Max for directional questions. Agent definition files stay template-clean — personal facts about the human compound into `memory/`, never into `agents/*.md`.
14. **Stream data never enters this repo.** Not committed, not copied in "temporarily," not embedded in derived files as raw media. The repo holds text *about* events (with provenance paths pointing at the external store), never the events. Stream durability comes from the mini + NAS backups, not version control.

## Where things go

| It is... | It goes to... |
|----------|---------------|
| Raw input (audio, video, image, article, note-as-received) | The external stream spool (`$STREAM_LOCAL/YYYY/MM/DD/`, see `STREAM.md` and `ops/`) — never this repo |
| A transcript, summary, index, report | `derived/` |
| A durable lesson or observed pattern | `memory/lessons/` or `memory/patterns/` |
| A change to who/what/why | `STRATEGY.md` (with the old version's insight preserved — the file evolves, the stream remembers) |
