# Voice capture intake

Loopback service that turns one owner recording into one agent turn in the instance's Slack intake thread. The contract is the capture intake section of [docs/voice-channel.md](docs/voice-channel.md). It has no npm dependencies and requires Node 22.13 or later for `node:sqlite`.

## Listeners

- Capture, `127.0.0.1:<capturePort>` (default 8800): `POST /capture` (multipart form) and `GET /health`. This is the only tunnel target. Form fields: `audio` (file) or `text` (dictation fallback), `deviceName`, `deviceModel`, `capturedAt` (ISO 8601). Responses are JSON with `status` (`accepted` 202, `duplicate` 200), `captureId`, and a short `message` the Shortcut shows as a notification.
- Audio, `127.0.0.1:<audioPort>` (default 8801): `GET /audio/<captureId>` with byte ranges, and `GET /health`. Route it only from the private domain, never from the tunnel.

Health fails while Slack verification fails or any capture is held.

## Configuration

Instance config is read from `$VOICE_INTAKE_CONFIG`, else `$HUMANWARE_RUNTIME_ROOT/config/services/voice-intake/config.json`. `config.example.json` documents every key: `agentId`, `slackChannel` (a name in `config/channels/slack.json` `registry`, default `inbox`), `timeZone`, `privateOrigin` and `audioPath` (together the audio link prefix), ports, `maxBytes`, `maxAttempts`, `whisper` (`bin`, `model`, `language`, `timeoutMs`), optional `summary` (loopback Ollama `url` and `model`; omit `model` to use the transcript's first words), and optional `dataDir` and `evidenceRoot`.

Environment: `HUMANWARE_DATA_ROOT` (required), `HUMANWARE_RUNTIME_ROOT`, `VOICE_INTAKE_CONFIG`, `OPENCLAW_BIN` (default `openclaw`), and `VOICE_INTAKE_SLACK_BOT_TOKEN`, the configured agent's bot token injected by the instance secret wrapper.

Data: audio evidence `$HUMANWARE_DATA_ROOT/evidence/voice/captures/YYYY/MM/<id>.<ext>` plus `<id>.json`; state `working/projects/voice-intake/captures.sqlite3`; request records `working/projects/voice-intake/requests/<id>/request.json`. Directories are 0700 and files 0600.

## Shortcut

```sh
node services/voice-intake/shortcut.mjs --url https://<ingress-host>/capture --out-dir <data-plane directory>
```

Writes `Voice Intake` (Record Audio, starts immediately, finishes on tap) and `Voice Intake (Dictation)` as unsigned `.unsigned.shortcut` files, then signs each with `shortcuts sign --mode people-who-know-me`. Signing requires a macOS user signed in to iCloud; otherwise the command exits nonzero and leaves the unsigned files for a signed-in Mac. Import asks for the Access client ID and secret; neither is in the file. Write output to the data plane, never to Git.

## Operation

A held row records a bounded `reason`: `<state>_failed` after `maxAttempts`, `empty_transcript`, or `admission_unconfirmed`. Inspect the gateway run for `voice-intake:<captureId>` and the Slack thread before acting. A held capture before `posted` can be retried by setting `state` back to its prior value and `attempts` to 0; posts reconcile by metadata. Never reset an `admission_unconfirmed` row to `posted` without proving the turn did not run.

## Tests

```sh
node --test services/voice-intake/*.test.mjs
```

Tests use synthetic audio bytes with mocked Whisper, summarizer, Slack, and gateway. They do not prove the edge tunnel, Access policy, Shortcut import, or live Slack delivery.
