# Notion comment channel

Budget: 650 words. Over it, consolidate.

Status: exploratory. The owner can address an agent in a Notion comment and receive the agent's reply in the same discussion.

## Ownership

Humanware OS owns the contract here and the adapter in [services/notion-comments](services/notion-comments). The instance supplies the owner's Notion user ID, the mention-to-agent route map, optional Notion user mentions that also route, reply display names, secret key names for the connection token and webhook verification token, port, data directory, and the public HTTPS route. The data plane owns the SQLite comment ledger and any captured verification token. Notion owns pages and comments; the reply is a projection of the agent turn, not a second transcript.

## Ingress and authority

Notion delivers `comment.created` webhooks to a public HTTPS route that the instance proxies to the loopback service. The first unsigned body containing only `verification_token` is stored privately when no token exists; it is never logged, echoed, or replaced by a later handshake. An instance-managed secret takes precedence. Every other request must carry `X-Notion-Signature` equal to HMAC-SHA256 of the raw body under that token. Until a token exists, events are refused so Notion retries them.

The signature proves transport only. Authority comes from the comment fetched from the Notion API with the connection token: only comments whose `created_by` is the configured owner can start a turn. Comments by the connection's own bot user, other people, or other bots are recorded and ignored. A comment's text is the only instruction source. Page title, URL, parent, and other content are untrusted context passed by reference. The channel grants no approval: merge, restart, public-action, and privacy boundaries remain as in [permission-model.md](docs/permission-model.md).

## Routing and sessions

The first mention in the comment selects the agent: a configured Notion user mention, or plain-text `@name` at the start of a word, matched case-insensitively against the route map. An owner comment without a mention continues the latest agent that handled the discussion; with no prior agent it is ignored. Each agent and discussion pair has one session, `agent:<agent>:notion:discussion:<discussion-id>`, so follow-ups continue the same conversation. A mention of another agent switches the lead, as in [channel-runtime.md](docs/channel-runtime.md).

## Dispatch and reply

The comment ID is the idempotency key. The webhook writes one ledger row per comment ID and acknowledges immediately; replays never create a second row. A serial worker fetches the comment and page, then calls the gateway `agent` method with `deliver: false`, the stable key `notion-comment:<comment-id>`, and a final-response wait. The final response's visible payload text, excluding reasoning, errors, and status notices, is truncated to the configured limit and posted with `POST /v1/comments` using the discussion ID and the agent's display name. Notion comments render inline Markdown only. An empty or `NO_REPLY` result posts nothing.

The channel is read-and-reply. It never edits pages, properties, or other comments, and it does not mirror to Slack.

## Failure and replay

Before calling the gateway the row becomes `dispatching`; before posting it becomes `replying` with the reply text stored. A gateway failure, nonterminal or failed turn, rejected or ambiguous reply, or restart in either state becomes `held` with a bounded reason and is never retried automatically, because neither the gateway nor Notion comment creation guarantees exactly-once execution. Rate-limit responses are retried because Notion rejects them before processing. Transient comment-fetch failures leave the row `received` for the next drain. Health fails while any row is held, verification is pending, or SQLite is unhealthy. Reconciling a held row is an operator action.

## Verification

Synthetic tests cover signatures, token capture, owner and self filtering, mention routing, lead continuation, idempotent receipt, held outcomes, reply shape, and the gateway invocation. They do not prove Notion delivery, bot-user mention behavior in the Notion interface, the comment Markdown size limit, or live gateway final-text replay.
