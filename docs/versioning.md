# Versioning

Humanware OS has one version model for every published or reviewable content item: artifacts, public pages, and any later surface that shows history. This spec owns that model, its URLs, and its rendered footer, history, and diff pages. Runtime builds, calendar revisions, and event corrections have their own owners.

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
- `url`: the version's own address, absent when the source keeps no rendered snapshot;
- `diff_url`: the address of its diff against `supersedes`, absent on the first version or when the source keeps no diff.

`versions` is ordered oldest to newest, and each `supersedes` names the previous entry, so the list is one unbranched chain. `current_version` names a registered version; it is normally the newest. Changing content appends a version and moves `current_version`. A version's position in the list is its ordinal, used for "version N of M".

## URLs

- The stable `url` always renders the current version.
- Each version is addressable. New items place versions at `<url>versions/<version-id>/`. Existing addresses, such as sibling artifact revision URLs, remain valid; the version's `url` records the real address and renderers never derive one.
- `<url>versions/` is the item's history page.
- New diffs live at `<url>versions/<version-id>/diff/`; as with `url`, the version records the real address.

## Sources

Every source maps into the same model before rendering:

- **Artifacts:** the artifact registry is the source. Each registered stable artifact is a versioned item; its revisions are its versions. The artifact service appends the version, validates the chain, and builds every footer, history page, and diff page in the review projection. A diff is the unified diff of the version's `index.html` against its predecessor's.
- **Public site pages:** Git history is the source. The build maps each commit that changed a page to a version with the short hash as `id`, the commit subject as `title`, and the commit date. Commits have no rendered snapshot, so those versions omit `url`; a diff is that commit's unified diff for the page's source.

A source may add metadata but may not invent a second version shape.

## Footer contract

Every rendered version of a versioned item ends with one provenance block, the same on public and private surfaces. It shows:

1. the shown version's title and address;
2. "Created at", the first version's date, and "Updated", the shown version's date;
3. "Version N of M", where N is the shown version's ordinal;
4. a "History" link to the history page;
5. a link to the current version, only when the shown version is not current.

The history page states the item title, version count, and created and updated dates, then lists every version newest first with its number, date, title, optional note, a "View" link when `url` exists, and a "Diff from N" link when `diff_url` exists. The current version is marked with `aria-current`. The diff page names both versions and marks up the source's unified diff with line counts.

## Rendering

The framework renderer at `surfaces/domain/versioning/` is the single implementation, shipped as matching JavaScript and Python modules: `renderVersionFooter(item, versionId)`, `renderVersionHistory(item)`, and `renderVersionDiff(item, versionId, diff)`, with snake-case Python equivalents. Both return HTML fragments and must produce byte-identical output for the shared golden fixtures.

Output is unstyled semantic HTML. It reuses the public site's footer, history, and diff-line class names shown in the fixtures, so one stylesheet structure serves both surfaces, and contains no CSS or scripts. The stable hooks are those classes plus `hw-version-footer`, `hw-version-history`, and `hw-version-diff` and the attributes `data-hw-item`, `data-hw-version`, and `data-hw-current`. Hosts style only through those hooks. Changing markup requires updating both modules and the fixtures together.
