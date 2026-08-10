# Architecture

Humanware OS is a file-based operating layer for durable human-agent
relationships. The framework defines the rules and primitives; a private
instance holds one person's strategy, memory, agents, and machine-specific
configuration.

This document explains how the theory in the README becomes a running system.
For installation, use [Getting Started](getting-started.md).

## System shape

The current reference path is:

```text
Human
  │
  ▼
Slack ──► OpenClaw gateway ──► durable agent ──► files and tools
  ▲                                  │
  └──────────── thread reply ◄───────┘
```

The agent reads a private Humanware OS instance as its durable context. OpenClaw
provides the model runtime, messaging channels, tool access, sessions, and
background service. Slack is the current conversation surface, not the source
of the system's identity or memory.

Buzz is a future interface/runtime bundle under evaluation. The architecture
keeps the conversation surface replaceable so the durable system survives a
change from Slack to Buzz or another channel.

## Framework and private instance

Humanware OS uses two connected repositories:

- The **framework** is public and generic: operating rules, skills, templates,
  contracts, and reusable scripts.
- The **private instance** contains the person's real strategy, curated memory,
  derived work, agent configuration, and machine-specific setup.

The installer preserves shared Git history, keeps the framework as `upstream`,
and optionally creates a private `origin`. Framework improvements merge down;
personal content never merges up. Structural improvements return only after
they are deliberately extracted and genericized.

See [Adopting Humanware OS](adopt.md) for the complete Git model.

## Context stack

An agent's working context is assembled from a small durable stack:

```text
AGENTS.md        shared operating rules and hard boundaries
STRATEGY.md      who this is for and what matters now
agents/*.md      role, voice, ownership, and decision style
memory/index.md  map to curated lessons and patterns
skills/          reusable ways of observing, deciding, acting, and reviewing
```

The order matters. Rules and strategy are stable context; task-specific files
and live conversation are nearer context. Personal facts belong in memory, not
in reusable agent definitions.

## Durable agents and skills

An agent is a continuing relationship with a stable remit. A skill is a
temporary operating mode or workflow the agent uses. This avoids creating a
new identity for every task while still allowing specialized behavior.

The reference instance uses two agents—one for personal life and system
cadence, one for work and strategy—but the minimum useful system is one agent
with a clear domain. Additional agents should exist only when the boundary
creates real clarity or access isolation.

## The operating loop

Humanware OS uses an editable loop:

```text
observe → orient → decide → act → review → compound
```

- **Observe** appends raw input without reorganizing history.
- **Orient** connects the situation to strategy and memory.
- **Decide** commits to a direction and a definition of done.
- **Act** changes the world in proportionally verified steps.
- **Review** compares intent with evidence.
- **Compound** updates the durable layer with what should survive.

The loop is a shape, not a required ceremony. Small work can collapse several
steps; meaningful lessons still feed back into the system.

## Human-agent handoff

Every active item has one lifecycle state:

- 🔄 the agent is working.
- ❓ the human owes an answer or judgment.
- ✋ the human owes an action requiring identity, access, or hands.
- 🗓️ the item will resurface at a real scheduled time.
- ✅ the human has confirmed the outcome is complete.

The state appears on the conversation thread and in the agent's closing reply.
This makes ownership legible without opening every conversation.

During installation the same boundary applies. Agents perform safe file,
terminal, API, and UI work. Humans own account creation, authentication,
consent, secret entry, and consequential decisions.

## Data layers and privacy

The system separates source events from interpretations:

```text
Tier 0  stream                 raw, append-only, local network only
Tier 1  derived/               replaceable interpretations, local by default
Tier 2  memory/ + strategy     curated context for normal agent work
```

The stream lives outside the Git repository. Raw audio, video, images, and
exports are processed by local models unless the human explicitly supplies a
specific item to another context. `derived/` can be regenerated as models
improve. `memory/` stays small, curated, and version-controlled.

This is the core bet: capture is write-once; understanding is rerunnable.

## Runtime and host

The reference runtime is OpenClaw on an always-on Apple Silicon Mac:

- The gateway connects models, channels, sessions, and tools.
- The private Humanware OS repository is the agent workspace.
- A background service keeps the gateway available.
- A dedicated host can grant controlled terminal, browser, and desktop access,
  letting the agent drive setup and ongoing operations.

A MacBook can run the system, but sleep, travel, and competing interactive work
make it a weaker server. The extended reference topology uses a MacBook for
capture, a Mac mini as the canonical compute/store, and a NAS plus offline or
offsite media for backup.

## Conversation surface

Slack is the supported starting surface:

- Free is sufficient for the first setup.
- Socket Mode is outbound and works behind home NAT.
- Threads map cleanly to work items and lifecycle state.
- The surface is familiar enough that the operating system does not create a
  second behavioral inbox.

Slack history retention is not durable memory. Important context compounds into
the private instance; optional local export can preserve the raw conversation
history.

Buzz is strategically attractive because it can bundle open chat, identities,
git, and agent-native primitives. It remains too finicky to be the default
installer today, so no core Humanware OS component depends on it.

## Secrets and trust domains

Doppler is the reference secrets manager and the only source of truth for
credentials. The runtime receives secrets at launch; values never enter repo
files, chat, logs, commits, or task descriptions.

Separate projects or trust domains scope credentials to the consumers that need
them. Each agent should receive read-only access to its own credentials and
fail to read another agent's domain. A tiny bootstrap credential may live in a
mode-600 file outside the repo to unlock the manager.

The complete contract is in [The secrets layer](../infra/secrets/runbook.md).

## Cloudflare and public artifacts

Cloudflare and a domain are part of the complete reference system, not the core
Slack transport. They provide:

- Stable URLs for agent-created artifacts and dashboards.
- DNS and TLS for services intentionally exposed beyond the host.
- A clear boundary between private agent operation and shareable output.

The first Slack conversation does not require either because Socket Mode needs
no inbound URL. Keeping this layer optional during bootstrap shortens the path
to a working agent without weakening the full architecture.

## Failure boundaries

The end-to-end path crosses several independent layers:

```text
channel → gateway → routing → model auth → agent workspace/tool → delivery
```

A visible error often names only the last surface that reported it. Diagnosis
starts with evidence from each boundary rather than assuming a Slack error came
from Slack or a model error came from the agent prompt.

Every important setup step ends with a check that tests the real handoff. A
running process is not proof that a message can travel through the entire
system and return.
