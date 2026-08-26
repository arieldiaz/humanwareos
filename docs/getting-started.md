# Getting Started

This guide creates one Humanware OS installation and verifies a real conversation through a channel adapter. The finish line is an agent whose identity survives model, harness, interface, and host changes because those concerns are configured separately.

## 1. Prepare the host and accounts

The reference host is an always-on Apple Silicon Mac. You need Git, `jq`, a supported model or subscription, a secrets manager, and a channel. GitHub CLI is recommended for the private instance. Slack plus OpenClaw is the supported first channel; neither is part of the core architecture.

For the complete reference setup, add a Cloudflare-managed domain. Its public half can describe the system or publish selected artifacts. Its private half can expose status, usage, tokens, design review, and artifact modules from the local host. A later cloud deployment uses the same route manifest.

## 2. Create the three sources

Run the installer from a Humanware OS checkout:

```bash
./install.sh /absolute/path/to/my-instance --repo OWNER/my-instance
```

It creates or resolves these independent roots:

- a public Humanware OS checkout pinned by `humanware.lock.json`;
- a private instance repository containing configuration only;
- an external data plane containing stream, memory, strategy, sessions, workspaces, and artifacts;
- a generated runtime root containing immutable builds and the active `current` symlink.

The runtime is output rather than a fourth source. The installer validates the boundaries and prints the exact paths.

## 3. Configure the first agent

Edit the private instance, not the framework. Start with one agent overlay under `agents/`, and keep it narrow: local role, private relationships, approved tone differences, and trust limits. Generic identity behavior belongs upstream in Humanware OS. Personal facts and evolving context belong in the data plane.

Fill the first honest strategy at `<DATA_ROOT>/current/strategy/current.md` and the compact memory index at `<DATA_ROOT>/current/memory/index.md`. Do not commit either file.

The instance's `runtime/profiles.json` separates identity from execution. Give each equivalent agent the same allowed profiles unless a documented trust boundary requires a difference. The selected default profile is rendered directly into the agent configuration before activation. A direct provider may be the general default; Cursor CLI, Codex app-server, ACP, OpenCode, and Pi are supported profiles rather than permanent identities.

Validate the configuration and build a new runtime:

```bash
/absolute/path/to/humanwareos/scripts/validate-instance.sh /absolute/path/to/humanwareos /absolute/path/to/my-instance
/absolute/path/to/humanwareos/scripts/build-runtime.sh /absolute/path/to/humanwareos /absolute/path/to/my-instance --activate
```

## 4. Establish secrets without secret files

Doppler is the reference provider. The instance stores provider and key identifiers only. A background service may keep one mode-600 bootstrap token outside Git and use it to hydrate its environment at launch. Never put real values in `.env`, JSON configuration, instructions, logs, memory, commits, or chat.

Prove both access and isolation: each intended consumer can read the key names it needs, and cannot read another trust domain.

## 5. Install the runtime controller

OpenClaw is the current native runtime. Install the current stable release using its official instructions, then configure its workspace and instruction paths from the generated runtime's `current` link. Do not point a daemon at a feature worktree or mutable repository checkout.

For each OpenClaw agent, render the harness-required context files into the immutable runtime and materialize byte-identical regular-file projections with `scripts/materialize-openclaw-workspaces.mjs`; OpenClaw deliberately rejects workspace symlinks during prompt assembly. Generated `MEMORY.md` and `STRATEGY.md` bridge files name the scoped data-plane projections without copying personal facts, while the instance indexes those canonical paths for recall. The materializer archives replaced bootstrap files and supports transactional restore.

Verify provider login and local execution before adding a channel. The agent should be able to state its framework identity, private overlay, current strategy, selected execution profile, and data root from the assembled runtime.

## 6. Add Slack as the first adapter

Create one Slack app/account for each durable agent, use Socket Mode, and store credentials in the secrets provider. Set `channels/slack.json` to enabled only after credential probes pass. The adapter owns transport; OpenClaw owns thread routing; Humanware OS owns reply and lifecycle semantics.

Restart the controller cleanly and verify the entire path:

```text
Slack inbound → adapter → OpenClaw → identity → execution profile → tool or data access → Slack thread reply
```

A running process is not proof. Send a mention, require one harmless strategy read and one harmless local command, and confirm the reply lands in the same thread for every configured agent.

## 7. Add the domain surface

Configure `surfaces/domain.json` in the instance. The framework supplies module contracts and the frontend shell. The instance supplies the public and private origins, enabled routes, data selectors, deployment adapter, and network policy.

Verify public routes from the public internet and private routes from the approved private network. Status, usage, token, design, and artifact modules must render degraded states when an upstream source is unavailable; one failing module must not take down the shell.

## 8. Make reboot readiness a release gate

Every daemon reads the immutable runtime through `current`, waits for network and DNS readiness, receives credentials at launch, writes logs outside source repos, and has a bounded restart policy. Disable interactive desktop dependencies and unrelated login items on a headless host.

Test a real reboot. Acceptance requires SSH, the runtime controller, each enabled channel account, the domain surface, and its upstream health checks to recover without logging into a GUI, unlocking a keychain by hand, restoring an application session, or editing a checkout.

## 9. Operate without drift

Framework change: isolated Humanware worktree → pull request → CI → squash-merge → update the instance lock.

Instance change: isolated instance worktree → pull request → CI → squash-merge → build and activate a new runtime.

Data change: append an event or version a workspace object → update a current projection when useful. No pull request is required.

Rollback changes only the runtime `current` symlink to a previously verified build. It never rewrites source or deletes data.
