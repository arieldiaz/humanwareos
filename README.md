# Humanware OS

**The open operating system for the human side of AI.**

Humanware OS is a reusable framework for durable AI agents: behavioral rules, identity templates, channel contracts, execution profiles, data schemas, and a public/private domain surface. It is deliberately separate from one person's configuration and from the material those agents create.

## The system boundary

Humanware installations have three sources and one generated output:

1. **Humanware OS** is the public framework. Reusable fixes and capabilities land here through reviewed pull requests.
2. **The private instance** pins one framework revision and contains only local configuration: agent overlays, channel routing, model and harness profiles, domain routes, host paths, and secret identifiers.
3. **The data plane** holds the stream, memory, strategy, sessions, working documents, artifacts, derived indexes, and caches outside Git. Most durable evidence is append-only; current projections and working documents are versioned.
4. **The runtime** is a checksummed immutable build assembled from the pinned framework and instance. Services use its `current` symlink. It is output, never source.

This separation makes updates reviewable, restores mechanical, and debugging local: a behavior defect belongs to the framework, a deployment fact belongs to the instance, accumulated material belongs to data, and a runtime discrepancy is fixed by rebuilding.

Read [System boundaries](docs/system-boundaries.md), [Architecture](docs/architecture.md), and [Runtime](docs/runtime.md) for the full contracts.

## Agents, harnesses, and interfaces

An agent identity is not a model or coding harness. Liv, Max, or another durable identity can use the native OpenClaw path for ordinary work and select Pi, Cursor, Codex, or another adapter for a particular task. The private instance grants the same profile catalog to equivalent agents; the chosen profile controls permissions, workspace isolation, model, and data scope.

Slack is the supported first channel, not a core dependency. Buzz and a future native application are replaceable adapters over the same agent runtime. The framework owns reply semantics and lifecycle; each adapter owns transport and rendering.

A full installation can also expose one domain with public and private halves. The framework supplies the frontend shell and route contracts; the instance supplies domain names, enabled modules, origins, and deployment adapter. A private surface can run on an always-on Mac today and move to a cloud adapter later without changing agent identity or data ownership. See [Domain surface](docs/domain-surface.md).

## Install

From a Humanware OS checkout:

```bash
./install.sh /absolute/path/to/my-instance --repo OWNER/my-instance
```

The installer creates or reuses a public framework checkout, creates a separate private instance, initializes an external data root, builds an immutable runtime, and optionally creates the private GitHub repository. It prints every resolved path.

To pin a specific framework checkout and choose every storage boundary explicitly:

```bash
./install.sh /absolute/path/to/my-instance --framework-dir /absolute/path/to/humanwareos --data-root /absolute/path/to/my-data --runtime-root "/absolute/path/to/Application Support/HumanwareOS/my-instance" --worktree-root /absolute/path/to/my-worktrees
```

Continue with [Getting Started](docs/getting-started.md) to configure an agent and verify the first end-to-end channel handoff.

## Repository map

```text
humanwareos/
├── AGENTS.md          global operating rules
├── agents/            reusable identity templates
├── commands/          operating-loop commands
├── docs/              architecture and behavior contracts
├── ops/               reusable host and data-plane mechanisms
├── schemas/           typed instance contracts
├── scripts/           validation, data initialization, runtime build
└── templates/         private-instance and data-plane seeds
```

Personal strategy, memory, working documents, sessions, and artifacts do not appear in this tree. Their schemas and seed templates do.

## Change flow

Framework and instance repositories use trunk-based development: branch in an isolated worktree, open a pull request, pass CI, squash-merge to `main`, and delete the branch. Small fixes may be one-commit pull requests; live service checkouts are never editing workspaces. Data-plane events do not need pull requests, but every write has provenance and an owning project or thread.

## Status

Humanware OS is early. OpenClaw plus Slack is the supported starting path. Alternative harnesses and channels are selectable adapters, not forks of an agent. Buzz remains experimental and is not required for a reliable installation.

## License

[MIT](LICENSE).
