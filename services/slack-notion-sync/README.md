# Slack and Notion thread status projection

This projector upserts every human or bot message root from every Slack channel the configured bot has joined, including archived channels. The Notion `Thread key` (`channel_id:thread_ts`) is the idempotency key. Slack remains authoritative for new and human-claimed roots. An explicitly enabled, migration-only exception lets Status edits on unclaimed baseline rows change the legacy bot-owned Slack reaction; no other Notion property or row writes back. Page body blocks, comments, and additional Notion-only properties remain untouched.

Slack channel history is the row inventory. The optional `<data-root>/generated/sessions/current.json` projection enriches matching roots with session stats and session-summary URLs; those fields stay blank for ordinary Slack threads. Slack system events such as joins, renames, tombstones, and canvas updates are not message roots and are excluded.

Status uses 🔄 Working, ✋ Act (`hand` is normalized), 🗓️ Scheduled, and ✅ Closed. A configured human reaction is authoritative. Until the human first adds or removes a canonical reaction, a one-time baseline at `<data-root>/operations/slack-notion-sync/migration-baseline.json` may retain a managed bot-owned status. With migration writeback enabled, changing Status in Notion on one of those unclaimed rows replaces or clears only the configured bots' canonical root reaction. The first human status event claims the root, removes its managed bot status, and permanently disables Notion writeback for that row. Multiple human statuses remain blank and enter manual review. Noncanonical reactions never set status.

The OpenClaw Slack adapter journals accepted structured `reaction_added` and `reaction_removed` events under `<data-root>/operations/slack-notion-sync/events.jsonl` without waking a model. The instance LaunchAgent watches that journal. After a short debounce, the projector refetches exactly one root and upserts exactly one Notion row; the regular scan remains recovery and inventory discovery.

The `set_thread_status` tool is the only conversational bot-write path. It appears only in Slack thread sessions, requires an explicit owner request in the active turn, and appends a command to `<data-root>/operations/slack-notion-sync/commands.jsonl`; the projector performs the Slack and Notion writes with the same ownership rules. It is not called by lifecycle hooks.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Slack bot token with channel history, channel info, and permalink access |
| `SLACK_NOTION_SECONDARY_BOT_TOKEN` | when migration writeback is enabled | Second historical status bot token |
| `NOTION_TOKEN` | yes | Notion integration token with content access to the target database |
| `NOTION_DATA_SOURCE_ID` | yes | Target Notion data source ID |
| `SLACK_HUMAN_STATUS_ACTORS` | yes | Comma-separated Slack user IDs allowed to set workflow status |
| `SLACK_NOTION_SUMMARY_BASE_URL` | yes | Public/private HTTP base for generated session summary Markdown files |
| `HUMANWARE_DATA_ROOT` | yes unless all paths are overridden | Instance data root |
| `SLACK_NOTION_INPUT` | no | Override session projection path |
| `SLACK_NOTION_RECORDS_ROOT` | no | Override generated session directory |
| `SLACK_NOTION_STATE` | no | Override private incremental state path |
| `SLACK_NOTION_EVENTS` | no | Override structured reaction-event journal path |
| `SLACK_NOTION_COMMANDS` | no | Override explicit bot-status command journal path |
| `SLACK_NOTION_REVIEW` | no | Override ambiguity-review journal path |
| `SLACK_NOTION_MIGRATION_BASELINE` | no | Override the one-time migrated-status baseline path |
| `SLACK_NOTION_MAX_INPUT_AGE_MS` | no (`300000`) | Fail-closed freshness bound |
| `SLACK_NOTION_FULL_SYNC_INTERVAL_MS` | no (`21600000`) | Recheck every thread at least this often |
| `SLACK_NOTION_WRITE_DELAY_MS` | no (`350`) | Minimum spacing between Notion writes during backfill |
| `SLACK_NOTION_EVENT_DEBOUNCE_MS` | no (`2000`) | Delay used to coalesce a human remove/add status change |
| `SLACK_NOTION_MIGRATION_WRITEBACK` | no (`0`) | Allow Status edits on unclaimed baseline rows to update managed bot reactions |
| `SLACK_NOTION_PRIMARY_BOT_NAME` | no (`primary`) | Agent name associated with `SLACK_BOT_TOKEN` for explicit commands |
| `SLACK_NOTION_SECONDARY_BOT_NAME` | no (`secondary`) | Agent name associated with the secondary token |

Set `SLACK_NOTION_DRY_RUN=1` to validate local configuration without writes. If a Slack token is present, dry-run also enumerates the accessible channel and root-message counts.

## Tests

```sh
node --test services/slack-notion-sync/*.test.mjs
```
