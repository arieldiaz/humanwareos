# Traceable activity index

Authorized implementation on PR #117. Budget: 900 words.

## Ownership

Humanware owns a portable event envelope over the canonical [session ledger](docs/data-plane.md), not a platform's native store. Mastra, Agent Engine, and harnesses implement adapters. Evidence remains append-only; [permission-model.md](docs/permission-model.md) remains the authority. This feature observes decisions without granting permissions or promoting memory.

The human authorized one coherent production slice on the existing PR: schema, adapter helper, index, Activity and session trace, tests, and documentation. Separate staged implementation PRs are not required. Merge and deployment still require separate human approval.

## Events

Schema version 3 adds `action.tool`, `action.write`, `action.send`, `action.approval`, `action.schedule`, `context.selected`, `context.assembled`, `model.invoked`, `memory.retrieved`, `memory.proposed`, `memory.promoted`, `memory.superseded`, `memory.suppressed`, `memory.deleted`, and `usage.cost`. Historical version 1/2 evidence remains readable and unchanged.

Every event records stable event, logical-session and trace IDs; a run ID when observed; actor identity and profile; UTC timestamp; parent event IDs; a typed source reference; reason code; policy identity, version and result; whether the item entered model context (`true`, `false`, or unavailable `null`); outcome; and reversibility. Missing run IDs stay unavailable, never fabricated. References identify events, human messages, grants, delegations, context items, memory claims, or local raw evidence. Each causal edge must come from observed IDs, never timestamp or prose inference.

Authority results are `not_required`, `human_message`, `standing_grant`, `delegated`, `denied`, and `unknown`. Approving results require the corresponding typed reference. Policy results are `allowed`, `denied`, `not_required`, or `unknown`; evaluated results require policy ID/version. Unknown provenance must remain visible. Targets contain only typed path, channel, host, repository, or schedule identifiers. Requested actions and confirmed delivery/mutation results are distinct outcomes.

Adapters persist every observed event regardless of presentation level. Outward and irreversible activity displays at normal level. Models cannot self-report authoritative events. OpenClaw trajectory normalization and other host producers use the same metadata-only helper. Unsupported observations remain explicit coverage gaps; no adapter may infer a grant, selected memory, successful delivery, or billing from text.

## Memory lineage

Memory services assign stable claim IDs before promotion. Memory events carry `claimId`, `introducedBy` event ID, `supersedes` claim IDs, typed source references, visibility scope, and projection membership IDs. Promotion and supersession require an introduction reference. Mutations carry membership snapshots; retrieval and proposal never change membership. Suppression/deletion remove membership without deleting evidence. Current projections must retain claim IDs; legacy prose has unavailable lineage, never inferred matches. The index consumes normalized memory events from `evidence/memory/events/` without becoming a memory writer.

## Storage and privacy

One rebuildable SQLite store lives at `generated/indexes/activity/index.sqlite`, logically partitioned by UTC day with a day/event primary key and actor/time, session/run, and target indexes. Cross-range queries use the same store. The existing session-console builder also publishes disposable content-addressed daily JSON partitions and a manifest for static private surfaces. These are exports, not additional authorities. Rebuilds deduplicate stable IDs, reject conflicts, preserve the previous publication on invalid evidence, and produce identical ordered rows from identical evidence.

All projections construct allowlisted metadata anew, including historical session events. Prompts, messages, commands, arguments, tool output, memory prose, hidden reasoning, credentials and arbitrary details never enter the index or session trace. Raw references are local-only opaque identifiers, never network-fetchable payload URLs. Inspecting raw evidence requires an authorized local tool; the private domain cannot serve it. Existing source titles are replaced by metadata identifiers where they would copy raw messages.

## Surfaces and cost

Activity is the private cross-session index, searchable by identity, date range, kind, target, reversibility, and channel. Its detail shows authority/policy, causal parents, selected context, delivery outcome and source references. Sessions embeds the same trace component, grouped by observed run ID; Activity links into that session and run. Memory lineage displays claim IDs, introduction, scope, membership, and origin session. Data freshness and missing coverage are visible. Instances may restyle through their existing surface overlays without changing privacy or authority.

Costs are `exact`, `estimated`, or `unavailable`. Known amounts require currency and provider/rate evidence; tokens are independent of amount availability. Totals retain exact and estimated subtotals, missing counts, source event IDs, day, identity, and profile. Unknown is never zero; currencies are never mixed. An exact zero is valid. Reports share a stable invocation `usageId`; append-only corrections replace earlier reports in totals without deleting their evidence. Historical cumulative session estimates are not summed as incremental billing.

## Acceptance

A synthetic two-identity, multi-day run reconstructs actor → authority/policy → selected context → model invocation → tool/memory mutation → delivery using stable references. Tests prove replay, partition queries, cost states, lineage after rebuild, hostile payload exclusion, and run navigation. Full repository checks pass. Live day coverage, provider reconciliation and instance route/authentication acceptance remain deployment checks after separately approved activation; synthetic tests cannot claim them.
