# Daily Slack thread summary

A scheduled job that posts a compact count of open Slack threads (active, clarify, act, scheduled) to one Slack channel, built from the session-ledger projection (`<data-root>/generated/sessions/current.json`). It does not scan Slack. Each run validates that the projection is fresh, writes `<data-root>/generated/reports/slack-thread-summaries/latest.json` atomically, posts one message, and emits one structured `slack_thread_summary_completed` or `slack_thread_summary_failed` event.

In an assembled runtime this code lives at `<runtime>/framework/services/slack-thread-summary/`. The instance supplies the schedule (LaunchAgent), a run script that resolves `SLACK_BOT_TOKEN`, and the configuration below, under `<runtime>/config/services/slack-thread-summary/`.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes (unless dry run) | Bot token used to post |
| `SLACK_THREAD_SUMMARY_CHANNEL` | yes (unless dry run) | Destination Slack channel id |
| `HUMANWARE_DATA_ROOT` | yes, unless both paths below are set | Instance data root |
| `SLACK_THREAD_SUMMARY_INPUT` / `SLACK_THREAD_SUMMARY_OUTPUT` | no | Override input/output paths |
| `SLACK_THREAD_SUMMARY_MAX_AGE_MS` | no (21600000) | Maximum input age before failing closed |
| `SLACK_THREAD_SUMMARY_PRODUCER` | no (`humanwareos/slack-thread-summary@1`) | `producer` field of the output |
| `SLACK_THREAD_SUMMARY_TIMEZONE` | no (host zone) | IANA zone for the message date |

Missing required values fail before any read or delivery.

Set `SLACK_THREAD_SUMMARY_DRY_RUN=1` and invoke `build-and-publish.mjs` directly to validate a live input and output path without a credential or Slack delivery.

## Tests

```sh
node --test services/slack-thread-summary/*.test.mjs
```
