# Slack to Notion thread projection

This one-way scheduled projector upserts Slack-backed session threads into a Notion database. Slack and the session ledger remain authoritative. The Notion `Thread key` (`channel_id:thread_ts`) is the idempotency key; edits to projected properties are overwritten on the next changed or six-hour full sync and never flow back to Slack. Page body blocks, comments, and additional Notion-only properties are not part of the update request and remain untouched.

The projector reads `<data-root>/generated/sessions/current.json`, fetches each changed Slack root, and writes the requested title, lifecycle reaction, permalink, channel, timestamps, reply count, session stats, and session-summary URL. `Status changed` uses the matching session-ledger workflow timestamp when available and otherwise records when the projector first observes a transition. Unknown or absent first reactions leave Status blank.

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

Set `SLACK_NOTION_DRY_RUN=1` to validate configuration and the source projection without network writes or credentials.

## Tests

```sh
node --test services/slack-notion-sync/*.test.mjs
```
