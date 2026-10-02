# Versioning

Humanware OS has one version model for every published or reviewable content item: artifacts, public pages, and any later surface that shows history. This spec owns that model, its URLs, and its rendered footer and history page. It does not cover runtime builds, calendar revisions, or event corrections, which have their own owners.

Budget: 700 words. Over it, consolidate.

## Versioned item

A versioned item has a stable `id`, a `title`, a stable `url`, an ordered `versions` list, and a `current_version`. Its shape is [`schemas/versioned-item.schema.json`](schemas/versioned-item.schema.json).

A version is immutable once registered. It has:

- `id`: a URL slug unique among addresses in its scope and different from the item `id`;
- `number`: the human label, such as `3` or `r3`;
- `date_label`: the displayed date, with an optional ISO `date` for machine-readable time;
- `title`: the version's title, which may differ from earlier versions;
- `note`: an optional one-line change note;
- `supersedes`: the `id` of the immediately preceding version, absent only on the first;
- `url`: the version's own address, absent when the source keeps no rendered snapshot.

`versions` is ordered oldest to newest, and each `supersedes` names the previous entry, so the list is one unbranched chain. `current_version` names a registered version; it is normally the newest. Changing content appends a version and moves `current_version`; it never rewrites an existing version. A version's position in the list is its ordinal, used for "version N of M".

## URLs

- The stable `url` always renders the current version.
- Each version is addressable. New items place versions at `<url>versions/<version-id>/`. Existing addresses, such as sibling artifact revision URLs, remain valid; the version's `url` records the real address and renderers never derive one.
- `<url>versions/` is the item's history page.

## Sources

Every source maps into the same model before rendering:

- **Artifacts:** the artifact registry is the source. Each registered stable artifact is a versioned item; its revisions are its versions. The artifact service appends the version, validates the chain, and builds every footer and history page in the review projection.
- **Public site pages:** Git history is the source. The build maps each commit that changed a page to a version with the short hash as `id`, the commit subject as `title`, and the commit date. Commits have no rendered snapshot, so those versions omit `url`.

A source may add metadata but may not invent a second version shape.

## Footer contract

Every rendered version of a versioned item ends with one version footer. It shows:

1. "Version N of M", where N is the shown version's ordinal;
2. the shown version's date;
3. a link to the history page;
4. a link to the current version, only when the shown version is not current.

The history page lists every version newest first with its number, date, title, optional note, and link when a `url` exists. The current version is marked with `aria-current`.

## Rendering

The framework renderer at `surfaces/domain/versioning/` is the single implementation, shipped as matching JavaScript and Python modules: `renderVersionFooter(item, versionId)` / `render_version_footer(item, version_id)` and `renderVersionHistory(item)` / `render_version_history(item)`. Both return an HTML fragment and must produce byte-identical output for the shared golden fixtures.

Output is unstyled semantic HTML: `footer`, `section`, `h2`, `ol`, `li`, `a`, and `time`. It contains no CSS, inline styles, or scripts, so it inherits the host page's styles; public and private surfaces style it differently. The stable hooks are the classes `hw-version-footer` and `hw-version-history` and the attributes `data-hw-item`, `data-hw-version`, and `data-hw-current`. Hosts style only through those hooks. Changing markup requires updating both modules and the fixtures together.
