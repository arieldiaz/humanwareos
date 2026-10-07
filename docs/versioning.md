# Versioning

Humanware OS has one version model for every published or reviewable content item. This spec owns that model, its URLs, and its footer, history, and diff pages. Runtime builds, calendar revisions, and event corrections have their own owners.

Budget: 700 words. Over it, consolidate.

## Versioned item

A versioned item has a stable `id`, a `title`, a stable `url`, an ordered `versions` list, and a `current_version`. Its shape is [`schemas/versioned-item.schema.json`](schemas/versioned-item.schema.json).

A version is immutable once registered. It has:

- `id`: a URL slug unique among addresses in its scope and different from the item `id`;
- `number`: the human label, such as `3` or `r3`;
- `date_label`: the displayed date, with an optional ISO `date`;
- `title`: the version's title, which may differ from earlier versions;
- `note` and `ref`: an optional one-line change note and source reference, such as a commit hash;
- `supersedes`: the `id` of the preceding version, absent only on the first;
- `url`: the version's own address, absent when the source keeps no rendered snapshot;
- `diff_url`: the address of its diff against `supersedes`, absent on the first version or when the source keeps no diff.

`versions` is ordered oldest to newest as one unbranched chain. `current_version` names a registered version, normally the newest. Changing content appends a version and moves `current_version`.

An item may set `created` and `updated` (each `date_label` plus optional `date`) when its lifetime dates come from content metadata rather than the first and newest versions.

## URLs

- The stable `url` always renders the current version.
- Each version is addressable. New items place versions at `<url>versions/<version-id>/` and diffs at `<url>versions/<version-id>/diff/`. Existing addresses remain valid; the version records its real `url` and `diff_url`, and renderers never derive one.
- `<url>versions/` is the history page. An item whose history already lives elsewhere sets `history_url`.

## Sources

Every source maps into the same model before rendering:

- **Artifacts:** the artifact registry is the source. Each stable artifact is a versioned item and its revisions are its versions. The artifact service appends versions, validates the chain, and builds every footer, history page, and diff page in the review projection. A diff is the unified diff of the version's `index.html` against its predecessor's.
- **Public site pages:** Git history is the source. Each commit that changed a page is a version with its short hash as `id` and `ref`, its subject as `title`, and its date. Commits keep no rendered snapshot, so versions omit `url`. Lifetime dates come from content metadata, and history stays at the existing `<url>diffs/` address.

A source may add metadata but may not invent a second version shape.

## Footer contract

Every rendered version ends with one provenance block, the same on public and private surfaces. It shows:

1. the shown version's title and address;
2. "Created at" and "Updated" dates;
3. a "History" link;
4. only when the shown version is not current, "Version N of M" and a link to the current version.

The history page states the item title, version count, and created and updated dates, then lists every version newest first with its number, date, title, optional note and reference, a "View" link when `url` exists, and a "Diff from N" link when `diff_url` exists. The current version carries `aria-current`. The diff page names both versions and marks up the unified diff with line counts.

## Rendering

[`surfaces/domain/versioning/`](surfaces/domain/versioning/) is the single implementation: `versioning.mjs` exports `renderVersionFooter(item, versionId)`, `renderVersionHistory(item)`, and `renderVersionDiff(item, versionId, diff)`, and `versioning.css` styles their output. Non-JavaScript hosts call the module's command line with the item JSON on standard input. Golden fixtures pin the markup.

Output is semantic HTML with no inline styles or scripts. The stylesheet reads host design tokens. Hosts may add rules only through the classes in the fixtures and the hooks `hw-version-footer`, `hw-version-history`, `hw-version-diff`, `data-hw-item`, `data-hw-version`, and `data-hw-current`.

Hosts never fork this directory. The runtime build already publishes it at the domain surface's `/versioning/`. A host outside the runtime, such as a statically built public site, vendors the directory byte-for-byte through a sync script that records the source commit, and its tests fail when the copy is edited by hand.
