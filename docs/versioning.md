# Versioning

One version model serves every published or reviewable content item. This spec owns the model, its URLs, and its footer, history, and diff pages; runtime builds, calendar revisions, and event corrections have other owners.

Budget: 700 words. Over it, consolidate.

## Versioned item

A versioned item has a stable `id`, a `title`, a stable `url`, an ordered `versions` list, and a `current_version`. Its shape is [`schemas/versioned-item.schema.json`](schemas/versioned-item.schema.json).

A version is immutable once registered. It has a slug `id` distinct from the item's, a display `number`, a `title`, a `date_label` with optional ISO `date`, an optional `note` and `ref` (such as a commit hash), `supersedes` naming its predecessor (absent only on the first), and, when they exist, its own `url` and a `diff_url` against its predecessor. `versions` runs oldest to newest as one unbranched chain; `current_version` names a registered version, normally the newest. An item may set `created` and `updated` when its lifetime dates come from content metadata.

## URLs

The stable `url` always renders the current version. Versions live at `<url>versions/<n>/` with diffs at `diff/` below them; versions record their real `url` and `diff_url`, which renderers never derive. `<url>versions/` is the footer's history link, and `<url>versions/history/` lists versions. An item whose history lives elsewhere sets `history_url`.

## Sources

Every source maps into this model:

- **Artifacts:** the artifact registry ([`schemas/artifact-registry.schema.json`](schemas/artifact-registry.schema.json)) is the source, and [`ops/artifacts/`](ops/artifacts/) is its only writer. One session makes exactly one artifact: its first promotion creates it and later ones add its next versions; another session makes a new one. Two numbers are never conflated: the **artifact number**, dense 1..N per project by first version date, assigned from `nextNumber`, the default reference, whose URL `/artifacts/<project>/<number>/` renders the live version; and the **version number**, 1..N per artifact in date order, shown only on version views. Authors never write either number; pre-registry labels survive only as `legacy` redirects. Grouping may merge projects or fold artifacts, renumbering versions by date and artifacts densely, recording old→new; it changes only metadata; retired addresses survive in `redirects` unless now live. Artifact pages carry one generated breadcrumb: home, Artifacts, project, artifact, Versions, version, then History or Diff. The live footer links `versions/`, a grid of every version in the project pages' card, linking each diff and the history list. Diffs compare each version's `index.html` with its predecessor's. Instances supply only the data root, public origin and repository, private markers, and theme tokens.
- **Public site pages:** Git history is the source. Each commit that changed a page is a version with its short hash as `id` and `ref`, its subject as `title`, and its date. Commits keep no rendered snapshot, so versions omit `url`. Lifetime dates come from content metadata; history stays at `<url>diffs/`.

A source may add metadata, not a second version shape.

## Footer contract

Every rendered version ends with one provenance block, the same on public and private surfaces: the item's title and address (the shown version's when not current), "Created at" and "Updated" dates, a "History" link, and, only on a non-current version, "Version N of M" with a link to the current version.

The history page states the item title, version count, and created and updated dates, then lists every version newest first with its number, date, title, optional note and reference, a "View" link when `url` exists, and a "Diff from N" link when `diff_url` exists. The current version carries `aria-current`. The diff page names both versions and marks up the unified diff with line counts.

## Rendering

[`surfaces/domain/versioning/`](surfaces/domain/versioning/) is the single implementation: `versioning.mjs` exports `renderVersionFooter(item, versionId)`, `renderVersionHistory(item)`, and `renderVersionDiff(item, versionId, diff)`, and `versioning.css` styles their output. Non-JavaScript hosts call the module's command line with the item JSON on standard input. Golden fixtures pin the markup.

Output is semantic HTML with no inline styles or scripts. The stylesheet reads host design tokens. Hosts may add rules only through the classes in the fixtures and the hooks `hw-version-footer`, `hw-version-history`, `hw-version-diff`, `data-hw-item`, `data-hw-version`, and `data-hw-current`.

Hosts never fork this directory. The runtime build publishes it at the domain surface's `/versioning/`. A host outside the runtime, such as a static public site, vendors it byte-for-byte through a sync script that records the source commit; its tests fail on hand edits.
