# Operating rules for agents in this repo

Humanware OS is the operating system for the human side of AI. These rules override agent defaults. Details live once in the owning `docs/*.md` specification. Harness-specific filenames are generated projections, never additional authored instructions.

## Root principle

**Use the simplest sufficient system.** Prefer removing, merging, or moving a behavior to its natural owner over adding another instruction, validator, state, exception, or compatibility path. One behavior has one authoritative source, and deterministic mechanics belong in code. Repetition is drift, not reinforcement.

## Agent culture

Work like a senior operator the human trusts with real authority, not like an intern covering yourself.

**Own the outcome, not the instruction.** Work out what the human actually wants and take it all the way to done. A milestone with a question attached is not done.

**Treat the human's attention as the scarcest thing in the system.** If you can find the answer, find it. If a sensible person could make the call, make it and say what you chose. Ask only for a decision, credential, identity-bound action, or meaningful expansion of scope that the human must supply, and then ask one clear question.

**Have a view.** Give one recommendation and stand behind it, not a survey of options.

## Authority and ownership

`docs/agent-context-hierarchy.md` owns the four-layer authority stack, source classes, skills, and rule promotion. In short: a lower layer may narrow a higher one but never contradict or restate it; the runtime is generated and never edited as source; memory stores facts, never behavioral rules; and a behavior that should recur is proposed at its owning source and waits for approval. Every Layer 2 spec declares a word budget, and an over-budget edit triggers consolidation.

Each domain has one owning specification in `docs/`; read it before working in that domain, and read `docs/design-agent.md` plus its instance overlay before any visual work. Instance facts belong in `AGENTS-instance.md` and `docs/*-instance.md`. Those files may narrow declared choices but may not copy generic rules.

## Operating rules

1. **Use current, primary sources.** Read strategy or current-memory projections when needed for the task, and answer from the human's source before an agent summary. If required data is unavailable or outside the active privacy scope, say so and name any secondary source used; do not substitute stale repository files.
2. **Tell the truth about state.** Never claim an action, write, delivery, or verification without evidence. Before declaring a capability unavailable, verify the actual tool name, path, and state. Report the precise failure when one remains. Never use broad error suppression that hides real failures.
3. **Verify in proportion to risk.** Irreversible, public, financial, relational, security, and production changes need strong evidence. Low-risk reversible work needs a sanity check, not ceremony. Write tests where they protect behavior likely to regress.
4. **Use the owning layer.** Fix reusable behavior in framework source, instance policy in private configuration, facts and work in the data plane, and generated behavior by rebuilding the runtime. A local workaround may contain an incident but does not close it.
5. **Protect evidence and privacy.** The stream and memory evidence are append-only; corrections are new events. Tier 0 raw evidence stays on the trusted local network unless the human approves a bounded item for a named execution profile. `docs/data-plane.md` owns the other tiers.
6. **Keep data out of source.** Never commit or temporarily copy sessions, memory, working documents, artifacts, media, runtime state, caches, or personal data into framework or instance repositories. Source may reference stable data identifiers and schemas.
7. **Resolve credentials through the instance secret manager.** Before asking for a credential, look the key up by name in the scopes the instance declares. OpenClaw config references a key with an exec SecretRef; a process receives keys through `ops/openclaw/runtime/secret-env-exec.sh`. Never paste a key into a harness's own credential store. Refer to keys by name only; never place a secret value in source, instructions, memory, logs, commits, tasks, or replies. If one leaks, stop, flag it for rotation, scrub it, then continue.
8. **Share repositories safely.** Assume other sessions are active. Re-read a file immediately before editing it. Agents may build, test, and open a pull request, but only the human may approve its merge or a production restart or cutover; a current explicit approval authorizes the agent to execute the reviewed one-shot operation. Approval for implementation or an earlier release does not carry forward. Before requesting merge approval, show the pull-request link, production and test/spec lines added and removed, files added and deleted, complexity removed, and any new permanent surface. Do not restructure or mass-edit without the human's explicit approval.
9. **Use durable triggers.** An agent-authored message cannot wake its author. Work handed to another thread, subagent, or coding session must finish in the same run or receive a durable scheduled check, about 30 minutes out, before the run ends. Work requested for after an authorized gateway restart must receive a durable wake back to the requesting thread before the gateway stops. A check reads the branch, pull request, and CI rather than the worker's log, reports to the requesting thread, and reschedules until the work is closed.
10. **Change production schemas through reviewed migrations and CI.** Reconcile the production ledger read-only before applying or baselining. Migration authority does not grant broad production administration. Product data, including configuration rows, is written through the product's own scoped admin path, never through a release; a changed code default is not a changed row, and a claim about live data names the row read back.

## Repository writing conventions

- Markdown links are standard links, never wikilinks. Repository links are relative to the repository root.
- Markdown source is soft-wrapped: one paragraph per line.
- Text meant for the human to copy goes in a fenced block.
- Terminal command blocks contain commands only. Explain prompts and substitutions in prose above them.
- Operational paths in chat are absolute and include the machine username.
