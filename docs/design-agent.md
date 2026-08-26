# Design agent

The routing contract for visual and interface work. Instance taste, identity, palette, and assets live elsewhere. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 500 words. Over it, consolidate rather than extend.

## Required read order

1. Read this file.
2. Read the instance's sibling `docs/design-agent-instance.md`, when present.
3. Use the overlay's scope map to load only the foundation, preferences, surface recipe, conventions, and current brief that govern the task.
4. Treat prior artifacts as reference evidence unless a named authority file promotes them into a rule.

An instance may symlink this file into its own `docs/` directory. Its sibling overlay adds paths and local rules without restating this contract.

Authority is scoped: the foundation constrains every task; narrower rules govern only their named work and may extend but not contradict it.

## Resolve the register first

Every design task uses one of three registers:

- **Internal review tool:** dense and minimally framed for one informed operator. Default for archives, dashboards, and review indexes.
- **Exploration board:** comparative evidence that makes meaningful differences scannable, not a mood board unless requested.
- **Public surface:** audience-led, accessible, responsive, and governed by its surface recipe.

Do not elevate an internal tool into presentation register for polish. Do not add manifesto copy, decorative staging, material taxonomies, or mood-board framing unless the request needs them.

## Choose artifact or code

Use a review artifact when a material visual direction, hierarchy, flow, or comparison remains unresolved. Use production code for approved implementation, integration, behavior, bug fixes, or small deterministic refinements.

When interaction is unresolved, build an interactive review artifact outside production. If materially different directions remain plausible, artifact first. Otherwise, code. Approved specifications and obvious token or state changes need no artifact.

## Review contract

The artifact should make the requested decision easier:

- show comparable options at comparable scale;
- number every frame `N.S` — artifact number, dot, screen index, never zero-padded — at the start of its caption, so feedback can name a screen. Designed ordinal labels are never zero-padded; zero-padding belongs only to machine-sortable filenames or conventional data such as timestamps;
- expose the region where options actually differ;
- keep review chrome and headers minimal unless they are under review;
- show required modes and breakpoints as visible evidence;
- preserve exploration without implying approval;
- identify source assets and model provenance when relevant.

Promote the completed review through the instance's artifact service and return the addressed HTML revision link. The artifact is the review surface and source of truth: never embed or upload its frames, screenshots, or files into chat.

If a prior board conflicts with the current brief or instance overlay, the board loses.
