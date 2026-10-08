# Token / usage tracking

Collects subscription usage (Claude + Codex/ChatGPT via the CodexBar CLI) and
Slack agent activity (OpenClaw session storage) into a stats feed, plus an
optional weekly Slack snapshot.

## Scripts

| Script | Schedule (instance plist) | Output |
| --- | --- | --- |
| `build-dashboard.py` | hourly | `$HUMANWARE_DATA_ROOT/generated/reports/stats/current.json`, `daily.json` |
| `sample-windows.py` | every few minutes | appends `.../stats/windows.jsonl` |
| `post-usage.py` | weekly | Slack post to `weeklyPost.channel` |
| `run-local.py` | manual | appends `.../stats/local-usage.jsonl` (ollama metering) |

All scripts require `HUMANWARE_DATA_ROOT`. CodexBar is called by full path
(`/opt/homebrew/bin/codexbar`) because it is not on launchd PATH; its
non-fatal Keychain error (-25308) under launchd/ssh is ignored.

`sample-windows.py --authorize-claude` must succeed once before scheduled runs
sample Claude windows.

## Instance configuration

Read from `$HUMANWARE_RUNTIME_ROOT/config/services/observability/token-tracking/`.
When `HUMANWARE_RUNTIME_ROOT` is unset it is derived from the script location
(`<runtime>/framework/services/observability/token-tracking/`).

`budgets.json` — monthly pace budgets per provider
(`cycleAnchorDay`, `planPriceUSD`, `monthlyCostUSD`). Missing keys fall back to
neutral defaults and add a warning to the feed.

`config.json`:

```json
{
  "owner": {"key": "owner", "name": "Owner", "slackUserId": "U..."},
  "slackAgents": ["agent-a", "agent-b"],
  "slackTeamId": "T...",
  "slackWorkspaceDomain": "example.slack.com",
  "excludedSlackChannels": ["C..."],
  "timezone": "America/New_York",
  "weeklyPost": {"channel": "C...", "dopplerProject": "...", "dopplerConfig": "prd"},
  "alerts": {"target": "channel:C...", "account": "agent-a", "statsUrl": "https://..."}
}
```

- `owner.key` names the human's column in the feed (`messages.<key>`,
  `words.<key>`); owner messages are matched by `owner.name`
  (case-insensitive sender name) or `owner.slackUserId`. `owner.key` and
  `slackAgents` are required by `build-dashboard.py`.
- `slackWorkspaceDomain` / `slackTeamId` build thread links; links are `null`
  when unset. `timezone` defaults to UTC.
- `weeklyPost.*` is required only when `post-usage.py` actually posts
  (`--dry-run` works without it). The bot token is `SLACK_BOT_TOKEN` in that
  Doppler project.
- `alerts.*` is required only if threshold alerts fire (they are paused:
  `ALERT_MILESTONES = ()` in `sample-windows.py`).

Optional data-plane input: `$HUMANWARE_DATA_ROOT/generated/observability/buzz-baseline.json`
(`startedAt`, `seed*`); missing is fine (Buzz section reports paused).

## Tests

```
python3 services/observability/token-tracking/test_build_dashboard.py
```
