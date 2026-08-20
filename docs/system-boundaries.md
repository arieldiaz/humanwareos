# System boundaries

Humanware OS installations have three sources of truth and one generated output. Mixing their change models is a defect.

Budget: 1,000 words. Over it, consolidate.

## The three sources

### Humanware OS framework

The public framework owns reusable behavior: global rules, domain specifications, agent templates, adapter contracts, runtime builders, validators, generic operational services, generic frontend components, schemas, tests, and migration tooling.

A change belongs upstream when another installation could benefit from it. Framework changes use branches, review, CI, and versioned releases.

### Private instance

The private instance owns one installation's selections and narrowings: framework revision, agent overlays, enabled runtime profiles, model preferences, channel/account identifiers, domain and route manifest, host inventory, secret key references, private integrations, branding, and truly instance-only plugins.

An instance must not copy generic framework files and edit them locally. It references a pinned framework revision and supplies typed overlays at declared extension points. A local compatibility patch is temporary and records its upstream issue or PR, owner, reason, and removal condition.

### Data plane

The data plane owns accumulated human and agent material: source events, memory evidence, current memory projections, strategy, conversations, working documents, artifacts, media, records, and derived indexes. It uses append, version, provenance, retention, and backup semantics rather than pull requests.

Data is never a hidden authority for agent rules. When accumulated evidence implies a behavioral change, an agent proposes a framework or instance diff through the corresponding reviewed path.

## Generated runtime

The runtime is a deterministic assembly of a framework revision and an instance revision. It contains rendered instructions, resolved non-secret configuration, adapter registrations, frontend assets, service definitions, and a manifest of source hashes. It reads and writes the data plane at runtime. It is immutable, replaceable, and not a fourth source of truth.

## Classification test

Every new file or field answers one question:

1. Would it improve another installation? Put it in Humanware OS.
2. Does it only configure this installation? Put it in the private instance.
3. Was it observed, produced, accumulated, or worked on? Put it in the data plane.
4. Can it be rebuilt from those sources? Put it only in generated runtime or cache.

If a file answers more than one, split it. A reusable instruction plus local channel IDs is not one file. A frontend component plus generated artifact content is not one directory. A source config plus live session state is not one checkout.

## Dependency direction

```text
Humanware OS release ← private instance lock
         │                    │
         └────────┬───────────┘
                  ▼
          generated runtime ──► data plane
```

Humanware OS never imports a private instance. The instance may reference public framework identifiers but not a mutable framework checkout. Data may reference framework or instance schema versions; source repositories reference only data locations and schemas, never personal contents.

## Naming

The framework name is Humanware OS. `LifeOS`, `life-os`, and `com.lifeos.*` are legacy compatibility names and must not be introduced in new paths, services, repositories, or documentation except when naming a migration target. Existing identifiers migrate through explicit compatibility aliases and are removed after their consumers are verified.
