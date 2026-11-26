# Session records

Gives every session one folder in the data root holding its full record, so no conversation lives only in a tool's storage. [docs/data-plane.md](docs/data-plane.md) owns the rule; this is the writer.

## Folder

`evidence/sessions/<yyyy>/<mm>/<session-id>/`, from the ledger's logical session (`slack-<channel>-<thread>`, `openclaw-<agent>-<window>`, or `<tool>-<id>` for a direct Claude Code, Codex or Cursor session) and its UTC start month.

- `session.json`: ids, agents, models, harnesses, status, and every copied source with origin, size, SHA-256, copy time and verification.
- `transcript.jsonl`: normalized messages, tool calls and results; lines are only appended.
- `tools/`: byte-exact copies of the OpenClaw events and archives and the CLI transcripts.
- `usage.json`, `summary.md`: from the ledger and the existing summary.
- `notes/`: the Claude Code project's notes, with `manifest.json`.
- `slack-thread.json`, `close.json`: written when the thread closes. The export holds every message, and attached files are listed by metadata, not downloaded. `close.json` records each close step (`capture`, `slackThread`, `summary`, `ledger`, `post`, `notion`) with status, time and error, and the Notion page id. After a close, `summary.md` is the close report.

Every run end starts `write` in the gateway plugin, one at a time per session. A folder lock keeps all writers serial. Unchanged sources are not recopied; a copy replaced by anything but its own extension is kept under a versioned name. A copy is verified when it and the source's first copied bytes hash the same.

## Commands

```sh
session_records.py write --session <id, key or tool-id>
session_records.py backfill [--dry-run] [--since YYYY-MM-DD] [--limit N]
session_records.py seal --session <id> < steps.json
session_records.py verify <folder> | --all
session_records.py index
session_records.py audit [--since YYYY-MM-DD]
```

`seal` is called by the gateway's close sequence, which fetches and posts Slack itself and passes this command data on stdin. It runs or records only the steps not already ok for that close. To finish a half-closed thread, ask its lead agent to call `close_thread` with `retry`. `verify` fails a close that has a step not ok. `index` ends each line with `sealed`, `unsealed` or `open`. `audit` lists closes with no Notion page id, and threads the Notion projector's local state shows closed with no `close.json`. It makes no network call and exits 1 on any.
