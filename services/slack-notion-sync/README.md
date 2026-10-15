# Slack to Notion thread projection

This one-way projector upserts every human or bot message root from every Slack channel the configured bot has joined, including archived channels. Slack remains authoritative. The Notion `Thread key` (`channel_id:thread_ts`) is the idempotency key; edits to projected properties are overwritten on the next changed or six-hour full sync and never flow back to Slack. Page body blocks, comments, and additional Notion-only properties are not part of the update request and remain untouched.

Slack channel history is the row inventory. The optional `<data-root>/generated/sessions/current.json` projection enriches matching roots with session stats and session-summary URLs; those fields stay blank for ordinary Slack threads. Slack system events such as joins, renames, tombstones, and canvas updates are not message roots and are excluded.

Status is derived only from canonical reactions held by `SLACK_HUMAN_STATUS_ACTORS`: 🔄 Working, ✋ Act (`hand` is normalized), 🗓️ Scheduled, and ✅ Closed. A one-time migration baseline at `<data-root>/operations/slack-notion-sync/migration-baseline.json` preserves an unambiguous pre-cutover status until the human first adds or removes a canonical status reaction on that thread. After that claim, zero accepted reactions leaves Status blank. Multiple accepted reactions leave Status blank and append one ambiguity record for manual review. Bot-held and noncanonical reactions never set status.

The OpenClaw Slack adapter journals accepted structured `reaction_added` and `reaction_removed` events under `<data-root>/operations/slack-notion-sync/events.jsonl` without waking a model. The instance LaunchAgent watches that journal. After a short debounce, the projector refetches exactly one root and upserts exactly one Notion row; the regular scan remains recovery and inventory discovery.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Slack bot token with channel history, channel info, and permalink access |
| `NOTION_TOKEN` | yes | Notion integration token with content access to the target database |
| `NOTION_DATA_SOURCE_ID` | yes | Target Notion data source ID |
| `SLACK_HUMAN_STATUS_ACTORS` | yes | Comma-separated Slack user IDs allowed to set workflow status |
| `SLACK_NOTION_SUMMARY_BASE_URL` | yes | Public/private HTTP base for generated session summary Markdown files |
| `HUMANWARE_DATA_ROOT` | yes unless all paths are overridden | Instance data root |
| `SLACK_NOTION_INPUT` | no | Override session projection path |
| `SLACK_NOTION_RECORDS_ROOT` | no | Override generated session directory |
| `SLACK_NOTION_STATE` | no | Override private incremental state path |
| `SLACK_NOTION_EVENTS` | no | Override structured reaction-event journal path |
| `SLACK_NOTION_REVIEW` | no | Override ambiguity-review journal path |
| `SLACK_NOTION_MIGRATION_BASELINE` | no | Override the one-time migrated-status baseline path |
| `SLACK_NOTION_MAX_INPUT_AGE_MS` | no (`300000`) | Fail-closed freshness bound |
| `SLACK_NOTION_FULL_SYNC_INTERVAL_MS` | no (`21600000`) | Recheck every thread at least this often |
| `SLACK_NOTION_WRITE_DELAY_MS` | no (`350`) | Minimum spacing between Notion writes during backfill |
| `SLACK_NOTION_EVENT_DEBOUNCE_MS` | no (`2000`) | Delay used to coalesce a human remove/add status change |

Set `SLACK_NOTION_DRY_RUN=1` to validate local configuration without writes. If a Slack token is present, dry-run also enumerates the accessible channel and root-message counts.

## Tests

```sh
node --test services/slack-notion-sync/*.test.mjs
```
