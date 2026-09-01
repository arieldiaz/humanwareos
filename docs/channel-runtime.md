# Channels, agents, and execution profiles

Humanware OS separates agent identity from channel, harness, model, permissions, and workspace.

Budget: 1,100 words. Over it, consolidate.

## Control plane

OpenClaw owns identity routing, canonical conversation state, adapters, tools, secrets, dispatch, delivery, and lifecycle status. Slack, Buzz, and first-party applications are replaceable adapters.

A channel adapter converts an inbound surface event into a canonical event with external account, conversation and thread identifiers, sender, explicit mentions, attachments, timestamps, and delivery capabilities. It converts the canonical response and lifecycle state back to the surface. Channel rendering never owns identity or memory.

## Identity

Liv and Max are durable identity templates with separate role, voice, authority, memory scope, and channel account. An instance may overlay names and private preferences. Identity does not select one permanent harness or model.

Both identities receive the same approved execution-profile catalog unless an explicit security boundary narrows one. A profile difference must be visible policy, not an incidental command-line flag hidden in one agent definition.

## Execution profile

An execution profile binds runtime, harness, model, reasoning, permissions, session mode, timeout, data scope, tools, worktree policy, and delivery.

Profiles are supported pairs, not an unrestricted model-by-harness matrix. Each harness exposes only supported models. Either identity can select any instance-allowed profile.

The reference defaults Liv to Cursor/Grok and Max to Codex/Sol; high-reasoning variants are escalation profiles. Native OpenClaw becomes selectable only after its packaging, permissions, state, and context behavior are proven for the workload.

Removing, replacing, or simplifying dispatch infrastructure does not authorize a profile-policy change. Preserve each identity's default profile, escalation profile, and allowlist unless the human approves those values as a separate decision. Encode the approved tuple in the reference template, renderer regression tests, instance configuration, and deployment verification so an implementation refactor cannot silently rewrite policy.

A profile declares reasoning and fast-mode defaults. Ordinary interaction targets a useful first response within 20 seconds; coding, research, architecture, high-stakes work, and explicit depth use escalation. Fast mode changes latency, not permissions or privacy.

## Dispatch and switching

Each identity has one default profile, one optional escalation profile, and an allowlist. An adapter may bind approved conversations to the default ACP profile only through concrete conversation identifiers; an account-wide or wildcard binding is not equivalent. A native route remains the fallback for new or unclassified conversations. Instance policy must exclude conversations whose privacy tier is outside the external harness profile.

OpenClaw remains owner of the conversation when it delegates a task to an external harness. The task receives an isolated worktree and a structured handoff containing objective, conversation root, agent identity, decisions, source references, branch, changed files, tests, and unresolved questions.

Short work runs inline. Longer work is acknowledged promptly, then runs as a durable escalation task. A long coding conversation may bind its thread to persistent ACP; channel-wide bindings are exceptional because they couple delivery, permissions, model, and startup to one harness.

Switching profiles creates a handoff event; it does not pretend two harness session stores are one transcript. The visible response signature records the effective agent, model, harness, reasoning, and runtime for that message.

A direct human request to change model, harness, reasoning, or fast mode is control-plane input, not conversational advice. Apply and verify the requested switch before content work or other tool use in that turn, then continue under the effective profile. If the switch is unavailable, state the exact constraint before continuing. Never acknowledge the switch while leaving the old profile active, and never defer an explicit switch behind the work it was meant to govern.

The adapter detects profile intent before resolving a bound session or dispatching any harness. It parses ordinary language against the selected identity's allowlisted profile catalog and stable aliases, including requests to use a named harness, model family, reasoning level, fast mode, escalation profile, or identity default. An unambiguous request produces one canonical target profile; an ambiguous or disallowed request does not mutate routing and asks one concise question or states the policy constraint.

Switching is one atomic control-plane operation: resolve the canonical conversation, persist the target profile binding, create a structured handoff from canonical channel history and current memory, verify the effective runtime tuple, and only then dispatch the user's remaining work. The old harness cannot approve, simulate, or perform its own replacement. A failed bind or verification leaves the prior binding intact and reports the failure without running the requested work under the wrong profile.

Natural language is the product interface. Slash commands and administrative APIs may remain diagnostics and recovery controls, but documentation and agents never present them as the normal answer to a missing control-plane capability. The implementation has one shared profile-intent resolver used by every channel adapter; channel-specific regexes, prompt instructions, and harness-local switching branches are defects to remove.

Acceptance covers Liv and Max symmetrically across every allowlisted profile: switch from native or bound Cursor to Codex, from native or bound Codex to Cursor, change reasoning within a harness, return to the identity default, reject a disallowed profile without mutation, preserve the complete thread handoff without duplicate current messages, and prove from the delivered response signature that the first content response used the requested profile. Regression tests assert that no content harness receives the control request before the binding commits.

## Permissions

Permissions belong to profiles, not personalities. Reference levels are read-only, standard-write inside an isolated worktree, and explicitly elevated. Flags equivalent to force, trust, approve-all, or unsandboxed execution cannot be a hidden permanent default for one identity.

The control plane verifies the profile's data and tool scopes before dispatch. Selecting a coding harness does not grant raw evidence access, and selecting any model does not grant production mutation.

## Delivery

Every execution path returns one canonical final response to the control plane. The adapter owns surface publication and appends provenance after confirmed delivery. An external harness does not independently call a Slack or Buzz send tool unless the profile explicitly declares that transport and prevents duplicate delivery.

Mid-turn progress is structured session-ledger telemetry. Conversation adapters render only a bounded acknowledgement, a genuine blocking question, and the final summary; internal narration and hidden harness finals never replace it.

## Health

Health is measured per boundary: adapter connection, control-plane stability, identity routing, profile availability, headless model authentication, workspace access, tool policy, and delivery. One optional harness or channel may be degraded without marking the agent core unavailable. A canary names the selected identity and profile, effective reasoning and fast mode, first-response latency, and delivered provenance so a healthy native check cannot mask a broken ACP route.
