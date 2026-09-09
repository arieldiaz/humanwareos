# Document workspace

The private domain document workspace is the human-facing control plane for an installation's durable documents. It combines framework source, private instance source, and explicitly approved data-plane collections without copying private material into a source repository.

Budget: 900 words.

## Contract

Humanware OS owns the browser shell, manifest schema, safe read/search service, proposal format, and responsive accessible behavior. The private instance owns enabled collections, absolute source roots, labels, exclusions, route policy, proposal destination, and the work agent that handles proposals. The data plane owns proposal events and every private document displayed from it.

The workspace is read-only with respect to source documents. A person may submit a proposal against a document or selected passage. The service appends that request to an instance-owned queue with the document ID, content hash, selection, comment, author, and time. An authorized agent later re-reads the current source, detects stale context, applies the change at the owning layer through its normal review path, and records the result. The browser never patches a source file.

## Read boundary

Every visible document resolves through an enabled collection in the instance manifest. A collection has an opaque ID, display label, absolute root, allowed extensions, and optional exclusions. The service rejects absolute client paths, traversal, files outside a configured root, symlinks that escape a root, unsupported types, and oversized files. The browser receives collection-relative display paths only.

Tier 0 raw stream material is excluded from this surface. An instance may expose curated current memory, strategy, governance, working documents, and generated reports when its privacy policy permits them. The same manifest governs navigation, search, and direct reads; search must never become a side channel around collection policy.

## Proposal lifecycle

Proposal state is `open`, `claimed`, `applied`, `declined`, or `superseded`. Submission creates `open`; only the configured work agent or an authorized operator advances it. A proposal is stale when its recorded content hash no longer matches the source. Stale proposals remain visible evidence and require the agent to reconcile rather than applying text mechanically.

The first release guarantees durable append-only intake. Agent wake and resolution projection are instance integrations over that queue, not browser privileges.
