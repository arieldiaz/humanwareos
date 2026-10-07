# Versioning

One version model serves every published or reviewable content item. This spec owns the model, its URLs, and its footer, history, and diff pages; runtime builds, calendar revisions, and event corrections have other owners.

Budget: 700 words. Over it, consolidate.

## Versioned item

A versioned item has a stable `id`, a `title`, a stable `url`, an ordered `versions` list, and a `current_version`. Its shape is [`schemas/versioned-item.schema.json`](schemas/versioned-item.schema.json).

A version is immutable once registered. It has:

- `id`: a URL slug unique in its scope and different from the item `id`;
- `number`: the human label, such as `3` or `r3`;
- `date_label`: the displayed date, with an optional ISO `date`;
- `title`: the version's own title;
- `note` and `ref`: an optional change note and source reference, such as a commit hash;
- `supersedes`: the preceding version's `id`, absent only on the first;
- `url`: its own address, absent without a rendered snapshot;
- `diff_url`: its diff against `supersedes`, absent on the first version or without a diff.

`versions` runs oldest to newest as one unbranched chain. `current_version` names a registered version, normally the newest; changing content appends a version and moves it.

An item may set `created` and `updated` (each `date_label` plus optional `date`) when its lifetime dates come from content metadata rather than the first and newest versions.

## URLs

- The stable `url` always renders the current version.
- Each version is addressable. New items place versions at `<url>versions/<version-id>/` and diffs below them at `diff/`. Existing addresses remain valid; versions record their real `url` and `diff_url`, which renderers never derive.
- `<url>versions/` is the versions page and the footer's history link. Hosts may render it as a visual grid that links each diff and the history list at `<url>versions/history/`. An item whose history already lives elsewhere sets `history_url`.

## Sources

Every source maps into this model:

- **Artifacts:** the artifact registry is the source. By default one working session makes one artifact: its first promotion creates the stable artifact and records the session key; later promotions append versions. A session may deliberately start another artifact, and one page may hold its own variants. The artifact service validates the chain and builds every footer, versions, history, and diff page in the review projection. Diffs compare each version's `index.html` with its predecessor's.
- **Public site pages:** Git history is the source. Each commit that changed a page is a version with its short hash as `id` and `ref`, its subject as `title`, and its date. Commits keep no rendered snapshot, so versions omit `url`. Lifetime dates come from content metadata; history stays at `<url>diffs/`.

A source may add metadata but may not invent a second version shape.

## Footer contract

Every rendered version ends with one provenance block, the same on public and private surfaces. It shows:

1. the item's title and address, or the shown version's when it is not current;
2. "Created at" and "Updated" dates;
3. a "History" link;
4. only when the shown version is not current, "Version N of M" and a link to the current version.

The history page states the item title, version count, and created and updated dates, then lists every version newest first with its number, date, title, optional note and reference, a "View" link when `url` exists, and a "Diff from N" link when `diff_url` exists. The current version carries `aria-current`. The diff page names both versions and marks up the unified diff with line counts.

## Rendering

[`surfaces/domain/versioning/`](surfaces/domain/versioning/) is the single implementation: `versioning.mjs` exports `renderVersionFooter(item, versionId)`, `renderVersionHistory(item)`, and `renderVersionDiff(item, versionId, diff)`, and `versioning.css` styles their output. Non-JavaScript hosts call the module's command line with the item JSON on standard input. Golden fixtures pin the markup.

Output is semantic HTML with no inline styles or scripts. The stylesheet reads host design tokens. Hosts may add rules only through the classes in the fixtures and the hooks `hw-version-footer`, `hw-version-history`, `hw-version-diff`, `data-hw-item`, `data-hw-version`, and `data-hw-current`.

Hosts never fork this directory. The runtime build publishes it at the domain surface's `/versioning/`. A host outside the runtime, such as a static public site, vendors it byte-for-byte through a sync script that records the source commit; its tests fail on hand edits.
