# Orchestration

How a root agent turns a conversation into coordinated work. Layer 2 spec — see [agent-context-hierarchy.md](docs/agent-context-hierarchy.md).

Status: build steps 2 and 3 are implemented; the other steps are proposed.

Budget: 1,100 words. Over it, consolidate.

## Ownership

This spec owns who does a piece of work: deterministic code, a worker, or the root agent. [channel-runtime.md](docs/channel-runtime.md) owns execution profiles and the allowlist, [data-plane.md](docs/data-plane.md) owns the session ledger, [permission-model.md](docs/permission-model.md) owns authority, and [reply-shape.md](docs/reply-shape.md) owns what reaches the human. Orchestration grants no permission and selects no identity.

## The ladder

Every unit of work goes to the lowest rung that can do it correctly.

1. **Code.** Work that needs no judgment runs as a tested function or scheduled job with no model call: watching a pull request or CI, a scheduled check, ledger import, file housekeeping, a routine status read.
2. **Worker.** Bounded work that needs judgment but not the conversation runs in a child session on the cheapest allowed profile that can do it.
3. **Root.** The root agent keeps only what requires the conversation, the human's trust, or a review of someone else's result.

Work smaller than its own brief stays inline: one read, one lookup, one short edit.

## Root agents

A root agent is the identity leading a conversation. It plans, splits work into briefs, chooses a rung and profile for each, reviews every result against its verification, and reports to the human. A result becomes the root's claim only after the root has read the named evidence.

A root agent never delegates: a decision made with the human, a commitment made on the human's behalf, anything sent outside the system, a memory or rule promotion, a merge, or a production change. Workers prepare these; the root, under the human's authority, performs them.

Delegated work that outlives the run receives the durable scheduled check the framework rules already require. That check is rung-one code.

## Workers

A worker is a child session with no identity, no channel, and no standing authority. It receives one brief and returns one result.

The brief states the objective, the smallest context the task needs, the write scope, the data scope, the verification that proves the work, and the profile. A worker does not load strategy or memory projections unless the brief names them.

The result states the output, the actions taken, the verification performed and its outcome, anything left open, and any observation the worker thinks is a durable fact. That last item is a proposal only: the root decides whether it enters the normal memory path.

A worker may not post to a channel, send anything outside the system, write memory, act outside its write scope, or spawn a session on its own. Its scratch lives in the task workspace and is deleted once its output is promoted.

### Nested workers

Depth is one level by default. A worker that needs help returns a delegation request naming the sub-task, its brief, and its profile. The root approves or denies it and spawns an approved child itself. The human deals only with the root; the ledger keeps the whole tree.

## Routing

The root may select any enabled profile in the instance allowlist for a worker; no worker model is fixed per identity. Selection runs in this order:

1. **Data scope.** Exclude every profile whose harness or provider is outside the task's privacy tier. An external harness never receives data its profile does not cover, however cheap it is.
2. **Capability.** Choose the least capable class that can do the task: retrieval and summarization, routine implementation and research, or hard design and review.
3. **Cost.** Within that class, choose the cheapest profile.

If a result fails verification, the root may retry once on the next class up, then takes the task itself or reports the blocker. Root conversations run on the instance's most capable profiles at high reasoning; the interactive response target in the channel spec does not apply to them.

## Ledger

Every spawned run is recorded in the session ledger by the adapter that observed it, never self-reported by the worker. The event schema gains:

- `run.spawned`: child run and session identifiers, parent run, root session, brief reference, profile, model, reasoning level, data scope, and write scope.
- `run.completed`: outcome, result reference, verification outcome, duration, token usage, and cost.
- `delegation.requested` and `delegation.decided`: the requesting worker, the proposed brief, the deciding root run, and the decision.

A child's tool, write, model, and cost events carry its run identifier and so attach to the tree. Cost rolls up from leaf to root session by summation over observed events; a missing cost stays unavailable, never estimated. Provider-visible reasoning summaries are recorded where the provider exposes them, under the existing trace-level rule.

A harness transcript is a resumption cache, not a record. Once a session's events are imported into the ledger and the import is verified, its harness transcript is retained for the instance's configured window, seven days by reference, then pruned by code.

## Summaries

Both human-facing summaries are projections generated from the ledger by code, not written from a model's recollection.

- **Conversation summary.** Posted with a final that asks for a decision, reports a blocker, or completes the objective: objective, state, decisions made, worker runs as a count with total cost, what is open, and the next move. It links to the session page rather than repeating it.
- **Session page.** The permanent view on the private domain: the full run tree, and for each run its brief, profile, actions, reasoning summaries, files, pull requests, verification, and cost.

## Promotion to code

When workers have performed the same procedure three times, the root proposes a rung-one function for it through normal review. The ledger's run history is the evidence for the proposal.

## Outside assistants

Quick-answer assistants outside the system stay outside. A later slice may export a privacy-filtered briefing to them and capture their conversations into the evidence inbox. They never receive live memory access.

## Build order

1. Ledger events, adapter capture, and the run tree on the session page.
2. Worker brief and result contract, with the worker restrictions enforced by tool policy rather than instruction.
3. Root and worker profile defaults in instance configuration, applied to new conversations only.
4. Generated conversation summary and cost roll-up.
5. Transcript retention job.
6. First rung-one functions: pull-request and CI watching, and the scheduled check.

Each step ships with tests. Step 3 is the switch-over and waits for steps 1 and 2 to be proven on real runs.
