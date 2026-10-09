# Agent heartbeat monitor + self-healer

Watches the OpenClaw agents on the gateway host and escalates when they go quiet. Every failure mode seen so far (dead provider auth, quota'd model, wedged Slack dispatch, thread pinned to a toolless backend) presents identically in Slack: silence.

## What runs

`heartbeat.py`, every 5 minutes via an instance launchd plist that points at the framework copy under `<runtime>/framework/services/observability/heartbeat/`. Script edits need no reinstall; launchd re-runs the file each interval.

Checks per run, cheapest first:

1. **Gateway** — process alive, `gatewayPort` accepting.
2. **Dispatch suspicion** — Slack inbound events in the last 12 min with *zero* agent activity after them. A weak signal: the logs do not correlate event IDs to run IDs.
3. **Provider burst** — 3+ failover/harness errors in the window.
4. **Silent-kill scan** — incremental scan of the gateway log (persisted byte offset, truncation-aware, drains yesterday's tail on day rollover) for the three signatures that mean a reply was lost with **no** user-visible error: `stalled session`, `no queued reply payloads`, `transcript tail is not resumable`. Detection only; a restart is what *causes* two of these, so they never trigger remediation. Alerts are throttled to 30 min with counts accumulating in between.
5. **Canary** (every 6th run, ~30 min) — a real agent turn per configured agent through the gateway, expecting "OK". Exercises gateway + runtime + model + auth. Side effect: a tiny turn in each `agent:<name>:main` session history.

## Self-healing

Only independently verified failures trigger `launchctl kickstart -k`:

- the gateway process/port is down on two consecutive checks; or
- the dispatch heuristic fires, every agent canary also fails, and that combined condition repeats on the next check.

A missing activity log line never authorizes a restart by itself. Successful self-healing opens no second incident alert. Auto-restarts are capped at 2 per rolling hour; the monitor contacts the human only when remediation fails, the restart budget is exhausted, or a non-restartable failure remains confirmed.

Before any kickstart the monitor counts detectable in-flight agent runs (claude-cli child processes referencing a per-session MCP sidecar). If any are active, the restart is deferred for two cycles and then escalated; the monitor never automatically restarts while those runs remain. In-process runtimes such as Ollama are invisible to this check, so a human performing a manual restart must still verify the gateway is quiet. A kickstart mid-message-send leaves a dangling tool call and a non-resumable transcript.

## Alerting — the incident protocol

Severity decides the channel, and **a page means there is an action only the human can take**.

| Severity | Goes to | When |
|---|---|---|
| silent | rollup log only | self-healed check result, first strikes, anything with no human decision in it |
| notice | one incident thread in `incidentChannel` | a repeated or unresolved failure the monitor cannot fix |
| page | same incident thread | remediation exhausted **and** a specific action can be named |

- **One thread per incident.** The first notice for a check opens a thread; every later update, including deferrals and the resolution, is a reply in that same thread. A thread idle past `INCIDENT_TTL_H` (12h) is a closed chapter; the next failure opens a fresh one.
- **Page contract.** Every page states what failed, what the monitor already tried, the single action, and what breaks if the human waits. `NEXT_STEPS` / `WAIT_COST` hold those strings; a new page-class check must add both.
- **Escalation thresholds.** Gateway/verified-runtime page once auto-restart fails, the 2/hr budget is spent, or deferrals are exhausted. Provider errors page on the second strike (auth and billing are never self-fixable). A single agent's canary is a notice for `CANARY_PAGE_AFTER` (4) consecutive failures, then pages. Silent-kill signatures are always a notice and can never page.

Transport is independent of OpenClaw: direct Slack API with the bot token fetched from Doppler at send time (`dopplerProjects` in order, secret `SLACK_BOT_TOKEN`), posted under the distinct `monitorName` identity (`chat:write.customize`) so alerts read as machine telemetry rather than as a message from an agent. A verified check must fail twice consecutively before remediation; re-alerts while still broken are throttled to every 30 min.

## Tracking (the rollup is the record)

Slack is a notification surface that expires. The record is `$HUMANWARE_DATA_ROOT/generated/reports/health/heartbeat-rollup.jsonl`, one JSON object per line, rotated to `.1` at 2 MB. Written for **every** failing observation: `observation` (with `strike` count, including first strikes that never alert), `weak-signal`, `silent-kill`, `alert` (with severity and the transport that actually took it, so a *sent* claim is falsifiable), and `delivery-error`. State is `heartbeat-state.json` beside it (transient, safe to delete).

## Instance configuration

Environment: `HUMANWARE_DATA_ROOT` (required). Config is read from `$HEARTBEAT_CONFIG`, else `$HUMANWARE_RUNTIME_ROOT/config/services/observability/heartbeat/config.json`; when `HUMANWARE_RUNTIME_ROOT` is unset it is derived from the script location (`<runtime>/framework/services/observability/heartbeat/`). `config.example.json` documents every key:

- `incidentChannel` (Slack channel id, the only alert surface), `agents` (canary targets, in order), `dopplerProjects` (Doppler projects holding `SLACK_BOT_TOKEN`, tried in order). Required.
- `dopplerConfig` (default `prd`), `monitorName`, `monitorIcon`, `hostName` (named in page instructions), `gatewayLabel` (default `ai.openclaw.gateway`; the launchd domain is `gui/<uid>`), `gatewayPort`, `gatewayLogDir`, `dopplerBin`, `nodeBin`, `openclawJs`.

The instance keeps only its plist and `config.json`; the plist's `ProgramArguments` point at `<runtime>/framework/services/observability/heartbeat/heartbeat.py` and set `HUMANWARE_DATA_ROOT`.

## Tests

```
python3 services/observability/heartbeat/test_heartbeat.py
```

Tests load `config.example.json` through `HEARTBEAT_CONFIG`.
