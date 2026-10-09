# Channels, agents, and execution profiles

Humanware OS separates durable agent identity from conversation channel, execution harness, model, permission profile, and writable workspace.

Budget: 1,100 words. Over it, consolidate.

## Control plane

OpenClaw is the reference control plane. It owns identity routing, canonical conversation state, channel adapters, tool registration, secrets resolution, execution dispatch, delivery, and lifecycle status. Slack, Campfire, Buzz, and a first-party application are replaceable adapters around that control plane. Campfire uses one native bot per identity and a private asynchronous webhook bridge because its synchronous webhook response window is shorter than an agent turn.

A channel adapter converts an inbound surface event into a canonical event with external account, conversation and thread identifiers, sender, explicit mentions, attachments, timestamps, and delivery capabilities. It converts the canonical response and lifecycle state back to the surface. Channel rendering never owns identity or memory.

## Identity

Liv and Max are durable identity templates with separate role, voice, authority, memory scope, and channel account. An instance may overlay names and private preferences. Identity does not select one permanent harness or model.

Both identities receive the same approved execution-profile catalog unless an explicit security boundary narrows one. A profile difference must be visible policy, not an incidental command-line flag hidden in one agent definition.

A Slack thread has one in-memory lead so multiple identities cannot answer the same human turn or wake each other into a loop. A deliberate human mention switches the lead; otherwise the current lead continues, or the instance default answers when no lead is known. If a message mentions multiple agents, the current lead or default answers once. Agent-authored Slack messages are context, never triggers. A lead may ask another identity for one internal response when the human requests collaboration; that consultation does not publish independently. Restarting the control plane forgets the in-memory lead and returns the thread to the configured default until the human mentions another identity.

## Execution profile

An execution profile binds:

- runtime type and harness;
- supported model identifier;
- reasoning level;
- permission profile;
- session mode and timeout;
- data-access scope;
- tool set;
- worktree policy;
- delivery contract.

Profiles are supported pairs, not an imaginary unrestricted model-by-harness matrix. Cursor can expose the models Cursor supports; Codex can expose its supported OpenAI models; native OpenClaw can use configured providers; Pi can expose the models its adapter supports. Both Liv and Max can select any profile allowed by the instance.

The reference defaults Liv to Cursor with Grok and Max to Codex with Sol because an ordinary thread may progress from conversation through specification into implementation. Their high-reasoning variants are the escalation profiles. Native OpenClaw remains a selectable execution harness after its packaging, permissions, state paths, and context behavior are proven for the workload; it is not the reference default merely because it has fewer process and delivery boundaries.

Removing, replacing, or simplifying dispatch infrastructure does not authorize a profile-policy change. Preserve each identity's default profile, escalation profile, and allowlist unless the human approves those values as a separate decision. Encode the approved tuple in the reference template, renderer regression tests, instance configuration, and deployment verification so an implementation refactor cannot silently rewrite policy.

A profile declares its reasoning and fast-mode defaults. The ordinary interactive profile should target a useful first response within 20 seconds and use medium-or-lower reasoning unless the model has a provider-specific equivalent. Coding, research, architecture, high-stakes work, and explicit requests for depth use a separate escalation profile. Fast mode changes latency, not permissions or privacy scope.

## Dispatch and switching

Each identity has one default profile, one optional escalation profile, and an allowlist. An adapter may bind approved conversations to the default ACP profile only through concrete conversation identifiers; an account-wide or wildcard binding is not equivalent. A native route remains the fallback for new or unclassified conversations. Instance policy must exclude conversations whose privacy tier is outside the external harness profile.

OpenClaw remains owner of the conversation when it delegates a task to an external harness. The task receives an isolated worktree and a structured handoff containing objective, conversation root, agent identity, decisions, source references, branch, changed files, tests, and unresolved questions.

Short work runs inline and returns results to the owning identity. Longer work may run as a durable child task with the escalation profile, while the control plane exposes working state without a model-authored acknowledgement. A long coding conversation may explicitly bind the thread to a persistent ACP session. Permanent channel-wide ACP bindings are exceptional because they couple delivery, permissions, model choice, and startup behavior to one harness.

Switching profiles creates a handoff event; it does not pretend two harness session stores are one transcript. The run provenance records the selected harness, and the visible response signature reads it from the session's selected model rather than inferring it from the model name or provider.

A human request to change model or reasoning is control-plane input. The agent calls `switch_model` with the requested alias before any other work in that turn. The host persists the selection on the conversation's session; the rendered catalog binds every allowed model to its harness, so the harness follows. The switch applies from the next turn, and the agent says so in one line. If the model is outside the allowlist, the tool names the allowed ones and the agent states that constraint. The human may also use OpenClaw's native `/model` and `/think` commands.

## Permissions

Permissions belong to profiles, not personalities. Reference levels are read-only, standard-write inside an isolated worktree, and explicitly elevated. Flags equivalent to force, trust, approve-all, or unsandboxed execution cannot be a hidden permanent default for one identity.

The control plane verifies the profile's data and tool scopes before dispatch. Selecting a coding harness does not grant raw evidence access, and selecting any model does not grant production mutation.

## Delivery

The adapter owns surface publication and appends provenance after confirmed delivery. An external harness does not independently call a Slack or Buzz send tool unless the profile explicitly declares that transport and prevents duplicate delivery.

### Conversation lifecycle

[status-framework.md](status-framework.md) is the single lifecycle contract, including silence, closure, reopening, and stale-work fencing. Admission and delivery use that authority; channel adapters do not maintain a second state machine.

## Health

Health is measured per boundary: adapter connection, control-plane stability, identity routing, profile availability, headless model authentication, workspace access, tool policy, and delivery. One optional harness or channel may be degraded without marking the agent core unavailable. A canary names the selected identity and profile, effective reasoning and fast mode, first-response latency, and delivered provenance so a healthy native check cannot mask a broken ACP route.
