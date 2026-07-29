# Design agent files — DIFF spec

What an agent must read before doing visual work, what those files currently
contradict, and what has to change. Draft — nothing here is applied. Layer 2
spec — see `docs/agent-context-hierarchy.md`.

Budget: 200 lines. Over it, consolidate — do not extend.

## Why this exists

Design instruction for agents is spread across four files in two repos with no
stated precedence between them. Two of them restate the same rule in full, one
is a site implementation guide being read as a brand guide, and the largest one
is four different documents wearing one title. The result is that an agent
picking up a design task cannot tell which file wins, so it reads all of them,
burns context, and still produces work that has to be corrected in the thread.

The corrections that triggered this are all the same shape: a rule existed, in
a file, and the agent did not apply it — banned treatments reappearing, light
mode shipping unreadable, mood-board framing on a utilitarian internal tool.
That is a findability failure, not a comprehension failure.

## The current files

| File | Repo | Lines | What it actually is |
|---|---|---|---|
| `apps/design-hq/DESIGN-BIBLE.md` | ariel-os | 250 | Four documents: authority hierarchy, global rules, Ariel Works product strategy, and a conflicts/roadmap log |
| `docs/design-preferences.md` | ariel-os | 47 | Standing visual preferences; duplicates the photography rule in full |
| `DESIGN.md` | arieldiazcom | 200 | Site implementation — palette, type, components, voice |
| `apps/design-hq/README.md` | ariel-os | 28 | How Design HQ exercises are structured |

Per-version `BRIEF.md` files are exercise records, not instruction, and are
correctly scoped. They are out of scope here except where they invent statuses.

## The diffs

### 1. The photography rule is written twice, in full

`DESIGN-BIBLE.md` §10 and `design-preferences.md` § "Photography in Ariel Works
visuals" both state the no-synthesis rule, the provenance gate, and the
placeholder fallback. They currently agree, which is the dangerous state — one
will be edited and the other will not.

**Change:** the rule lives in `DESIGN-BIBLE.md` §10 only.
`design-preferences.md` links to it and states nothing.

### 2. DESIGN-BIBLE is four documents

Authority hierarchy, global rules, Ariel Works product strategy, and a
"current layers and conflicts" log are unrelated subjects with different
lifespans. The product strategy section — language-minimal interfaces,
serif/sans as a semantic boundary — is a product rule that has no business
constraining an identity exploration. The conflicts log is a worklog that will
be stale within weeks and is already partly resolved.

**Change:** split into `design-foundation.md` (hierarchy + global rules,
short and stable), `works-product-design.md` (the product-surface rules), and
move the conflicts log out of the spec entirely. The bible's own
"Recommended target hierarchy" section proposes almost exactly this and has
never been executed — it is a spec describing the refactor of itself.

### 3. Nothing states what an agent reads before starting

There is no entry point. An agent handed a design task discovers the files by
grepping, which is why the same rules keep getting missed. The read order is
also not obvious: `design-preferences.md` sounds authoritative and is the
thinnest file; `DESIGN-BIBLE.md` sounds foundational and is half worklog.

**Change:** `design-foundation.md` opens with the read order and a one-line
statement of what each downstream file owns. That block is the only thing an
agent must load for a small task.

### 4. Rejected directions are not written down anywhere

Field notebook, angled and rotated paper, tilted cards, scrapbook treatments,
faux-skeuomorphic decoration, diagonal identity splits, framework-default
colors — some of these are in the bible, some exist only in Slack threads.
An agent that did not read that thread will reproduce them, and has.

**Change:** one explicit rejected-directions list in `design-foundation.md`,
each entry one line, no rationale beyond a clause. It is a checklist, not an
essay.

### 5. Light/dark is mandated but never verified

The bible says every surface ships both modes and that reviews include both.
Round 02 of the arieldiaz.com exploration shipped unreadable light-mode text
anyway, because inherited color from the page shell was never scoped. The rule
exists; the failure mode is not named.

**Change:** the rule gains one operative sentence — scope color explicitly on
every element, never inherit from the shell — and exercise boards must show
both modes as a visible pair rather than relying on `prefers-color-scheme`.

### 6. Audience and register are unstated

Internal tools — Design HQ, dashboards, status pages — are for Ariel alone and
should be utilitarian: minimal headers, dense information, no presentation
framing. Exploration boards are also for Ariel, but are allowed to be
expressive because the visual system is the subject. Nothing distinguishes
these, so agents default to presentation register everywhere and produce mood
boards for tools.

**Change:** name three registers — internal tool, exploration board, public
surface — and state the default for each. This is the rule that was missing
when the Design HQ index shipped with a serif masthead and pill tags.

### 7. Design HQ conventions live in the wrong file

`README.md` describes exercise structure, but the rules that actually govern
exercises — exploration is not approval, record created/updated dates, label
model and harness provenance, preserve failures and dissent — are in the
bible's global rules. An agent building a board reads the README and misses
them.

**Change:** exercise rules move to the README; the foundation keeps the
one-line principle and links.

## What this does not change

The rules themselves are sound and are not up for revision here. This is a
consolidation and findability pass: same rules, one home each, discoverable in
order. Any rule that turns out to be genuinely contested gets raised
separately rather than quietly rewritten during the move.

## Open questions

1. Does `arieldiazcom/DESIGN.md` become a surface recipe under the foundation,
   or stay an independent implementation guide in its own repo? It is
   currently duplicated at two paths, which the bible itself flags.
2. Do these files genericize upstream into Humanware OS, or stay instance-specific
   in ariel-os? The register rule and the exercise conventions look generic;
   the palette and the AD gesture do not.
