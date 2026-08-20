# Adopting Humanware OS

Humanware OS is a versioned framework consumed by a small private instance repository. Personal memory and work live in a separate data plane. The three systems do not share a Git history or change process.

Budget: 1,200 words. Over it, consolidate.

## Reference layout

```text
~/github/humanware-os/       public framework checkout
~/github/my-humanware/       private instance configuration
~/humanware-data/            private data plane, not a source repository
~/Library/Application Support/HumanwareOS/
  runtime/<build-id>/        immutable generated runtime
  current -> runtime/...     active build
```

The instance pins a framework revision in `humanware.lock.json`. It does not merge framework history into its own repository. Generic framework files are referenced from the pinned checkout and copied only into generated runtime builds.

## Create an instance

The installer clones or locates Humanware OS, initializes a new private instance from the instance template, creates the external data layout, and builds the first runtime:

```sh
curl -fsSL https://raw.githubusercontent.com/arieldiaz/humanwareos/main/install.sh | sh -s -- my-humanware --repo YOUR-GITHUB-USER/my-humanware
```

Creating a private GitHub repository is optional. Without `--repo`, the instance remains local until the human chooses a remote.

## Update the framework

Framework adoption is a version bump, not a merge:

1. Fetch Humanware OS in its own clean checkout.
2. Review release notes and migrations.
3. Change the instance lock to the selected revision in an instance worktree.
4. Build a new runtime without activating it.
5. Run instance, data-schema, adapter, domain, and end-to-end checks.
6. Merge the instance lock change and atomically activate that build.

The deployed instance and framework checkouts remain clean. A failed upgrade leaves the previous runtime active.

## Send an improvement upstream

The stranger test decides ownership: if another installation would benefit, the change belongs in Humanware OS. Create the framework task from current Humanware OS `origin/main`, implement the generic fix, and verify it against an example instance. After the framework PR merges, update the private instance lock.

Do not prototype a generic rule by copying a framework file into the instance. When urgent containment must ship before upstream review, place the smallest patch under the instance's declared compatibility-patch directory with:

- upstream issue or PR;
- owner;
- creation and expiration dates;
- affected framework versions;
- removal condition and test.

The instance validator fails expired or unreferenced compatibility patches.

## What lives where

Humanware OS contains reusable rules, specs, agent templates, skills, schemas, adapters, builders, generic services, frontend components, and tests.

The private instance contains the framework lock, agent overlays, runtime-profile selections, channel and account identifiers, secret references, domain routes, private integration configuration, branding, and truly private plugins.

The data plane contains strategy, memory evidence and projections, sessions, working documents, artifacts, media, records, stream events, and derived indexes. Ordinary data writes do not use PRs.

Generated runtime contains rendered instructions and configuration from the two source revisions. It contains no personal data or mutable state and is never edited by hand.

## Configuration seam

Machine and account configuration is typed instance data, not a copied `.example` file beside a live `.env`. Secret values live only in the configured secrets manager. Instance files reference a secret by provider and key identifier.

Framework schemas define allowed fields and defaults. The private instance supplies values. A new generic configuration field changes its framework schema, template, validator, migration, and documentation together. A private value changes only the instance.

## Data portability

The data plane is not Git, but it is not opaque. Append-only events and artifact manifests use documented schemas. Current memory and strategy are plain readable projections. Large files are content-addressed. Search indexes are rebuildable. Encrypted snapshots and restore tests provide history without imposing code-review semantics on daily life.
