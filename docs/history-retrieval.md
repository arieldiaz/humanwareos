# History retrieval

"Ask the history" turns a goal into a small context pack drawn from recent sessions, decisions, and pull requests. Layer 2 spec — see `docs/agent-context-hierarchy.md`. Placement and privacy tiers are owned by `docs/data-plane.md`.

Budget: 700 words. Over it, consolidate.

## Shape

```text
goal → broad local search (50–200 candidates) → Jev keep-probability per candidate → pack (~15 kept + dropped ids)
```

1. **Retrieve broadly.** Local MongoDB text search returns up to 200 candidates by text score, then recency. Search favors recall; Jev supplies precision.
2. **Score.** Each candidate's egress view is sent to Jev (`typesafe/jev-1.13` through OpenRouter's decisions endpoint), which answers one typed question per candidate: the probability the record is needed for the goal. Jev estimates relevance; it does not rewrite, summarize, delete, or change policy.
3. **Pack.** Candidates are ranked by keep-probability, with search rank breaking ties, and the top 15 at or above the keep threshold (default 0.25) are kept. Every other candidate is listed by id and score for local `--show`.

The pack reports provider input tokens, output tokens, and cost per request, and marks usage unknown when a request fails first.

## Fail keep

An invalid or missing probability, HTTP error, timeout, or malformed body leaves the affected candidates `unscored`, treated as keep; the pack never fails. Unscored candidates rank after scored keeps and before scored drops. Jev can shrink a pack; it can never make evidence disappear.

## Bounded requests

A request carries at most 16 candidates, 10,000 characters of candidate text, and 64 KiB of body. A pack makes at most 16 bounded-concurrency requests, each with a timeout. Candidates beyond the request limit are unscored. Source text is labeled as data and cannot change the retention question.

## Privacy

The egress mode decides what may leave the machine. The default is **metadata**:

- sessions: agent, surface kind, date, agent-authored label, tool names with counts, files touched;
- pull requests: number, title, description, state, dates, changed paths;
- decisions: the curated one-line summary of a memory event.

Raw conversation text, tool output, Slack root-message excerpts, and raw channel, thread, or message identifiers never leave in metadata mode. The egress view is built by an allowlist, not a denylist, and it is the only value the Jev client can serialize. A **full** mode that also sends bounded conversation excerpts exists only when the owner explicitly selects it per invocation; no configuration default can enable it.

Local search may use raw text because the index never leaves the host.

## Sources and index

This feature is a retrieval layer: it owns search, scoring, and packing, never records. A source adapter yields `{id, kind, ts, title, meta, sourceRef, localText?}`. `meta` is the allowlisted source of the egress view; `localText` is optional and host-only. Adapters never infer fields their source lacks.

The intended source is the Activity index (PR #117): sessions and decisions come from its events and memory lineage, keyed by its ids. Until it is active, an interim adapter reads harness transcript stores read-only and memory events; it is deleted once the Activity adapter passes adapter parity in `docs/history-retrieval-eval.md`. Pull requests keep their own adapter until Activity records them.

MongoDB is a rebuildable index under `generated/`, never a system of record. Ingest upserts one document per record by stable id with its source reference and ingest time; deleting the database and re-running ingest reproduces it.

The instance supervises the server on loopback only. The instance secrets provider injects the OpenRouter key into the environment; it is never stored in the index, a pack, or a log.

## Command

```text
ask-history "<goal>"            pack, Jev-filtered
ask-history --search "<goal>"   search-only top 15, no egress
ask-history --compare "<goal>"  both, side by side, with usage
ask-history --show <id>         one local document
ask-history --ingest --days 14 --pr-repo <owner/name>
```

Output is JSON, or text with `--text`. `--egress full` is the per-invocation opt-in.

## Limits

Keep-probabilities are uncalibrated. In metadata mode a session is judged only by agent, channel, label, tools, and files, so sessions whose relevance lives in conversation text are dropped even when search ranked them first; Jev suits pull-request and decision goals better than personal ones. Whether it beats search is measured by `docs/history-retrieval-eval.md`.
