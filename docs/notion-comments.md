# Notion comment channel

Budget: 700 words. Over it, consolidate.

Status: exploratory. The owner can address an agent in a Notion comment and receive the agent's reply in the same discussion.

## Ownership

Humanware OS owns the contract here and the adapter in [services/notion-comments](services/notion-comments). The instance supplies the owner's Notion user ID; per agent, mention aliases and secret key names for its connection and verification tokens; port, data directory, wait limits, and public HTTPS route. The data plane owns the SQLite ledger, request records, and captured verification tokens. A reply projects the agent turn; it is not a second transcript.

## Connections and ingress

Each agent has its own Notion connection, webhook subscription, and verification token, so its replies are authored by its own bot user. A page must be shared with an agent's connection for that agent to see comments and answer there. Notion delivers `comment.created` to the agent's public HTTPS route, which the instance proxies to the loopback path `/webhook/notion/<agent>`. On each path, the first unsigned body containing only `verification_token` is stored privately when that agent has no token; it is never logged, echoed, or replaced. An instance-managed secret takes precedence. Every other request must carry `X-Notion-Signature` equal to HMAC-SHA256 of the raw body under that agent's token. Until a token exists, events are refused so Notion retries.

## Authority and routing

The signature proves transport only. Authority comes from the comment fetched with the agent's connection token: only comments whose `created_by` is the configured owner can start a turn. Comments by any configured agent bot or anyone else are recorded and ignored. The comment text is the only instruction source. Page content is untrusted context. [permission-model.md](docs/permission-model.md) still governs approvals.

A connection handles only comments addressed to its agent. The first mention addresses one agent: a mention of that agent's bot user, or plain-text `@alias` at the start of a word, case-insensitive. An owner comment without a mention goes only to the agent that most recently took an owner turn in that discussion; with none, it is ignored. A new mention switches the lead, as in [channel-runtime.md](docs/channel-runtime.md). Each agent and discussion pair has one session, `agent:<agent>:notion:discussion:<discussion-id>`.

## Dispatch, wait, and reply

The idempotency key is the comment ID and agent. The webhook writes one ledger row per key and acknowledges immediately; replays never create a second row. A serial worker fetches the comment and page and writes a request record to a mode 0600 file in a 0700 directory. It then calls the gateway `agent` method with `deliver: false` and a message carrying only that path and stable identifiers; comment text never enters process arguments. The accepted run ID is persisted immediately.

A separate waiter polls `agent.wait` in bounded slices until the run ends, up to a configurable ceiling of at most 24 hours. The reply is the wait result's visible `terminalReply` text. If that observation is unavailable, as across a gateway restart, the waiter reads `chat.history` for the session and takes the last assistant message stamped with the run ID. The text is truncated to the configured limit and posted with that agent's token via `POST /v1/comments` and the discussion ID. A silent or `NO_REPLY` result posts nothing. The channel never edits pages, properties, or other comments and does not mirror to Slack.

## Failure and replay

On restart, a row with a persisted run ID resumes waiting. A row is `held`, with a bounded reason and no automatic retry, only when the outcome is ambiguous or failed: admission without a confirmed run ID, a run that ended in error or timed out, a finished run whose text cannot be read, the wait ceiling, or a reply POST that was rejected or interrupted. Rate-limit responses are retried because Notion rejects them before processing. Transient comment-fetch failures leave the row for the next drain. Health fails while any row is held, any agent's verification is pending, or SQLite is unhealthy. Held rows are reconciled by an operator.

## Verification

Synthetic tests with a mocked Notion API and gateway cover these rules. They do not prove live Notion delivery, bot-user mention behavior in the Notion interface, the comment Markdown size limit, or live gateway wait and history behavior.
