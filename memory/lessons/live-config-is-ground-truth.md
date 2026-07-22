# Live config is ground truth, not its source

**A source-of-truth file describes intent; the materialized runtime describes reality. When a live config can be edited out from under its source with no reconciliation step, only the resolved running value is ground truth — diagnose from it, and after any fix write *both* layers and diff them.**

Evidence (ariel-os instance, 2026-07-21): a metered LLM API key was still being billed when every agent was supposed to ride a flat-rate subscription. The source patch files declared the subscription runtime for all agents, so the first-pass answer — read from source — was "we're clean." Wrong: the live runtime config had drifted so that the default model, an alias, and *every* agent's primary all resolved to the metered provider. The divergence produced no error and there was no apply step that would have caught it. Only dumping each agent's resolved primary from the live config surfaced it. The fix touched both the live config and the source, then diffed them, then restarted the daemon so the change actually loaded.

Do differently, concretely:

- To answer "what is actually running," read the resolved live config, never the source. A source file is apply-time *intent*; a hand edit, a UI toggle, or an interrupted apply can leave live ≠ source silently.
- Treat a source layer and its materialized runtime as two facts to reconcile, not one. A fix that only edits the source hasn't changed what's serving; write both and diff.
- Distrust the comfortable read. The reassuring source ("it says the right thing") is the check that can lie; the resolved effective value is the check that can't. Comfort is the cue to dump ground truth.
- Structural: a "source of truth" that isn't the artifact actually loaded is only a source of *intent*. Either make apply idempotent and enforced (runtime rebuilt from source on every boot) or add a drift check that fails loudly — until one of those exists, the live artifact wins every argument.

Sibling to the handoff-verification family: verify in the path that serves production, not a fresh process; documented decays into assumed-known; and here, *declared* decays into *assumed-effective*.
