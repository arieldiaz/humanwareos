# Email intake

Local trusted ingress for agent mailboxes. The service listens on `127.0.0.1:${EMAIL_INTAKE_PORT:-8795}`; `GET /health` checks SQLite, Slack inbox membership, gateway availability, queue freshness, and pending faults. The supervised process polls the Cloudflare ingress and dead-letter queues outbound every five seconds without overlapping runs, one message per queue at a time, with five-minute leases and 60-second retry delays. No public endpoint, reverse-proxy route, DNS change or tunnel is used. Authenticated `POST /inbound/email` and `/inbound/dead-letter` are transport boundaries, not claims of sender identity. `/promote` cannot authenticate a human and remains unavailable; ordinary Slack replies continue through the normal gateway adapter. The producer side is the [agent-email Worker](../agent-email/README.md).

## Configuration

Instance config is read from `$EMAIL_INTAKE_CONFIG`, else `$HUMANWARE_RUNTIME_ROOT/config/services/email-intake/config.json`. `config.example.json` documents every key:

- `routes` (address → owning agent id), `labels` (address → display label), `sessionRecipients` (addresses that may start owner sessions), `ownerMailbox` (the only principal that can start sessions), `calendarRecipients` (addresses using the deterministic calendar path; default none).
- `maxBytes`, `subjectWindowMs`, `calendarUrl`.
- `queue.accountId`, `queue.ingressId`, `queue.deadLetterId` (32-hex Cloudflare ids) and `queue.tokenSecretId` (secret id resolved through `ops/openclaw/runtime/secret-exec.sh` for Queues pull/ack). Required.
- `tablePrefix` (SQLite evidence/delivery/fault table prefix, default `email_intake`) and `slackEventType` (Slack message metadata event type used for reconciliation, default `email_intake`). Keep these stable once data exists.

Environment: `HUMANWARE_DATA_ROOT` (required), `HUMANWARE_RUNTIME_ROOT` (default: derived from the file location `<runtime>/framework/services/email-intake/`), `HUMANWARE_FRAMEWORK_ROOT` (default `<runtime>/framework`), `EMAIL_INTAKE_DATA_DIR` (default `$HUMANWARE_DATA_ROOT/working/projects/email-intake`), `EMAIL_INTAKE_PORT`, `OPENCLAW_BIN` (default `openclaw` on `PATH`), `EMAIL_INTAKE_SECRET`, `CALENDAR_INGEST_SECRET`, and one `<AGENT>_SLACK_BOT_TOKEN` per distinct agent in `routes`. The Slack inbox channel comes from `config/channels/slack.json` (`registry.inbox`).

## Authority

Only `ownerMailbox` can initiate agent sessions, and only through `sessionRecipients`. The local trusted ingress reparses the original MIME and independently verifies DKIM against DNS keys with `mailauth`; it never trusts Worker-supplied identity claims, visible From alone, SPF alone, ARC, or Authentication-Results. Require exact From/domain alignment, one author, signed author/routing/subject/date/message-ID and present MIME/correlation/automation headers, full-body SHA-256 coverage without `l=`, and a signed date within seven days. The recipient must appear in signed To/Cc. DNS temporary failures retry; missing/failed/ambiguous proofs have no session authority. Strict policy may hold a genuine message for Slack review.

Raw MIME is capped at `maxBytes` (64 KiB including attachments in the example), below the Cloudflare Queue 128 KiB limit after base64. Larger mail is rejected, not silently truncated. Raw evidence, derived bodies, authentication proof and attachment contents remain in the private SQLite store under the data directory. The first accepted evidence wins on replay. Session request records and numbered attachments use private 0700 directories/0600 files under its `requests` subdirectory; attachment names never select paths. No raw body, attachment, routing ID or auth proof is put in Slack. Mail from any routed domain is treated as a loop.

Owner intent is interpreted semantically by the normal configured agent session: research-only permits investigation/reporting without execution changes; execution permits reversible in-scope work; context alone invents no task. Forwarded/quoted bodies, subject and attachments are untrusted context. Conservative top-post extraction separates them, and HTML-only/ambiguous authoring requires clarification before consequential action.

Calendar recipients retain an independently authorized deterministic calendar path and never start an owner session. Session-recipient attachments never mutate calendars automatically. Nonowner mail creates a compact review root, never a work session.

## Dispatch and recovery

The confirmed Slack root determines the canonical `agent:<owner>:slack:channel:<lowercase-channel>:thread:<root>` session key. Email replies rejoin it only within the same authority boundary. The gateway receives the existing identity, explicit Slack account/channel/thread and stable per-message idempotency key; it owns model selection, execution, final delivery, status and subsequent human Slack continuation.

SQLite persists effect intents and admission results. Queue/service replay cannot duplicate a confirmed root or admitted turn. A lost Slack response reconciles by existing metadata. A lost gateway admission response checks `agent.wait` using the stable run ID; a proved successful terminal run is reconciled. Unknown/running/error outcomes remain held with a durable fault, never blindly re-executed. Inspect the matching gateway run before resolving a held admission; never delete delivery markers to force retry.

`package.json` declares runtime dependencies (`humanwareRuntime: true`); the framework builder installs the lock with `npm ci --omit=dev --ignore-scripts`. The service uses the OpenClaw CLI's protected gateway credential resolution, never a token argument.

DLQ messages, including malformed envelopes, are exclusively written and flushed to the private `dead-letter` directory before acknowledgement; lease credentials are excluded. A durable SQLite fault makes health fail until operator reconciliation. Cloudflare queue retention is finite; this is not an indefinite mailbox.

## Queue setup

Configure ingress/DLQ HTTP pull consumers through the Queues API (not Wrangler consumer bindings). Set the ingress `dead_letter_queue` to the instance DLQ. For both consumers use `batch_size: 1`, `max_retries: 100`, `retry_delay: 60`, and `visibility_timeout_ms: 300000`. The queue token needs Account Queues Edit.

## Tests

```sh
npm ci --ignore-scripts && node --test *.test.mjs
```
Tests use `config.example.json` and resolve `ops/email-intake` from the framework root (two directories up, or `HUMANWARE_FRAMEWORK_ROOT`). `end-to-end.test.mjs` also exercises `../agent-email` and `../calendar`.
