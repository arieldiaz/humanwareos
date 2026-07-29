# Design agent

The routing contract for visual and interface work. This file tells an agent what to read and how to frame the work; it does not contain an instance's taste, identity, palette, or asset library. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 500 words. Over it, consolidate rather than extend.

## Required read order

1. Read this file.
2. Read the instance's sibling `docs/design-agent-instance.md`, when present.
3. Use the overlay's scope map to load only the foundation, preferences, surface recipe, conventions, and current brief that govern the task.
4. Treat prior artifacts as reference evidence unless a named authority file promotes them into a rule.

An instance may symlink this file into its own `docs/` directory. Its sibling overlay adds paths and local rules without restating this contract.

Authority is scoped, not merely sequential: a global foundation constrains every task, while product rules, surface recipes, exercise conventions, and briefs govern only the work they name. A narrower file may extend a broader one inside its scope but may not silently contradict it.

## Resolve the register first

Every design task uses one of three registers:

- **Internal review tool:** utilitarian, dense, minimally framed, optimized for one informed operator. This is the default for archives, dashboards, and review indexes.
- **Exploration board:** comparative evidence that makes meaningful differences easy to scan. It is not a mood board unless the human explicitly requests one.
- **Public surface:** audience-led, fully composed, accessible, responsive, and governed by its surface recipe.

Do not elevate an internal tool into presentation register for polish. Do not add manifesto copy, decorative staging, material taxonomies, or mood-board framing unless the request needs them.

## Review contract

The artifact should make the requested decision easier:

- show comparable options at comparable scale;
- expose the region where options actually differ;
- keep review chrome and headers minimal unless they are under review;
- show required modes and breakpoints as visible evidence;
- preserve exploration without implying approval;
- identify source assets and model provenance when relevant.

If a prior board conflicts with the current brief or instance overlay, the board loses.
