# Architecture

Humanware OS is the reusable framework for durable human-agent systems. An installation combines a pinned framework release, a private instance configuration, and a separately governed data plane into an immutable runtime. Conversation surfaces, model providers, and coding harnesses are adapters around that core.

Budget: 1,200 words. Over it, consolidate into the owning specification.

## System shape

```text
Humanware OS framework ─┐
                       ├─► immutable runtime ─► agent core ─► tools and data
private instance config ┘          ▲                  ▲
                                  │                  │
                        channel adapters      Ariel Data plane
                        Slack · app · Buzz     stream · memory · work
                                  │
                                  ▼
                                human
```

The framework defines behavior, interfaces, validators, builders, and reusable frontends. The instance selects and narrows those capabilities for one person. The data plane contains what that person and their agents observe, learn, and produce. The runtime is generated from framework plus instance; it is never edited as source.

The complete ownership contract is in [System boundaries](system-boundaries.md). Storage semantics are in [Data plane](data-plane.md). Build and deployment are in [Runtime and deployment](runtime.md).

## Agent core

An agent identity is a durable role, voice, memory scope, and authority boundary. It does not permanently select a channel, model, harness, checkout, or delivery implementation.

OpenClaw is the reference control plane: it owns channel connections, identity routing, conversation state, tools, secrets resolution, and execution dispatch. A native OpenClaw turn is the lowest-complexity default. Pi, Cursor, Codex, and other harnesses are selectable execution profiles for work that benefits from them. Both Liv and Max can use the same approved profile catalog.

The detailed contract is in [Channels, agents, and execution profiles](channel-runtime.md).

## Replaceable interfaces

Slack is the supported reference channel, not the architecture. Buzz and a first-party Humanware application can implement the same adapter contract. A channel adapter translates inbound identity and thread metadata into a canonical conversation event, then translates the agent's final response and lifecycle state back to the surface. Channel-specific rendering never owns agent identity or memory.

## Data and memory

The data plane separates evidence from current views:

- The stream is append-only evidence.
- Memory events are append-only learned facts, decisions, corrections, and provenance.
- Current memory and strategy are compact mutable projections over those events.
- Working documents are mutable and automatically versioned without PRs.
- Published artifact revisions are immutable.
- Derived indexes, transcripts, summaries, and caches are rebuildable.

Data does not live in either source repository. Behavioral rules never enter through memory: reusable rules change Humanware OS through review; private approved policy changes the instance through review.

## Domain surface

A complete installation has a domain surface with public and private halves. The public half explains and publishes intentionally shared work. The private half exposes dashboards, usage, tokens, sessions, security, artifacts, and operational controls to authorized clients. The framework provides the shell, route contract, deployment adapters, and access-control hooks. The instance supplies the domain, branding, enabled routes, private origin, and publication policy.

The reference Ariel installation uses `os.arieldiaz.com` for its private frontend. The same framework can run on an always-on Mac, behind Tailscale, or in a cloud deployment. See [Domain surface](domain-surface.md).

## Source and deployment flow

Humanware OS is the upstream. A private instance pins a tested framework revision and contains only instance-owned configuration or code. Generic improvements return upstream first; the instance adopts them by advancing its lock. Temporary downstream patches carry an upstream reference, owner, and expiration.

All changes use isolated task worktrees. The deployed checkout and generated runtime are read-only. A deployment builds a new runtime directory, verifies its manifest and end-to-end health, then atomically changes a `current` reference. Rollback changes that reference to the previous verified build.

## Failure boundaries

The request path crosses independent boundaries:

```text
channel → adapter → control plane → identity → execution profile → tool/data → delivery
```

A reboot adds readiness dependencies before that path: network, DNS, secrets provider, runtime build, gateway, channel credentials, and domain frontend. Supervisors should not count missing boot dependencies as application crashes. Readiness gates wait and report; health checks prove both process state and end-to-end delivery.
