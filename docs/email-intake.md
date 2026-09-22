# Email intake

Budget: 1,300 words.

## Ownership and authority

Humanware OS owns the provider-neutral intake contract, deterministic policy, correlation, repository, and effect intents in [ops/email-intake](ops/email-intake). The instance supplies recipient routes, intake channel, ingress authentication, size and time limits, private evidence access, SQLite path, domain verification, Slack authentication and destination resolution. SQLite files and all message, conversation, operation, and effect records belong in the data plane.

Email is untrusted context. `receive` accepts no execution authority. Only `promote`, using an independently authenticated allowed human Slack event in the persisted intake thread, can enter `promoted`. The command must explicitly name a resolvable destination different from the intake channel. A missing or unresolved destination produces one question intent per Slack event and no work intent. Matching uses the authenticated event's text, never email text or a caller-supplied actor flag. Instances must not expose repository writes, lifecycle methods, or trusted ports to mail ingress.

## Normalized contracts

[model.mjs](ops/email-intake/model.mjs) owns runtime message validation. Version 1 accepts a provider namespace `source`, stable `deliveryId`, one envelope `recipient`, `sender`, optional `messageId` and `inReplyTo`, ordered `references`, `subject`, `receivedAt`, `sizeBytes`, `automatic` (`none`, `automated`, `bulk`, `loop`), and a private `evidenceRef`. The provider adapter parses MIME and address/header syntax and supplies stable delivery identity and receipt time. Fan out multiple declared envelope recipients before calling intake. Do not infer recipient ownership from subject or body.

Normalization lowercases bare addresses, strips Message-ID angle brackets without changing case, normalizes timestamps to UTC, strips repeated reply/forward subject prefixes, and computes a stable recipient-scoped message key. Unknown properties are discarded. Raw MIME, HTML, attachments, body text, routing commands, and claims of authority never enter this contract. Evidence references are private pointers, not fetchable public URLs or Slack content.

Each persisted conversation has `schemaVersion`, `intakeId`, monotonic `revision`, normalized recipient, initial sender and subject key, owner, intake class, processing state, lifecycle, creation/update/latest-receipt timestamps, immutable `intakeThread`, optional verified receipt, wake evidence, bounded failure code, and promotion provenance. A promotion includes its Slack event and actor, resolved destination, coding-session request, and initially empty work-thread/session identities. Delivery acknowledgements retain confirmed external results; they do not manufacture completed work.

## Classification, correlation, and lifecycle

Reject undeclared recipients and oversized input before calling any domain or agent port. A verified domain receipt takes precedence; otherwise automated, bulk, and looping mail cannot dispatch an agent or trigger an email reply. Quick handling requires a trusted assessment identifying an authorized bounded question or record action. Everything else awaits promotion. Classification is conservative and deterministic; this slice does not implement a natural-language classifier or execute a requested action.

Correlation is recipient-scoped. Search References from nearest ancestor backward, then In-Reply-To. Unknown explicit ancestry starts a separate conversation. Without ancestry, fallback requires a nonempty normalized subject, the same sender and recipient, exactly one candidate, and a latest receipt within the configured preceding time window. Ambiguity starts a new conversation. Headers establish mail continuity, never trusted actor identity.

Initial processing becomes `recorded`, `working`, `awaiting_promotion`, or `rejected`. Quick handling permits `answered`, `clarify`, `act`, `scheduled`, and resumption to `working`; it cannot close or promote. Scheduling requires a future timestamp and a durable wake ID supplied by the control plane. Trusted Slack `close intake` closes the record. The lifecycle follows [docs/status-framework.md](docs/status-framework.md): clarification and answered turns map to `act`; intake processing states are not additional lifecycle values. Rejection and delivery failure can have no conversation tile (`null`). The verified-receipt exception is owned by that specification.

Follow-up mail appends to the same intake and preserves workflow state, ownership, and promotion destination. It never dispatches additional work or mirrors content into a work thread in this slice. Domain operations deduplicate separately by recipient, domain, and operation ID, so a second delivery with a new Message-ID does not create another receipt root. Retry failure retains the resumable state; exhausted retries enter `dead_letter` and enqueue one bounded fault per intake. The queue adapter owns retry limits and durable wakes.

## Trusted ports and effects

All ports are synchronous; perform network calls outside SQLite transactions and supply independently verified results through trusted adapters. `assessQuick(message)` returns `{kind, bounded, authorized}` or null. `verifiedReceipt(message)` returns null or a service-proved `{verified: true, messageKey, domain, operationId, resourceId, outcome, verifiedAt}`. Outcomes are `recorded`, `cancelled`, or `duplicate`; `messageKey` binds proof to this message. This port must read committed domain results, not trust fields extracted from email. Calendar parsing and mutation remain behind the calendar service.

`authenticateSlack(authentication)` validates transport authenticity and the instance's allowed human identity, then returns the original `{surface: "slack", trustedHuman: true, workspaceId, eventId, actorId, channelId, threadTs, text}`. `resolveDestination(name)` returns a registry-confirmed `{name, channelId}` or null. Accepted command forms are `start a coding session in #name` and `promote to #name`; adapters may normalize native Slack channel mentions only after resolving them. No live Slack authentication or channel lookup ships here.

Durable effect kinds are `intake_root`, `intake_append`, `intake_status`, `quick_dispatch`, `promotion_question`, `promoted_work`, and `operational_fault`. Slack adapters resolve private references into compact safe summaries and use the canonical reaction planner. Quick dispatch is limited to its declared bounded scope. A promoted-work adapter creates one linked work root and, when requested and qualified, a session according to [docs/coding-sessions.md](docs/coding-sessions.md). It uses the stable effect key as its downstream idempotency key. No adapter executes these effects in this slice.

## Repository and replay

[repository.mjs](ops/email-intake/repository.mjs) declares the synchronous repository interface and a built-in `node:sqlite` implementation (Node 22.13 or later). The instance supplies a dedicated database path; initialization creates only namespaced v1 tables and indexes. Future table changes require reviewed migrations, never destructive initialization.

`atomic(key, fingerprint, callback)` uses `BEGIN IMMEDIATE` and commits the operation result with every conversation, message, receipt, and effect write, or rolls everything back. Replays return the original result without running the callback. Reusing a command key with different input fails. Email identity intentionally uses first-accepted-message semantics even if transport metadata changes. Missing Message-ID falls back to provider delivery ID, which must remain stable across retries. `save` checks the expected revision. Cross-connection writers serialize through SQLite; process restart preserves all claims and pending effects.

`pendingEffects` returns ordered durable intents; `acknowledgeEffect` stores a confirmed result idempotently, and `effect(key)` retrieves it after restart. The dispatcher must serialize delivery and reconcile ambiguous downstream success before retrying. SQLite alone cannot promise exactly-once Slack publication after a network timeout. Link a confirmed intake root with `linkIntakeThread` before acknowledging delivery; later attempts cannot replace it. Lifecycle changes atomically enqueue status intents, including closure and removal of a failed delivery's tile. Live adapters, safe rendering, email replies, material-change mirroring, sessions/worktrees, deployment, and production schema changes remain later slices.
