# Design agent files — DIFF spec

What an agent must read before doing visual work, what those files currently
contradict, and how to make the instruction layer smaller and harder to miss.
Draft only: this document proposes changes; it does not apply them.

Budget: 200 lines. Over it, consolidate rather than extend.

## Problem

Design instruction is distributed across foundation, preference,
implementation, and exercise files without a single entry point. Agents read
different subsets, mistake implementation choices for identity rules, and
produce visually elaborate review artifacts when Ariel needs a fast decision
surface.

The recurring corrections are not failures of taste. They are failures of
instruction architecture:

- a standing rule existed but was not in the agent's required read path;
- the same rule existed in multiple files with no declared authority;
- an internal review tool inherited the register of a public presentation;
- an exploration board appeared to imply approval;
- a visual deliverable was shown at a scale that hid the actual differences.

## Current instruction surfaces

| File | Owner | Actual role |
|---|---|---|
| `apps/design-hq/DESIGN-BIBLE.md` | instance | Foundation, product rules, and a stale conflicts log combined |
| `docs/design-preferences.md` | instance | Personal standing preferences, with duplicated policy |
| `DESIGN.md` | public-site repo | ArielDiaz.com implementation guide |
| `apps/design-hq/README.md` | instance | Exercise and archive conventions |
| Per-version `BRIEF.md` | exercise | Scope, provenance, and evidence for one iteration |

Per-version briefs are records, not durable instruction. A decision discovered
inside one must either remain local to that exercise or be deliberately
promoted into the appropriate standing file.

## Required diffs

### 1. Establish one entry point

Create a short `design-foundation.md` as the first required read for visual
work. Its first screen declares authority and routes the agent:

1. foundation for universal rules;
2. preferences for the human's standing taste;
3. a surface recipe for the thing being designed;
4. Design HQ conventions only when producing an exercise;
5. the current brief for local scope.

Small tasks should not require loading the entire design archive.

### 2. Give each rule one home

Move universal rules into the foundation and replace duplicate restatements
with links. In particular, photography provenance and the no-synthetic-photo
rule must have one canonical statement.

Split Ariel Works product-interface rules out of the identity foundation.
Language-minimal interaction and serif/sans tool-versus-artifact semantics are
product rules; they must not constrain an identity exploration by accident.

Move the current-layers/conflicts section into a dated worklog or delete it
once resolved. A stable spec must not carry a stale roadmap.

### 3. Name the three design registers

Every request resolves to one register before visual work starts:

- **Internal review tool:** utilitarian, dense, minimal header, minimal
  narration, no decorative framing. The audience is Ariel. This is the
  default for Design HQ and dashboards.
- **Exploration board:** comparative and expressive only to the degree needed
  to expose differences. It may show materials and atmosphere, but it is not a
  mood board unless Ariel asks for one.
- **Public surface:** audience-led, fully composed, accessible, responsive,
  and governed by its surface recipe.

If the request does not name a register, use the surface's default. Never
promote an internal review artifact into presentation register for polish.

### 4. Make differentiation the review objective

Design review artifacts exist to reveal decisions, not to demonstrate that an
agent can art-direct a board.

- Put the most differentiated region of each option in the preview.
- Default archive thumbnails to a zoom level that reveals the page body, not
  just repeated headers.
- Keep option labels outside device or page frames.
- Show comparable options at the same viewport and scale.
- Put all requested comparisons in one scan when practical; do not hide them
  behind tabs.
- Keep headers inside exercises minimal unless the header itself is under
  review.
- Do not add manifesto copy, materials taxonomies, or mood-board framing unless
  the request calls for them.

### 5. Record rejected defaults

The foundation owns a short list of treatments agents must not reintroduce
without an explicit request:

- field-notebook and scrapbook staging;
- angled paper, rotated cards, and decorative object scattering;
- faux handmade or irregular geometry when actual construction is requested;
- light-only or dark-only digital work;
- framework-default gradients and color;
- synthetic or generatively altered photography;
- title-heavy review boards and ornamental archive chrome.

This list is a guardrail, not a permanent ban on a direction Ariel may later
request.

### 6. Turn light/dark into an acceptance check

Every digital proposal shows both themes visibly. Do not rely on
`prefers-color-scheme` as review evidence. Text, SVG, raster marks, borders,
focus states, and overlays must each declare or inherit a tested semantic
color. A screenshot pair is part of the deliverable.

### 7. Keep exploration and approval separate

Design HQ preserves parallel iterations. It does not invent locks, winners,
statuses, or approval. Every exercise records:

- date and iteration;
- the requested and actual model/harness when relevant;
- source assets and provenance;
- what changed from the prior iteration;
- known failures and dissent.

The archive itself uses small clickable previews labeled only with date and
iteration. Exercise titles and tags may exist in metadata, but should not
dominate the review surface.

## Agent preflight

Before rendering, the agent should be able to answer in one sentence each:

1. What register is this?
2. What decision should the artifact make easy?
3. Which standing rules apply?
4. Which prior work is reference rather than authority?
5. What evidence will prove light/dark, responsive, and comparison quality?

If those answers are unclear, the agent clarifies scope before producing a
large visual artifact.

## Acceptance test for the refactor

The instruction refactor is successful when a clean agent can receive a visual
task and, without searching old Slack threads:

- name the correct instruction order;
- distinguish foundation, preference, surface recipe, and exercise brief;
- choose the correct register;
- avoid the rejected defaults;
- produce a comparison at a useful review scale;
- show both color modes;
- label exploration without implying approval;
- cite source assets and model provenance.

## Boundary

The instruction architecture and the three-register model are candidates for
Life OS. Ariel's gesture, palette, photography policy details, and rejected
directions remain instance-specific examples. Upstream should provide the
slots and routing contract, not encode one person's taste as a universal
design system.
