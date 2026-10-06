# Session Console and Activity

The [traceable activity contract](docs/traceable-activity-index-spec.md) owns the envelope. The builder copies OpenClaw's sanitized SQLite trajectory into Humanware evidence, appends a separate metadata projection to the canonical session ledger, and builds the session feed and Activity index. No new daemon, permission evaluator, memory writer, or platform store is introduced. Runtime assembly already includes this directory and the domain surfaces.

## Producer and projection paths

- `evidence/sessions/events/YYYY-MM-DD.jsonl`: append-only events, independent of display level.
- `evidence/sessions/raw/openclaw/YYYY-MM-DD.jsonl`: append-only sanitized provider-visible activity, including messages and tool calls/results but never hidden chain-of-thought.
- `evidence/memory/events/`: normalized memory-service events alongside historical evidence. Untyped historical memory contributes to the coverage gap, never inferred lineage.
- `generated/sessions/current.json`: recent session events including memory events, with truncation indicated.
- `generated/sessions/records/*.json`: one private file per session, with summary first and the complete captured activity second.
- `generated/indexes/activity/index.sqlite`: one disposable SQLite store, day-partitioned through `(day,id)` keys and indexed across dates by actor, session/run, and target.
- `generated/indexes/activity/current.json` and `days/*.json`: metadata manifest and content-addressed static exports of that store. Old partition exports remain readable for in-flight clients; removing the entire generated Activity directory and rebuilding is safe while the surface is offline.

Other trusted host adapters call `activity.emit(data_root, **fields)` or construct `activity.event(...)` and use `append_events`. Supply stable IDs from observed source records, an actor/profile, UTC timestamp, session/run, and typed source references. Parent IDs are observed causal edges, not chronological guesses. The helper constructs a closed metadata envelope; arbitrary dictionaries, summaries, commands, outputs, prompts, and memory text are excluded. This API must never be registered as a model-callable self-report tool. Memory producers keep claim IDs and introduction/membership snapshots with the claim in their own projections.

The OpenClaw adapter translates tool calls/results, context compilation, model invocation/completion, and explicit host context/memory events. It never derives grants from prompts, success from response prose, or cost from cumulative session estimates. Existing records without observed run/profile/policy/context membership remain unknown. Exact or estimated costs require a typed provider-report/rate reference; missing monetary data remains unavailable even when tokens are known. Each usage report represents one invocation; reuse the event ID on replay and the stable `usageId` across append-only corrections. Totals use the latest report per identity/invocation, attributed to its first observed day and retaining all source reports. When the adapter lacks an invocation identifier, its event ID is the usage key and later reconciliation remains unavailable. Never emit a second cumulative rollup for the same usage.

Version 1/2 evidence remains unchanged. New indexed activity uses version 3. The builder reconstructs historical event metadata and never copies raw titles, commands, excerpts, or reasoning into the cross-session Activity feed. Full sanitized activity remains available only in the local session record. There is deliberately no browser endpoint for Tier 0 raw payloads.

## Rebuild

Rebuild from evidence alone with the runtime's `activity.py --data-root` command. The data-root argument is the absolute instance-selected data root. This requires only Python's standard library. Normal scheduled session-console builds also rebuild Activity. Invalid evidence and conflicting IDs abort publication; the previous feed remains available and becomes visibly stale. No production schema migration or ledger rewrite is needed. Rebuild cost is linear in retained evidence; this initial slice does not implement incremental indexing.

## Private surfaces

The template route manifest declares private `/activity/` and `/sessions/` routes. The deployment adapter must serve their framework assets, map `/activity/data.json` to the Activity manifest, `/activity/days/*` to the exported partitions, and `/sessions/data.json` to the existing session feed. Apply the same network and identity gate to HTML, scripts and JSON; never expose the SQLite file, evidence directories, or data-root directory listings. These are instance deployment bindings, not a new standalone server.

Activity searches dates, identity, kind, target, reversibility and channel. It shows separate exact/estimated subtotals and missing-report counts by identity/profile/day/currency. Spend uses date and identity filters only; lineage shows the latest observed membership across all dates. Sessions renders the same metadata trace by run, linking truncated history to Activity. Freshness uses the generation time (stale after two minutes); source coverage is separate and does not claim unobserved actions.

The framework Sessions page is a fallback for the established `/sessions/` route. An instance overlay at `surfaces/static/sessions/index.html` retains precedence. To adopt the trace without replacing its shell, import `/activity/trace.js` and call `renderTrace(container, session.events)` with each event's `logicalSessionId`; handle `?session=` and `?run=` links in its session selection. Add the Activity route and data bindings through the existing instance manifest/deployment review. This PR changes no private instance or production route.

## Verification and remaining acceptance

Python tests exercise synthetic two-identity causal traces, multi-day queries, idempotent emission/rebuild, memory membership, malformed evidence, cost states, partial source writes, and payload exclusion from the SQLite store and both web feeds. Node tests cover filters, escaping, freshness, navigation, and trace rendering. JSON Schema validation is a test-only dependency; production uses the closed metadata helper and standard-library SQLite.

Live coverage on each enabled harness, actual provider reconciliation, instance-overlay adoption, and unauthorized-client rejection require separately reviewed instance integration and deployment. This slice does not claim universal harness instrumentation or retroactive lineage for prose-only memory. There is no merge, restart, or deployment authorization in implementation approval.
