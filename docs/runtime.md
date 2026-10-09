# Runtime and deployment

The Humanware OS runtime is an immutable build assembled from a framework revision and a private instance revision. It is generated, verified, activated atomically, and never edited in place.

Budget: 1,000 words. Over it, consolidate.

## Build inputs and output

Inputs are the clean framework checkout at build time (unpinned by the instance), the private instance revision with its manifest, identity overlays, runtime profiles, channel declarations, one OpenClaw configuration overlay, local-server configuration, surface routes, and secret key references, plus the data-root location and schema versions but no personal data. The builder writes a new directory under the instance-selected runtime root (`<runtimeRoot>/runtime/<build-id>`) with a manifest recording both source revisions, every rendered file hash, schema versions, builder version, creation time, and compatibility requirements.

The runtime contains no mutable session, memory, log, media, cache, or artifact state; those paths resolve into the data plane or runtime-state root. Instance `ops/` is never a runtime input. Instance local-server files are assembled under `config/services/` so launchd services such as Caddy keep stable targets when `current` changes. Humanware owns reusable service implementations and release mechanics; the instance owns which local services run plus host routes, ports, paths, and secret references.

## Activation

Services point at a stable `current` reference, never a source checkout. Activation builds into a new directory; validates schemas, references, permissions, generated instructions, domain routes, and secret key availability; probes the build on a shadow port where supported; atomically changes `current`; restarts supervised services once and runs end-to-end health checks; and retains the previous build and manifest for rollback.

OpenClaw upgrades use its stock gateway service and plugin commands. Humanware stages an exact package, renders and validates the candidate configuration, then performs one bounded stop, package/config/runtime switch, and start, without running Doctor, touching unrelated local services, or snapshotting mutable state. The displaced package, prior configuration, runtime reference, and workspace projections form the rollback journal; data backup is separate.

Rollback reselects the previous runtime build without resetting source repositories or data.

Any gateway-impacting cutover requires a fresh, single-use operator approval scoped to the instance and exact action, expiring within 30 minutes and recording approver, reason, initiating session and thread, pull request, and whether active sessions may be interrupted. A shared data-plane restart freeze blocks cutover absolutely; otherwise active sessions block it unless the approval overrides draining. The approval is consumed immediately before the gateway stops and copied into the deployment report. Missing, malformed, expired, reused, or unscoped authority fails closed. An already-active pair of source revisions is a successful no-op.

With that approval in the current conversation the agent runs `scripts/deploy-once.py launch FRAMEWORK_DIR INSTANCE_DIR --approved-by NAME --reason TEXT --pr URL --agent ID --channel SLACK_CHANNEL_ID --thread SLACK_THREAD_TS --session SESSION_KEY [--allow-active-sessions] [--openclaw-version EXACT_VERSION]`; instance id, data root, and agent ids come from `humanware.instance.json`. It writes the approval into the data plane, schedules a durable check back to the Slack thread, and bootstraps `scripts/openclaw-deploy.sh` as a one-shot launchd job outside the gateway's process tree, never via keepalive-inferring `launchctl submit`. The deploy script accepts only that verified supervisor, refuses gateway-descended ancestry, requires both checkouts clean on `main` at `origin/main` with the requested OpenClaw version matching the pin, then delegates to `scripts/openclaw-cutover.sh`. Submission is not success: require `Deploy complete` and independent runtime health, then `bootout` the exited job, keeping its plist and logs.

Post-deploy canaries probe channels and run bounded synthetic turns but never restart the production gateway; restart recovery is tested against an isolated gateway.

## Source checkouts and worktrees

The deployed framework and instance checkouts stay clean on their canonical branches; agents never get either as a writable task directory. Every mutating task, however small, gets an isolated worktree from the latest canonical remote branch. The session ledger records repository, branch, worktree, owner, status, and merge disposition; closing a task proves it merged, under review, or consciously archived. Memory, sessions, and working documents belong to the data plane and create no Git branches.

## Configuration drift

The private instance manifest is canonical; live service configuration is generated. A drift checker compares the active runtime manifest and hashes to the expected build and fails on divergence. Editing a live copy without rebuilding is emergency containment and must name an expiring incident patch. One plugin identifier resolves to one path in one build; duplicate plugin copies, mixed worktree paths, and source-checkout paths in service definitions fail validation.

## Boot readiness

The service supervisor distinguishes dependency readiness from process failure: before starting the gateway it verifies network route, DNS, required secret keys, data root, runtime manifest, and channel credentials, and missing readiness waits with bounded backoff and a visible health state rather than crash-looping. The reboot gate verifies host, power, and login state; Tailscale and SSH; DNS and secrets provider; domain frontend and TLS; container/runtime dependencies; gateway stable PID and plugin manifest; every enabled channel adapter connected; both reference agents routable; and one non-mutating surface canary.

An optional adapter is contained only when its failure cannot degrade required channels or the agent core through shared databases, queues, locks, or retry load. Its supervisor uses bounded retries and a circuit breaker and fails closed until repaired or explicitly re-enabled. Post-cutover acceptance verifies required-channel health after optional services settle.

## macOS host operations

Routine agent commands run headlessly without Terminal.app. Interactive setup windows have an owning task and close when it finishes; cleanup preserves active jobs and unsaved work and never closes an unowned window. If macOS denies access, report the blocked operation rather than granting a shared interpreter Accessibility or Full Disk Access.

Runtime builds strictly parse service plists and reject duplicate labels, invalid argument arrays, and relative executable/log paths. Installation verifies executables and reconciles enabled service labels against the generated runtime; upgrade and uninstall touch only product-owned services, retain data, and preserve rollback. Health reporting distinguishes malformed configuration, missing dependencies, and failed jobs. Desktop cleanup inventories first, preserves files with a reversible move manifest, and verifies afterward; storage pruning requires a verified backup and restore check. Account separation and privacy grants are owned by [the permission model](docs/permission-model.md).
