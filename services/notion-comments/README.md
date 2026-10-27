# Notion comment channel

Loopback webhook adapter that lets the owner address an agent in a Notion comment and receive the reply in the same discussion. The contract is [docs/notion-comments.md](docs/notion-comments.md). The service listens on `127.0.0.1:<port>` (default 8797) with `POST /webhook/notion` and `GET /health`. It has no npm dependencies and requires Node 22.13 or later for `node:sqlite`.

## Configuration

Instance config is read from `$NOTION_COMMENTS_CONFIG`, else `$HUMANWARE_RUNTIME_ROOT/config/services/notion-comments/config.json`. `config.example.json` documents every key:

- `ownerUserId`: the only Notion user whose comments can start a turn.
- `routes`: plain-text mention name to agent ID, for example `@liv` to `liv`.
- `mentionUsers`: optional Notion user ID to agent ID, for user or bot mentions that should also route.
- `displayNames`: agent ID to the custom author name shown on replies.
- `secrets.notionToken` (required) and `secrets.verificationToken` (optional): secret IDs resolved through `ops/openclaw/runtime/secret-exec.sh`. Values never appear in config, argv, or logs.
- `port`, `dataDir` (default `$HUMANWARE_DATA_ROOT/working/projects/notion-comments`), `notionVersion` (default `2026-03-11`), `turnTimeoutMs` (default 900000), `maxReplyChars` (default 8000).

Environment: `HUMANWARE_DATA_ROOT` (required), `HUMANWARE_RUNTIME_ROOT` (default derived from the file location), `NOTION_COMMENTS_CONFIG`, and `OPENCLAW_BIN` (default `openclaw` on `PATH`). The data directory holds `comments.sqlite3` and, until the token moves into the secret manager, `verification-token`, both mode 0600.

## Setup

1. In Notion's [connection settings](https://app.notion.com/developers/connections), create an internal connection for the workspace. Under Capabilities enable read content, read comments, and insert comments. User information is not required.
2. Store the connection's token in the instance secret manager under the key named by `secrets.notionToken`.
3. Share each page where the channel should work with the connection (page menu, Connections). The connection only receives events and reads comments for pages it can access.
4. Add the instance config, a LaunchAgent that runs `node <runtime>/framework/services/notion-comments/server.mjs` with `HUMANWARE_DATA_ROOT`, and a public HTTPS route in the instance Caddyfile that reverse-proxies only `POST /webhook/notion` to `127.0.0.1:<port>`. Notion cannot reach localhost. These are instance changes and need their own approval.
5. In the connection's Webhooks tab, create a subscription with the public URL and the `comment.created` event. Notion sends a one-time verification request; the service stores the token in `<dataDir>/verification-token`.
6. Read that file on the host, paste its value into Notion's Verify dialog, and submit. Successful verification proves the captured token is Notion's. Optionally move the value into the secret manager under `secrets.verificationToken`, delete the file, and restart the service.
7. Find the owner's Notion user ID (for example from a test comment fetched with the API) and set `ownerUserId`. Comment `@liv hello` on a shared page and check `GET /health` and the reply.

To re-verify after recreating the subscription, remove the stored token (file or secret) first; the service never replaces an existing token from an unsigned request.

## Operation

Held rows (`state = 'held'` in `notion_comments`) make health fail. Each records a bounded `reason`, such as `gateway_turn_unconfirmed`, `turn_error`, `reply_502`, or `interrupted_dispatching`. Inspect the gateway session (`agent:<agent>:notion:discussion:<discussion-id>`) and the Notion discussion before acting; never reset a row to `received` to force a retry, because the turn may already have run or the reply may already exist.

## Tests

```sh
node --test services/notion-comments/*.test.mjs
```

Tests use synthetic fixtures with a mocked Notion API and gateway. They do not contact Notion or the gateway.
