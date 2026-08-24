# Data plane

The Humanware OS data plane stores what happened, what was learned, what is being worked on, and what was produced. It lives outside source repositories and does not require pull requests for ordinary writes.

Budget: 1,200 words. Over it, consolidate.

## Reference layout

```text
data-root/
├── stream/          append-only raw events and captures
├── memory/
│   ├── events/      append-only facts, decisions, corrections, provenance
│   ├── current/     compact mutable projections loaded by agents
│   └── indexes/     rebuildable search and vector indexes
├── strategy/        current strategy plus immutable revision events
├── sessions/        conversation events, handoffs, and completion records
├── workspaces/      mutable project and thread-owned working documents
├── artifacts/       immutable published or reviewable revisions
├── imports/         immutable external corpora and migration snapshots
├── blobs/           content-addressed large files
├── manifests/       relationships, provenance, schemas, and retention
├── derived/         reproducible transcripts, summaries, renders, reports
├── inbox/           captured material awaiting classification
└── cache/           disposable runtime cache
```

The instance declares `dataRoot`; framework code never hardcodes a username or machine path.

## Append-only evidence, mutable views

Raw stream events are immutable. A correction is a new event that references and supersedes the earlier event.

Memory evidence follows the same rule. An agent appends a learned fact or decision with its source and confidence. `memory/current` is a curated projection over those events. It may merge, replace, or omit stale facts because its history remains recoverable from events. This keeps daily context small without rewriting evidence.

Strategy uses the same shape: agents load one current document, while changes append a dated decision event that preserves why the projection changed.

## Working documents

Working documents are mutable and owned by a project or conversation. They use automatic filesystem snapshots or content revisions, not Git PRs. A workspace manifest records its owner, originating session, creation time, current status, source references, and promoted outputs. Two live sessions do not write the same workspace without an explicit handoff.

## Artifacts and derived data

An artifact revision is immutable. Editing an artifact creates a new revision linked with `supersedes`. Framework code owns renderers, shells, schemas, and publication behavior; the data plane owns rendered content, source material, and manifests. Agents stage artifact candidates in a task-owned workspace and promote them only through the instance's artifact service. Canonical revisions live in a non-served store. A versioned registry is the publication authority, and a disposable review projection is generated only from registered revisions. The domain adapter serves that projection rather than the canonical store, so filesystem presence cannot create an addressable artifact. The service is the single writer for canonical revisions and the registry and the sole builder of project indexes, compatibility aliases, and the review projection; instructions must not tell an agent to copy a candidate directly into either artifact location or update discovery files by hand.

Promotion fails closed in this order: validate the staged candidate, install the immutable revision, prepare the next registry, build and verify a complete temporary review projection, commit the registry, then atomically swap the projection. An interrupted promotion may leave an inert unregistered revision in the non-served store, but it must never expose a URL. Public publication is a separate explicit transition and may resolve sources only through the registry.

Derived files are reproducible and may be overwritten or discarded. Every durable derived item records the source event identifiers, model or tool, schema version, and creation time so it can be rebuilt honestly.

Imports preserve an external corpus exactly as received, including its original relative paths and a checksum manifest. A pre-consolidation repository tree belongs here when it is useful for later inspection or search but is no longer source configuration.

## Sessions

Channels are inputs to the session ledger, not durable memory. A canonical conversation event records channel adapter, external thread identifier, agent identity, selected execution profile, timestamps, attachments, delivery result, and the same outbound status that rendered the Status footer and root tile. A channel export may preserve the surface transcript, but memory promotion is a separate deliberate operation.

The canonical ledger is append-only JSONL under `sessions/events/` and conforms to `schemas/session-event.schema.json`. Stable event identifiers make adapters idempotent. Harness-specific raw traces remain Tier 0 evidence; normalized events retain a bounded source reference so an operator can inspect that evidence locally without copying it into every projection.

The private domain is the operational home for sessions. Its derived view may show objective, owner, channel, model, harness, status, elapsed time, usage, actions, bounded outputs, errors, retries, files, reviews, and deployments. Chat surfaces should receive concise checkpoints and completion summaries, not the full execution stream.

Trace levels are `normal` (deliberate checkpoints and outcomes), `verbose` (sanitized tool activity and provider-visible reasoning summaries), and `forensic` (normalized event types and raw-evidence references). Hidden token-by-token model chain-of-thought is neither a portable interface nor durable memory. If a provider deliberately exposes a reasoning summary, record it as provider-visible evidence; never label synthesized rationale as raw reasoning.

## Privacy and access

The data plane enforces scopes at retrieval time:

- Tier 0 raw events stay on the trusted local network unless a human explicitly supplies an item to another context.
- Tier 1 derived material is local by default and shared deliberately.
- Tier 2 current memory and strategy are available only to approved agent identities and tasks.
- Public artifacts contain only explicitly published revisions.

Search returns references and the smallest relevant projection before returning full source material. A cloud harness does not gain raw-data access merely because it can edit code.

Secrets are not data-plane content. They remain in the instance secrets manager and appear in manifests only by key name.

## Durability

The canonical data root lives on the primary host. It has encrypted versioned backup to a second device, a NAS snapshot path, and an offline or offsite copy. Append-only stores use no-delete replication. Mutable workspaces and projections use versioned snapshots. Restore tests sample every class: event, memory projection, working document, artifact, blob, and index rebuild.

Source-code deployment never deletes or rewrites data. A schema migration writes a new version or projection, verifies it, then changes the instance's active schema reference. Rollback preserves all newer events and reselects the earlier compatible projection.
