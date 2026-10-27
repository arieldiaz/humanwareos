# Notion comment channel

Loopback webhook adapter that lets the owner address Liv or Max in a Notion comment and receive that agent's reply, authored by its own Notion bot, in the same discussion. The contract is [docs/notion-comments.md](docs/notion-comments.md). The service listens on `127.0.0.1:<port>` (default 8797) with `POST /webhook/notion/<agent>` per agent connection and `GET /health`. It has no npm dependencies and requires Node 22.13 or later for `node:sqlite`.

## Configuration

Instance config is read from `$NOTION_COMMENTS_CONFIG`, else `$HUMANWARE_RUNTIME_ROOT/config/services/notion-comments/config.json`. `config.example.json` documents every key:

- `ownerUserId`: the only Notion user whose comments can start a turn.
- `agents.<id>`: one block per agent and Notion connection. `<id>` is the gateway agent ID and the webhook path segment. `aliases` are plain-text mention names (`@liv`). `secrets.notionToken` (required) and `secrets.verificationToken` (optional) are secret IDs resolved through `ops/openclaw/runtime/secret-exec.sh`; values never appear in config, argv, or logs. Each connection's bot user ID is read from `GET /v1/users/me` at startup.
- `port`, `dataDir` (default `$HUMANWARE_DATA_ROOT/working/projects/notion-comments`), `notionVersion` (default `2026-03-11`), `maxReplyChars` (default 8000).
- `waitSliceMs` (default 60000) bounds each `agent.wait` call, `waitPollMs` (default 5000) spaces observations, and `waitCeilingMs` (default and maximum 86400000) is the longest a run is awaited before it is held.

Environment: `HUMANWARE_DATA_ROOT` (required), `HUMANWARE_RUNTIME_ROOT` (default derived from the file location), `NOTION_COMMENTS_CONFIG`, and `OPENCLAW_BIN` (default `openclaw` on `PATH`). The data directory holds `comments.sqlite3`, `requests/<digest>/request.json` (the owner text and untrusted context the agent reads; 0700 directories, 0600 files), and `verification-tokens/<agent>` until each token moves into the secret manager.

## Gateway contract

`gateway call agent` admits the turn with `deliver: false`, session `agent:<agent>:notion:discussion:<id>`, and idempotency key `notion-comment:<comment-id>:<agent>`, and returns the run ID. `gateway call` accepts params only as an argv JSON string, so the message carries only the request-record path. `agent.wait` returns `terminalReply` (`visible` with `text`, `silent`, or `empty`) when the run ends. If the wait observation is lost, `chat.history` for the session supplies the last assistant message whose `__openclaw.runId` matches.

## Setup

Repeat steps 1 to 6 for each agent.

1. In Notion's [connection settings](https://app.notion.com/developers/connections), create an internal connection named for the agent, for example Liv. Under Capabilities enable read content, read comments, and insert comments.
2. Store the connection's token in the instance secret manager under the key named by `agents.<id>.secrets.notionToken`.
3. Share each page where that agent should answer with its connection (page menu, Connections). A connection only receives events and reads comments for pages it can access, so an agent cannot answer on a page not shared with it.
4. Add the agent to the instance config. Once for the service, add a LaunchAgent that runs `node <runtime>/framework/services/notion-comments/server.mjs` with `HUMANWARE_DATA_ROOT`, and a public HTTPS route in the instance Caddyfile that reverse-proxies only `POST /webhook/notion/liv` and `/webhook/notion/max` to `127.0.0.1:<port>`. Notion cannot reach localhost. These are instance changes and need their own approval.
5. In the connection's Webhooks tab, create a subscription for `https://<public-host>/webhook/notion/<id>` with the `comment.created` event. Notion sends a one-time verification request; the service stores the token in `<dataDir>/verification-tokens/<id>`.
6. Read that file on the host, paste its value into Notion's Verify dialog, and submit. Successful verification proves the captured token is Notion's. Optionally move the value into the secret manager under `agents.<id>.secrets.verificationToken`, delete the file, and restart the service.
7. Find the owner's Notion user ID (for example from a test comment fetched with the API) and set `ownerUserId`. Comment `@liv hello` on a page shared with Liv's connection and check `GET /health` and the reply.

To re-verify after recreating a subscription, remove that agent's stored token (file or secret) first; the service never replaces an existing token from an unsigned request.

## Operation

A row in `waiting` has a persisted run ID and resumes waiting after a restart. Held rows (`state = 'held'` in `notion_comments`) make health fail. Each records a bounded `reason`: `admission_unconfirmed`, `turn_error`, `turn_timeout`, `reply_text_unavailable`, `wait_ceiling`, `reply_<status>`, or `interrupted_<state>`. Inspect the gateway session and the Notion discussion before acting; never reset a row to `received` to force a retry, because the turn may already have run or the reply may already exist.

## Tests

```sh
node --test services/notion-comments/*.test.mjs
```

Tests use synthetic fixtures with a mocked Notion API and gateway. They do not contact Notion or the gateway.
