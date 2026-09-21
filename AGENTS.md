# Operating rules for agents in this repo

Humanware OS is the operating system for the human side of AI. These rules override agent defaults.

This file is Layer 1: the small set of rules every agent needs everywhere. Details live once in the owning Layer 2 specification. Harness-specific filenames are generated projections, never additional authored instructions.

## Root principle

**Use the simplest sufficient system.** Prefer removing, merging, or moving a behavior to its natural owner over adding another instruction, validator, state, exception, or compatibility path. One behavior has one authoritative source. Deterministic mechanics belong in code; reusable policy belongs in one specification; skills are optional procedures; identities contain only role, judgment, and voice. Repetition is drift, not reinforcement.

## Authority and ownership

There are three authored source classes and one generated output:

- **Framework:** reusable rules, specifications, identity templates, skills, and software in Humanware OS.
- **Instance:** private configuration, approved narrowings, identities, routes, and secret references.
- **Data plane:** evidence, memory, strategy, sessions, work, artifacts, media, logs, and caches under `$HUMANWARE_DATA_ROOT`.
- **Runtime:** an immutable generated assembly of framework plus instance. Never edit it as source.

Agent context has four layers, in descending authority:

1. this file;
2. the owning `docs/*.md` specification;
3. `agents/<name>.md` plus its private instance overlay;
4. current memory and strategy projections.

A lower layer may narrow a declared extension point but may not contradict or restate a higher layer. When instructions conflict, follow the higher layer and remove the lower defect at its source.

Memory stores facts, decisions, and project state, never behavioral rules. Apply first-time feedback in the active conversation. If a behavior should recur, propose a replacement at the owning framework or instance source and wait for approval. Edit an existing rule in place; do not append a correction beside it. Rationale belongs in Git history. Every Layer 2 spec declares a word budget, and an over-budget edit triggers consolidation.

## Owning specifications

- `docs/agent-context-hierarchy.md` — authority, skills, identity, and generated context.
- `docs/status-framework.md` — the four lifecycle states and root status tile.
- `docs/reply-shape.md` — the one response envelope for every identity and harness.
- `docs/slack-style.md` — Slack rendering and channel behavior.
- `docs/channel-runtime.md` — channels, execution profiles, dispatch, and delivery.
- `docs/permission-model.md` — capabilities, authority, and approvals.
- `docs/coding-sessions.md` — isolated source work and durable closeout.
- `docs/system-boundaries.md` and `docs/data-plane.md` — placement, provenance, and durability.
- `docs/runtime.md` — immutable builds, activation, rollback, and restart safety.
- `docs/design-agent.md` — visual and interface work.
- `docs/domain-surface.md` — public and private domain surfaces.

Instance facts belong in `AGENTS-instance.md` and `docs/*-instance.md`. Those files may narrow declared choices but may not copy generic rules.

## Operating rules

1. **Orient from current context.** Before non-trivial work, read the instance's current strategy and the smallest relevant current-memory projection. If the data root is unavailable, say so; do not substitute stale repository files.
2. **Act when authorized.** Complete reversible, in-scope work with available tools. Ask only for a decision, credential, identity-bound action, or meaningful expansion of scope that the human must supply.
3. **Tell the truth about state.** Never claim an action, write, delivery, or verification without evidence. Before declaring a capability unavailable, verify the actual tool name, path, and state. Report the precise failure when one remains.
4. **Verify in proportion to risk.** Irreversible, public, financial, relational, security, and production changes need strong evidence. Low-risk reversible work needs a sanity check, not ceremony. Write tests where they protect behavior likely to regress.
5. **Use the owning layer.** Fix reusable behavior in framework source, instance policy in private configuration, facts and work in the data plane, and generated behavior by rebuilding the runtime. A local workaround may contain an incident but does not close it.
6. **Protect evidence and privacy.** The stream and memory evidence are append-only; corrections are new events. Tier 0 raw evidence stays on the trusted local network unless the human approves a bounded item for a named execution profile. Tier 1 generated material is local by default. Tier 2 current context is limited to approved identities and tasks. Public artifacts contain only published revisions.
7. **Keep data out of source.** Never commit or temporarily copy sessions, memory, working documents, artifacts, media, runtime state, caches, or personal data into framework or instance repositories. Source may reference stable data identifiers and schemas.
8. **Keep secrets in the instance secret manager.** Refer to secret keys by name only. Never place a secret value in source, instructions, memory, logs, commits, tasks, or replies. If one leaks, stop, flag it for rotation, scrub it, then continue.
9. **Share repositories safely.** Assume other sessions are active. Re-read a file immediately before editing it. Multi-file or durable source changes use a task-owned branch and isolated worktree from the current remote tip. Do not restructure or mass-edit without the human's explicit approval.
10. **Use primary artifacts.** Answer from the human's source before an agent summary. If the primary source is unavailable or outside the active privacy scope, name the secondary source used.
11. **Keep interaction light.** Lead with the result. Use plain prose and only the structure that helps. Ask one inline question when blocked. Internal reasoning, routing, transport, and progress telemetry do not belong in the final response.
12. **Use durable triggers.** An agent-authored message cannot wake its author. Work opened in another thread must finish in the same run or receive a durable scheduled wake before the run ends.
13. **Treat expected absence as data.** For probes where an empty state is normal, use structured output or normalize only the documented empty-state exit. Never use broad error suppression that hides real failures.
14. **Change production schemas through reviewed migrations and CI.** Reconcile the production ledger read-only before applying or baselining. Migration authority does not grant broad production administration.
15. **Read the design contract before visual work.** Follow `docs/design-agent.md` and its named instance overlay; do not infer a design system from old artifacts.

## Repository writing conventions

- Markdown links are standard links, never wikilinks. Repository links are relative to the repository root.
- Markdown source is soft-wrapped: one paragraph per line.
- Text meant for the human to copy goes in a fenced block.
- Terminal command blocks contain commands only. Explain prompts and substitutions in prose above them.
- Operational paths in chat are absolute and include the machine username.

## Placement

| Material | Owner |
|---|---|
| Raw input or immutable event | `$HUMANWARE_DATA_ROOT/evidence/` |
| Current memory or strategy | `$HUMANWARE_DATA_ROOT/current/` |
| Mutable project or conversation work | `$HUMANWARE_DATA_ROOT/working/` |
| Published or reviewable revision | `$HUMANWARE_DATA_ROOT/artifacts/` |
| Rebuildable transcript, report, index, or render | `$HUMANWARE_DATA_ROOT/generated/` |
| Reusable behavior or software | Humanware OS through review |
| Private configuration or narrowing | the private instance through review |
| Secret value | the instance secret manager |
