# Slack to Notion thread projection

This one-way scheduled projector upserts every human or bot message root from every Slack channel the configured bot has joined, including archived channels. Slack remains authoritative. The Notion `Thread key` (`channel_id:thread_ts`) is the idempotency key; edits to projected properties are overwritten on the next changed or six-hour full sync and never flow back to Slack. Page body blocks, comments, and additional Notion-only properties are not part of the update request and remain untouched.

Slack channel history is the row inventory. The optional `<data-root>/generated/sessions/current.json` projection enriches matching roots with session stats, session-summary URLs, and workflow timestamps; those fields stay blank for ordinary Slack threads. Slack system events such as joins, renames, tombstones, and canvas updates are not message roots and are excluded. Standard first reactions render as Unicode emoji; workspace-specific image emoji use a `🧩` marker because Notion select labels cannot embed Slack-hosted images. An absent first reaction leaves Status blank.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Slack bot token with channel history, channel info, and permalink access |
| `NOTION_TOKEN` | yes | Notion integration token with content access to the target database |
| `NOTION_DATA_SOURCE_ID` | yes | Target Notion data source ID |
| `SLACK_NOTION_SUMMARY_BASE_URL` | yes | Public/private HTTP base for generated session summary Markdown files |
| `HUMANWARE_DATA_ROOT` | yes unless all paths are overridden | Instance data root |
| `SLACK_NOTION_INPUT` | no | Override session projection path |
| `SLACK_NOTION_RECORDS_ROOT` | no | Override generated session directory |
| `SLACK_NOTION_STATE` | no | Override private incremental state path |
| `SLACK_NOTION_MAX_INPUT_AGE_MS` | no (`300000`) | Fail-closed freshness bound |
| `SLACK_NOTION_FULL_SYNC_INTERVAL_MS` | no (`21600000`) | Recheck every thread at least this often |
| `SLACK_NOTION_WRITE_DELAY_MS` | no (`350`) | Minimum spacing between Notion writes during backfill |

Set `SLACK_NOTION_DRY_RUN=1` to validate local configuration without writes. If a Slack token is present, dry-run also enumerates the accessible channel and root-message counts.

## Tests

```sh
node --test services/slack-notion-sync/*.test.mjs
```
