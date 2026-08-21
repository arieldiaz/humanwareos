# Agent context hierarchy

This specification defines which context can direct an agent, which context can only inform it, and where each source lives after framework, instance, data, and runtime are separated.

Budget: 1,500 words. Over it, consolidate.

## Authority stack

An agent receives four ordered layers. A lower layer may narrow a higher one only at a declared extension point. It may never contradict it.

### Layer 1 — framework rules

`AGENTS.md` is the constitution shared by every Humanware OS installation. It defines hard safety, ownership, verification, privacy, and working-process boundaries. Agents may propose a diff; only reviewed framework changes alter it.

### Layer 2 — framework domain specifications

Each `docs/*.md` file owns one reusable subject, such as replies, permissions, channels, data, runtime, or domain surfaces. Layer 1 points to the owning specification and does not restate it.

### Layer 3 — identity template plus instance overlay

Humanware OS supplies durable identity templates such as Liv and Max. The private instance may add a person's chosen name, voice preference, memory scope, channel account, and narrower authority. An overlay cannot restate or weaken framework rules.

Harness, model, reasoning, permissions, and working directory are execution-profile fields. They are not identity facts.

### Layer 4 — current memory and strategy projections

The data plane supplies concise non-normative context: current strategy, active facts, decisions, project state, and references to evidence. Memory can inform judgment but cannot establish a rule. Contradictory memory is stale data to correct, never a policy tiebreaker.

Task instructions and the live conversation sit nearest the active work but remain beneath this authority stack.

## Three source classes

Every loaded file comes from exactly one source class:

- **Framework source:** reusable rules, specs, templates, and code.
- **Instance source:** private configuration, approved policy narrowings, identifiers, and route selections.
- **Data source:** evidence, memory, strategy, sessions, work, and artifacts.

The generated runtime assembles references and rendered copies from those sources. A harness-required filename points into the runtime bundle; it is not another authored copy.

## Why memory leaves Git

Memory and source code have different write models. Code and policy need review, coherent diffs, and deployment. Memory needs frequent fact capture, provenance, correction, compaction, selective access, and retention. Combining them makes ordinary learning dirty the software checkout and tempts unreviewed facts to become rules.

Memory evidence is append-only under `$HUMANWARE_DATA_ROOT/memory/events/`. Current memory is a mutable projection under `memory/current/`. A projection may merge or supersede facts because the evidence remains available. Harness-native memory stores are rebuildable caches over that projection.

## Rule promotion

An observation never silently becomes a rule.

1. Apply one-off feedback to the active task.
2. Record relevant evidence or a personal fact in the data plane.
3. If the behavior should recur, propose a diff at the owning source layer.
4. Reusable behavior changes Humanware OS through review.
5. Private approved behavior changes the instance through review.
6. Rebuild the runtime after merge; do not patch a generated prompt.

Spec edits replace existing text rather than appending a contradictory version. Git history carries rationale; active specs state current truth.

## Runtime assembly

The runtime builder receives a framework revision, instance revision, and data-root reference. It produces an immutable context bundle such as:

```text
runtime/<build-id>/
├── manifest.json
├── instructions/
│   ├── AGENTS.md
│   ├── specs/
│   └── agents/
├── config/
│   ├── instance.json
│   ├── runtime-profiles.json
│   ├── channel-adapters.json
│   └── domain-routes.json
└── adapters/
```

The runtime references current memory and strategy through the data service or instance-declared paths. It does not copy personal data into the build. Service definitions point at the stable `runtime/current` bundle; when a harness rejects instruction symlinks, the adapter materializes verified regular-file projections from that bundle and checks them for drift.

## Harness independence

OpenClaw, Pi, Cursor, Codex, and future harnesses read the same assembled identity and context contract. A harness may maintain its own session transcript or index, but that state is not authoritative. Switching harnesses creates a structured handoff and continues under the same identity, instance policy, and data scopes.

Permanent harness-specific instructions belong in a framework adapter or instance execution profile. They do not belong in a persona file or memory.

## Conflict handling

When context disagrees:

1. Identify the source class and authority layer of each statement.
2. Follow the higher authority for the active task.
3. Treat lower contradictory policy as a defect and propose removal at its source.
4. Treat lower contradictory facts as a memory correction event and rebuild the projection.
5. Rebuild and verify the runtime; do not reconcile generated files by hand.

The goal is not to make agents interpret more prose consistently. It is to ensure there is only one authored owner for each kind of truth.
