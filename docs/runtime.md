# Runtime and deployment

The Humanware OS runtime is an immutable build assembled from a pinned framework revision and a private instance revision. It is generated, verified, activated atomically, and never edited in place.

Budget: 1,000 words. Over it, consolidate.

## Build inputs and output

Required inputs:

- Humanware OS framework revision and release metadata.
- Private instance revision and framework lock.
- Instance manifest, identity overlays, runtime profiles, channel adapters, surface routes, and secret key references.
- Data-root location and schema versions, but no personal data contents.

The builder writes a new directory under the instance-selected runtime root, conventionally `~/Library/Application Support/HumanwareOS/runtime/<build-id>`. The build manifest records both source revisions, every rendered file hash, schema versions, builder version, creation time, and compatibility requirements.

The runtime contains no mutable session, memory, log, media, cache, or generated artifact state. Those paths resolve into the data plane or dedicated runtime-state root. Instance `ops/` scripts are copied into `config/ops/`, so cutover, verification, and rollback logic is versioned with the instance but executes only from the immutable runtime.

## Activation

Services point at a stable `current` reference, not a source checkout. Activation proceeds:

1. Build into a new unique directory.
2. Validate schemas, references, permissions, generated instructions, domain routes, and secret key availability.
3. Start or probe the new build without changing the current reference when the adapter supports a shadow port.
4. Atomically change `current` to the verified build.
5. Restart supervised services once, then run end-to-end health checks.
6. Retain the previous build and manifest for rollback.

Rollback reselects the previous runtime build. It does not reset source repositories or data.

Deployment and cutover commands run in a foreground operator shell or through a reviewed supervisor that is explicitly one-shot. `launchctl submit` is prohibited for deployments and cutovers because it creates an inferred keepalive job that may respawn a completed command indefinitely. The deployment entrypoint fails closed when it detects an unapproved service supervisor, treats an already-active pair of source revisions as a successful no-op, and verifies that no retired deployment or cutover job remains registered.

Production post-deploy canaries are non-disruptive. They may probe channels and run bounded synthetic turns with stable session keys, but they never restart the production gateway. Restart recovery is tested against a shadow or isolated gateway with no user sessions.

## Source checkouts and worktrees

The deployed framework and instance checkouts remain clean and pinned to their canonical branches. Agents never receive either as a writable task directory.

Every mutating task receives an isolated worktree created from the latest canonical remote branch. The session ledger records repository, branch, worktree, owner, status, and merge disposition. Closing a task must prove merged, open for review, or consciously archived; unique work cannot remain in an anonymous checkout.

Small changes use the same mechanism with a one-commit fast review. Memory, sessions, and working documents do not create Git branches because they belong to the data plane.

## Configuration drift

The private instance manifest is canonical. Live service configuration is generated. A drift checker compares the active runtime manifest and hashes to the expected build and fails on divergence. Editing a live JSON, plist, prompt, or plugin copy without rebuilding is unsupported emergency containment and must identify an expiring incident patch.

One plugin identifier resolves to one path in one build. Duplicate plugin copies, mixed worktree paths, and source-checkout paths in service definitions are validation failures.

## Boot readiness

The service supervisor distinguishes dependency readiness from process failure. Before starting the gateway, it verifies network route, DNS, required secret keys, data-root availability, runtime manifest, and selected channel credentials. Missing readiness waits with bounded backoff and a visible health state; it does not crash-loop the application until safety breakers suppress healthy providers.

The reference reboot gate verifies:

- host, power, and login state;
- Tailscale and SSH reachability;
- DNS and secrets provider;
- domain frontend and TLS;
- container/runtime dependencies;
- gateway stable PID and plugin manifest;
- every enabled channel adapter connected;
- both reference agent identities routable;
- one non-mutating surface canary.

Buzz or another optional adapter may fail without taking down Slack, the native application, or the agent core.
