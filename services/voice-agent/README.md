# Liv voice agent

This loopback-only service turns authenticated text from a speech surface into one persistent Liv conversation. OpenClaw owns the agent session and tools; the caller owns speech recognition and playback. The service retains no audio and deletes each private prompt file after the turn.

## Contract

- `GET /health` returns `{ "ok": true, "agent": "liv" }`.
- `POST /turn` accepts `{ "text": "..." }` with `Authorization: Bearer ...`.
- The response contains `reply`, `runId`, and `durationMs`.
- Calls are serialized because they share one Liv session.
- Slack root status reactions remain human-controlled.

Required environment:

- `VOICE_AGENT_TOKEN`
- `OPENCLAW_BIN` (defaults to `/opt/homebrew/bin/openclaw`)
- `VOICE_AGENT_SESSION_KEY` (defaults to `agent:liv:voice-chief-of-staff`)
- `VOICE_AGENT_TEMP_ROOT` (defaults to the operating-system temporary directory)

Run tests from the framework root:

```sh
node --test services/voice-agent/server.test.mjs
```
