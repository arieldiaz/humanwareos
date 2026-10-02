# Figure and slide style

The structure every deck, slide, and figure follows. The instance supplies the values; this file names the slots. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 450 words. Over it, consolidate rather than extend.

## Source of truth

A figure is HTML first. One shared stylesheet per deck implements the instance's token values; figures reference tokens only and never hardcode a colour, font, or size. Raster exports are labelled fallbacks rendered from the same HTML in both modes.

## Semantic tokens

Every token defines a light and a dark value, switched by `prefers-color-scheme` with no manual toggle. Dark values preserve hierarchy; they are not inversions.

| Token | Role |
|---|---|
| `--fig-canvas` | slide background |
| `--fig-surface` | node and panel fill |
| `--fig-ink` | primary text and strong strokes |
| `--fig-muted` | secondary text, captions, axes |
| `--fig-line` | connectors, rules, grid |
| `--fig-emphasis` | the single highlighted claim or answer |
| `--fig-accent-<name>` | one accent per named entity, such as a product |
| `--fig-font` | one loaded family for all text |

Accent tokens identify entities; they never carry rank or decoration. Text on an accent meets WCAG AA in both modes, or the accent is used only for strokes and markers.

## Type scale

Five steps, defined in the instance as sizes relative to a fixed slide canvas: headline, subhead, label, body, caption. A figure uses no other sizes. Labels follow the instance's case rule; tracking and all-caps are not hierarchy tools.

## Headline as takeaway

Each slide's headline states the conclusion a reader should keep, as a sentence, not a topic name. The figure proves the headline. Supporting copy is at most three short lines.

## Numbering and captions

- Sections are numbered `1.`, `2.`, … in reading order. Never use the section symbol (`§`) in headings, labels, captions or references.
- Figures are numbered by section: `Figure 5.1` is the first figure in section 5, `Figure 5.2` the second.
- Every figure carries a visible caption beginning `Figure S.N.` followed by one plain sentence.
- Numbers are natural, never zero-padded, and are renumbered whenever a section or figure is inserted.

## Slides

- Fixed canvas aspect (16:9 by default) that scales to its container without reflow.
- One idea per slide: headline, figure, caption, optional source line.
- Diagrams are inline SVG or HTML using the same tokens, so text stays selectable and both modes render from one file.
- A deck index links every figure by number.

## Verification

Before promotion, render every figure in light and dark, check contrast and text overflow, confirm numbering is contiguous, and promote the HTML through the instance artifact service. Where a destination embeds raster only, attach the fallback and link the live HTML beside it.
