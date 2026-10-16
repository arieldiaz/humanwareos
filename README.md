# Humanware OS

**The open operating system for the human side of AI.**

Humanware OS is a reusable framework for durable AI agents: behavioral rules, identity templates, channel contracts, execution profiles, data schemas, and a public/private domain surface. It is deliberately separate from one person's configuration and from the material those agents create.

## The system boundary

Humanware installations have three sources and one generated output:

1. **Humanware OS** is the public framework. Reusable fixes and capabilities land here through reviewed pull requests.
2. **The private instance** contains only local configuration: agent overlays, channel routing, model and harness profiles, domain routes, local-server selection, host paths and ports, Caddy routes, and secret identifiers. It is the source of truth for what runs on a particular Mac or server, while reusable service implementations remain in Humanware OS. Each generated runtime records the framework revision used to assemble it.
3. **The data plane** holds the stream, memory, strategy, sessions, working documents, artifacts, derived indexes, and caches outside Git. Most durable evidence is append-only; current projections and working documents are versioned.
4. **The runtime** is a checksummed immutable build assembled from recorded framework and instance revisions. Services use its `current` symlink. It is output, never source.

This separation makes updates reviewable, restores mechanical, and debugging local: a behavior defect belongs to the framework, a deployment fact belongs to the instance, accumulated material belongs to data, and a runtime discrepancy is fixed by rebuilding.

OpenClaw is one framework-managed runtime dependency, not the owner of the whole host. Its cutover replaces the pinned OpenClaw package, rendered configuration, workspaces, and native gateway service only. Other launchd services continue through stable paths in the generated runtime and are selected and configured by the private instance. An OpenClaw upgrade does not reinstall or restart Caddy, local web applications, observability, ingestion, calendar, email, or backup services.

Read [System boundaries](docs/system-boundaries.md), [Architecture](docs/architecture.md), [Project repositories](docs/project-repos.md), and [Runtime](docs/runtime.md) for the full contracts.

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

## Private-instance template

[`templates/instance`](templates/instance) is the one authored starter for a private installation. It is published to [`arieldiaz/my-humanware-template`](https://github.com/arieldiaz/my-humanware-template) as generated distribution, not a second source to maintain. A personal repository such as `my-humanware` is created from that template and then owns that installation's identities, channel and domain identifiers, local-server configuration, host paths, and secret references.

Prefer `./install.sh /absolute/path/to/my-humanware --repo OWNER/my-humanware` to create an instance: it resolves the required absolute storage paths and placeholder values before the first commit. The GitHub template remains useful for inspection or manual setup, but it does not guess machine paths. The starter deliberately contains no personal Caddy routes, LaunchAgent inventory, account identifiers, or service implementations. Add those to the private instance as local-server configuration; add reusable service code or deployment mechanics to Humanware OS. Never copy mutable sessions, artifacts, media, logs, caches, or secret values into either repository.

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
└── templates/         project-repository, private-instance, and data-plane seeds
```

Personal strategy, memory, working documents, sessions, and artifacts do not appear in this tree. Their schemas and seed templates do.

## Change flow

Framework and instance repositories use trunk-based development: branch in an isolated worktree, open a pull request, pass CI, squash-merge to `main`, and delete the branch. Small fixes may be one-commit pull requests; live service checkouts are never editing workspaces. Data-plane events do not need pull requests, but every write has provenance and an owning project or thread.

## Status

Humanware OS is early. OpenClaw plus Slack is the supported starting path. Alternative harnesses and channels are selectable adapters, not forks of an agent. Buzz remains experimental and is not required for a reliable installation.

## License

[MIT](LICENSE).
