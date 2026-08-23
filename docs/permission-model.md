# HumanwareOS permission model

Status: v0.1. Budget: 1,400 words. Applies to agents, harnesses, connectors, host services, and operating-system privacy grants.

## Decision

HumanwareOS owns the explanation and review of every capability used on a person's machines. Operating-system dialogs are enforcement surfaces, not the source of truth. A grant is acceptable only when a human can answer, in plain language: **who is asking, what exact capability they want, what they will use it for, what data or device is in scope, and when it will be reviewed.**

An opaque runtime label such as `node`, `python`, `bash`, or `osascript` is never an acceptable HumanwareOS-facing identity. When the operating system cannot display the owning product, HumanwareOS resolves the executable to the owning service and presents that owner alongside the raw system identity. A native signed component is preferred when a persistent process genuinely needs a privacy grant; blanket grants to a shared runtime are denied.

## Permission record

Every requested or existing capability has one canonical record with these fields:

- **Actor:** stable HumanwareOS identity, such as `OpenClaw Gateway`, `HumanwareOS Capture`, a browser, or the operating system's remote-login service.
- **System identity:** executable path, bundle identifier, signing identity, service-manager label, and parent process. This is evidence, not the display name.
- **Capability:** the user-legible action, such as `control the interface`, `record the screen`, `read protected files`, `discover devices nearby`, or `reach devices on the local network`.
- **Scope:** the narrowest data, folders, devices, applications, accounts, or network segment involved.
- **Purpose:** one sentence naming the feature that breaks if denied. “Required for operation” is not a reason.
- **Decision:** `allow`, `deny`, `allow while in use`, or `remove`.
- **Authority:** who approved it and where the decision was made.
- **Evidence:** first request, last use, owning process, and the verification that proved the feature needs it.
- **Review:** expiration or next review date. Persistent high-impact grants are reviewed quarterly and after any runtime or signing change.

## Capability classes

1. **Observe** — read non-sensitive operational state. Default allow when local and auditable.
2. **Read private data** — protected files, contacts, calendars, photos, mail, browser secrets. Default deny; require item or domain scope.
3. **Capture** — screen, system audio, microphone, camera. Allow only to a named capture feature, visibly invoked or explicitly always-on.
4. **Control** — Accessibility, Automation, application management, synthetic input. High impact; allow only to a named, signed owner with a tested revoke path.
5. **Reach** — Bluetooth, local network, inbound listeners, external services. Default deny until the destination or device and feature are named.
6. **Administer** — Full Disk Access, system settings, software install or delete, SSH. Exceptional; no shared interpreter or general runtime receives this class.

## Ask format

HumanwareOS asks in one consistent shape:

> **HumanwareOS Capture wants to record the screen**  
> To let your agent inspect a window during a desktop task you explicitly requested. Applies only to the current computer session. No background use. Review quarterly. **Allow / Deny**

The name states the owner, the verb states the capability, and the reason states the user-visible feature. Product names, feature names, and reasons remain stable across chat, the security inventory, setup documentation, and the operating system where the platform permits it.

## Conversation authority

An explicit request authorizes reversible work inside the selected execution profile's declared workspace and data scope. That authority travels with the task; the agent does not ask again before creating or updating the requested working document or artifact. The enforcement layer still blocks paths and capabilities outside the profile.

Irreversible, outward-facing, costly, elevated, or newly private access requires a real decision under the format above. If a harness produces a technical approval request, the control plane either resolves it from existing profile authority or presents the exact actor, capability, scope, and consequence. The agent never paraphrases it as “allow that write,” invents an approval after failure, or treats conversational permission as a substitute for an enforceable grant.

## Surfaces and privacy

An instance's private security surface is the canonical human-readable inventory. It shows one row per Actor × Capability, the current decision, reason, scope, evidence, and review date. Raw operating-system rows remain available behind each record for diagnosis. New or changed grants appear in a recurring security diff and any unexplained grant is a finding, not a silent count.

Public HumanwareOS documentation explains the model and examples but never exposes an instance's installed applications, paths, hostnames, or grant history.

## Clean-identity migration

1. Inventory current operating-system grants and resolve each raw client to a live process, persistent service, signing identity, and HumanwareOS actor.
2. Remove stale disabled rows and revoke grants with no verified feature dependency.
3. Package persistent privileged features as narrowly scoped, signed components. Do not merely rename or copy a runtime binary: identity must survive upgrades and be verifiable by code signature.
4. Reset the old runtime-scoped grants, request only the capabilities each component needs, and verify the user-visible operating-system names.
5. Capture every relevant permissions pane after restart and compare it with the canonical inventory.
