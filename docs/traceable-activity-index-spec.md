# Traceable activity index

Implementation spec. Draft for review before build. Budget: 900 words.

## Problem

Operators should be able to inspect everything their agents do: what an agent did, on whose authority, what it touched, and what it cost. [data-plane.md](data-plane.md) already defines the right foundation. The canonical session ledger lives under `evidence/sessions/events/`, conforms to `schemas/session-event.schema.json`, and has a domain session view. In practice, adapters emit lifecycle status and little else. One sampled day on a live instance had 63 ledger events across two identities, and every one was `status.set`. The ledger shows that a turn happened, but not what the agent did.

Hosted agent platforms such as MongoDB Atlas Agent Engine sell exactly this capability: every action is logged against an identity and an authorization, and all of it is queryable in one place. Humanware can offer the same thing without a new store, as long as it keeps its privacy tiers.

## Principles

- Extend the existing ledger. Don't add a new store or system of record.
- The index is generated under `generated/indexes/activity/` and can always be rebuilt from evidence.
- Privacy tiers are unchanged. Projections carry summaries and bounded `sourceRef` links. Tier 0 content is reached by following a link locally and is never copied.
- Adapters emit action events. Models do not self-report actions.

## Changes

### 1. Ledger action events

Add these event kinds to `schemas/session-event.schema.json`: `action.tool`, `action.write`, `action.send`, `action.approval`, `action.schedule`, and `usage.cost`. Add these optional fields:

- `actor`: the agent identity plus the execution profile.
- `authority`: a reference to the approving human message, a standing grant from [permission-model.md](permission-model.md), or `none`.
- `target`: a path, a channel, a URL host, or a repository and pull request. Never content.
- `reversibility`: `reversible`, `outward`, or `irreversible`, using the permission model's categories.
- `cost`: tokens and currency amount, when the provider reports them.

Each harness adapter normalizes the tool calls and delivery results it already observes. Ordinary actions are emitted at `verbose` level. Outward and irreversible actions are always emitted at `normal` level.

### 2. Generated activity index

The index is a daily embedded database (SQLite or DuckDB), rebuilt from the session ledger and from `evidence/memory/events`. It supports these queries:

- actions by identity over a time range;
- the authority chain for a single action;
- every action that touched a given target;
- memory lineage: which session introduced each fact in the current memory projection;
- spend by identity, by profile, and by day.

Every row keeps its source event identifiers. Rebuilding is idempotent, and a test covers it.

### 3. Domain Activity view

The framework shell gets one authenticated route with three panes:

- **Timeline:** actions grouped by identity, filterable by kind, reversibility, and channel. Outward and irreversible actions are highlighted.
- **Trace drawer:** for a selected action, shows the session, the authorizing message, the target, the delivery result, and a local-only link to the raw evidence.
- **Memory lineage:** for any current memory fact, shows the event that introduced it and the session it came from.

A spend strip shows cost per identity per day. Each pane distinguishes current, stale, and unavailable data, as [domain-surface.md](domain-surface.md) requires. Instances may restyle the view through `surfaces/static/` but may not fork the route or its privacy contract.

## Out of scope

- Hosted memory or governance services.
- Semantic search over the ledger. Revisit after the plain index proves useful.
- Policy enforcement. This work only observes; enforcement stays with the permission model.

## Acceptance

1. One full day of activity from two identities produces action events for tool calls, writes, sends, and schedules.
2. For an outward action from the past week, "who authorized this?" resolves to a human message in two clicks or fewer.
3. Rebuilding the index from evidence alone produces an identical result.
4. No Tier 0 content appears in the index or in any domain response, and a test covers this.
5. For one sampled day, the spend strip matches provider billing within 5%.

## Order

Each step is its own pull request, in this order: schema and adapter emitters, then the index, then the timeline and trace drawer, then memory lineage, then spend.

## Open questions

- Should the index reuse the store chosen by the product-side agent-platform evaluation (Mastra versus Agent Engine), so the team learns only one?
- Should Activity be absorbed into the existing session view, or ship as a sibling route?
