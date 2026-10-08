# Capture ingest

The menu bar app's backend (`server/ingest.py`, stdlib Python). The app POSTs captures here over a private network; the service posts them to a Slack inbox channel (as the capturing user when they have authorized the capture Slack app via `/oauth/start`, otherwise as the bot), and writes a durable Markdown copy under the data root. It also serves `GET /usage` (latest rate-limit window sample) and `GET /threads` (open Slack threads from the session ledger, enriched with Slack root titles) and `GET /health`.

In an assembled runtime the code lives at `<runtime>/framework/services/ingest/server/ingest.py` and imports `thread_status` from `<framework>/ops/menubar` (derived from the file location; override with `HUMANWARE_FRAMEWORK_OPS`). The instance supplies the LaunchAgent and a run script that hydrates secrets and exports configuration, under `<runtime>/config/services/ingest/`.

## Configuration

Required (the server exits with status 2 and names each missing value): `HUMANWARE_DATA_ROOT`, `SLACK_BOT_TOKEN` (warned, captures 500 until set), `MENUBAR_INBOX_CHANNEL`, `MENUBAR_SLACK_TEAM_ID` (or `HUMANWARE_SLACK_TEAM_ID`), `HUMANWARE_SLACK_WORKSPACE_DOMAIN`.

Optional: `MENUBAR_INGEST_BIND` (default `127.0.0.1:8899`; bind a private-network address to expose it to peers), `MENUBAR_INGEST_TOKEN`, `SLACK_BOT_TOKENS`, `MENUBAR_BOT_LABEL`, `MENUBAR_CAPTURE_DIR`, `MENUBAR_SESSIONS_PATH`, `MENUBAR_USER_TOKEN_<SLACK_USER_ID>`, `MENUBAR_CAPTURE_CLIENT_ID` / `MENUBAR_CAPTURE_CLIENT_SECRET` / `MENUBAR_OAUTH_REDIRECT` (all three enable OAuth), `MENUBAR_USER_TOKEN_DOPPLER_PROJECT` / `MENUBAR_USER_TOKEN_DOPPLER_CONFIG` (where the OAuth callback stores user tokens), `MENUBAR_DOPPLER_BIN`. See the module docstring for details.

## Tests

```sh
python3 -m unittest discover -s services/ingest/server -p "test_*.py"
```
