# History retrieval

"Ask the history" turns a goal into a small context pack drawn from recent sessions, decisions, and pull requests. Layer 2 spec — see `docs/agent-context-hierarchy.md`. Placement and privacy tiers are owned by `docs/data-plane.md`.

Budget: 700 words. Over it, consolidate.

## Shape

```text
goal → broad local search (50–200 candidates) → Jev keep-probability per candidate → pack (~15 kept + dropped ids)
```

1. **Retrieve broadly.** A local MongoDB text index returns up to 200 candidates for the goal, ordered by text score then recency. Search favors recall; precision is Jev's job.
2. **Score.** Each candidate's egress view is sent to Jev (`typesafe/jev-1.13` through OpenRouter's decisions endpoint), which answers one typed question per candidate: the probability the record is needed for the goal. Jev estimates relevance; it does not rewrite, summarize, delete, or change policy.
3. **Pack.** Candidates are ranked by keep-probability, with search rank breaking ties, and the top 15 at or above the keep threshold (default 0.25) are kept. Every candidate that was not kept is listed by id and score so a reader can fetch it locally with `ask-history --show <id>`.

The pack reports the provider's input tokens, output tokens, and cost for every request, and marks usage unknown when a request fails before a usage response.

## Fail keep

A missing, non-numeric, out-of-range, or unavailable probability is treated as keep and labeled `unscored`. An HTTP error, timeout, or malformed body marks that batch unscored rather than failing the pack. Unscored candidates rank after scored keeps and before scored drops. Jev can shrink a pack; it can never make evidence disappear.

## Bounded requests

A request carries at most 16 candidates, 10,000 characters of candidate text, and 64 KiB of body. A pack makes at most 16 requests, runs them with bounded concurrency, and times each out. Candidates beyond the request limit are unscored. Source text is labeled as data and cannot change the retention question.

## Privacy

The egress mode decides what may leave the machine. The default is **metadata**:

- sessions: agent, surface kind, date, agent-authored label, tool names with counts, files touched;
- pull requests: number, title, description, state, dates, changed paths;
- decisions: the curated one-line summary of a memory event.

Raw conversation text, tool output, Slack root-message excerpts, and raw channel, thread, or message identifiers never leave in metadata mode. The egress view is built by an allowlist, not a denylist, and it is the only value the Jev client can serialize. A **full** mode that also sends bounded conversation excerpts exists only when the owner explicitly selects it per invocation; no configuration default can enable it.

Local search may use raw text because the index never leaves the host.

## Index

MongoDB is a rebuildable index under `generated/`, never a system of record. Ingest reads each agent's harness transcript store read-only, memory events, and a repository's pull-request history, and upserts one document per session window, pull request, or decision by stable id. Deleting the database and re-running ingest reproduces it. Each document records its source reference and the ingest time.

The instance installs and supervises the server, bound to loopback only. The OpenRouter key is read from the environment at invocation, injected by the instance secrets provider; it is never stored in the index, a pack, or a log.

## Command

```text
ask-history "<goal>"            pack, Jev-filtered
ask-history --search "<goal>"   search-only top 15, no egress
ask-history --compare "<goal>"  both, side by side, with usage
ask-history --show <id>         one local document
ask-history --ingest --days 14 --pr-repo <owner/name>
```

Output is JSON by default and a short text rendering with `--text`. `--egress full` is the per-invocation opt-in.

## Limits

Keep-probabilities are uncalibrated model estimates, not a correctness guarantee. In metadata mode a session is judged only by its agent, channel, label, tools, and files, so sessions whose relevance lives in conversation text score low and are dropped even when local search ranked them first. Jev filtering therefore suits goals answered by pull requests and recorded decisions better than personal-life goals.
