# Project repositories

The repository-local documentation contract for work products built with Humanware OS.

Budget: 1,000 words. Over it, consolidate.

## Ownership

A project repository must stand alone for a contributor who needs to understand why the product exists, how it behaves now, and which accepted choices govern its code. It owns distilled product intent: vision, current behavior, durable product decisions, architecture, operational guidance, and links to the pull requests that shaped each capability.

The data plane owns the source material and work around that intent: Slack transcripts, raw research, explorations, drafts, session records, screenshots, test and deployment evidence, private strategy, cross-project priorities, and provenance. Acceptance promotes a concise repository document; it does not copy the evidence into Git. The data plane may record the repository path and commit that received a decision.

Each fact has one editable canonical home. A product theme states current truth rather than reproducing a transcript or maintaining a parallel historical narrative. Git and linked pull requests preserve change history.

## Standard shape

```text
project/
├── README.md                    setup, development, and deployment entry point
├── VISION.md                    purpose, users, principles, and non-goals
└── docs/
    ├── README.md                documentation index
    ├── architecture.html        current architecture diagram; no duplicate exports
    └── product-themes/
        ├── README.md            theme index
        ├── capability.md        one living capability specification
        └── ux-ui.md             cross-cutting usability and interface behavior
```

Add `docs/operations/` only when the repository needs operating guidance that does not fit its README. Do not create default `specs`, `contracts`, or `decisions` hierarchies. Fold useful content from superseded product documents into the owning theme and delete the old files after verifying the migration. A rare cross-cutting engineering authority may remain separate when merging it would make product themes less clear.

`templates/project-repo/` is the authored starter. An instance may require this standard for all of its work repositories and may narrow link destinations, such as an internal artifact domain, without copying this specification.

## Product themes

A product theme is the living specification for one coherent capability. It contains:

- the outcome and audience;
- current behavior, not an implementation diary;
- durable accepted decisions and rejected alternatives when useful;
- direct GitHub links to the merged pull requests that shaped it;
- unresolved product questions.

Every merged product-facing pull request belongs to at least one theme. A change may appear in more than one theme when it materially affects each. Cross-cutting accessibility, responsive behavior, interaction consistency, visual-system changes, and small usability improvements belong in `ux-ui.md`; feature-specific interface behavior stays with its capability and may also link from UX/UI when the effect is product-wide. Narrowly technical maintenance remains discoverable through Git and does not need a theme entry.

Themes are not release notes. Update `Current behavior` when reality changes and keep `Changes` to concise linked summaries. There is no fixed word limit for a theme; it should be only as detailed as needed to govern the product.

## Promotion and closeout

Exploration begins on the control surface and in a data-plane workspace. Once accepted, the relevant distilled intent moves into `VISION.md` or a product theme. Implementation pull requests update that document with the code. At closeout, reconcile current behavior and decisions and add the pull request's final GitHub link under `Changes`.

A backfill reconstructs current product truth, not every historical step: identify coherent themes, use existing specifications and merged pull requests as evidence, consolidate useful content, and remove superseded product documents. Validate repository links and the HTML architecture diagram before merge.
