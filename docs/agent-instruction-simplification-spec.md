# Agent instruction simplification

Implementation spec. Budget: 900 words.

## Problem

Humanware OS has one declared instruction hierarchy but more than one effective instruction system. Framework rules, domain specs, skills, identity templates, generated context, and agent-local workspace skills repeat behavior with different wording. Max currently has eleven discoverable workspace skills while Liv has none. The local Slack skills redefine thread creation, closure, model routing, and lifecycle behavior already owned by the control plane. This makes the more-instructed agent less predictable and caused a real status failure when a spinout procedure bypassed the lifecycle contract.

Repeated prose is not stronger policy. Models weigh recency, specificity, imperative language, and local context even when the written hierarchy calls rules peers. Later duplicate instructions therefore behave like accidental priority. More validators and rejection paths would add another competing layer while preserving the underlying ambiguity.

## Decision

Humanware OS will use the simplest sufficient instruction architecture:

1. `AGENTS.md` holds only global boundaries and names each owning specification once.
2. A domain rule appears in one Layer 2 spec. Identity files contain only role, jurisdiction, judgment, and voice.
3. Skills are optional task procedures. They may sequence work and define a result, but may not establish global policy, channel reply shape, lifecycle state, execution profile, or identity behavior.
4. Every agent workspace receives the same canonical skill directory from the immutable runtime. Pre-existing workspace skills are backed up during cutover and cease to be discoverable.
5. The lifecycle has four states: `working` (on agent), `act` (on human), `scheduled`, and `done`. A question is content inside the on-human state, not a fifth phase. An ordinary final result is done.
6. Models write standard Markdown. Surface adapters own deterministic rendering differences. In Slack, Markdown pipe tables become aligned preformatted text instead of requiring a model-only exception.

## Consolidation

The core loop skills remain because each names a distinct procedure: observe, orient, decide, act, review, compound, and rederive. Their repeated philosophy, rationalization tables, mandatory handoffs, and copies of global rules are removed. Challenge remains available when explicitly useful but is no longer an automatic gate. Google Workspace remains a narrow capability skill.

Liv and Max keep different domains and judgment. Their templates lose skill menus, session-opening rituals, response formats, recurring review mandates, and duplicate counterweight mechanics. The yin-and-yang note remains explanatory, not executable policy.

The runtime materializer projects canonical skills beside the existing generated context files. This makes the correct path automatic for both identities and removes the need for drift rules aimed at agents.

## Acceptance

- Total words across `AGENTS.md`, `agents/*.md`, and core skills decrease materially from the pre-change baseline.
- Liv and Max materialize identical canonical skill names and no agent-local skill survives at `workspace/skills` after cutover.
- Generated identity context contains identity only; reply and status behavior come from their single owning specs.
- Status normalization and root reactions use exactly `working`, `act`, `scheduled`, and `done`.
- Plain final replies resolve to `done`; a blocking question and identity-bound action both resolve to `act`.
- Markdown tables render legibly in Slack without a special model instruction.
- Deterministic tests pass, behavioral evals run for both Liv and Max, and the live Slack matrix verifies admission and terminal tiles after one supervised cutover.

## Cutover

Merge this framework PR, pin its exact merge revision in the private instance, build one immutable runtime, and use the existing supervised restart path. The workspace materializer backs up displaced local skills with the rest of the cutover state, so rollback restores them. After activation, verify both workspaces, run the four-state Slack matrix for Liv and Max, inspect reply shape and table rendering, and record the results in the data plane.
