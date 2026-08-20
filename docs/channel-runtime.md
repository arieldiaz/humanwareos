# Channels, agents, and execution profiles

Humanware OS separates durable agent identity from conversation channel, execution harness, model, permission profile, and writable workspace.

Budget: 1,100 words. Over it, consolidate.

## Control plane

OpenClaw is the reference control plane. It owns identity routing, canonical conversation state, channel adapters, tool registration, secrets resolution, execution dispatch, delivery, and lifecycle status. Slack, Buzz, and a first-party application are replaceable adapters around that control plane.

A channel adapter converts an inbound surface event into a canonical event with external account, conversation and thread identifiers, sender, explicit mentions, attachments, timestamps, and delivery capabilities. It converts the canonical response and lifecycle state back to the surface. Channel rendering never owns identity or memory.

## Identity

Liv and Max are durable identity templates with separate role, voice, authority, memory scope, and channel account. An instance may overlay names and private preferences. Identity does not select one permanent harness or model.

Both identities receive the same approved execution-profile catalog unless an explicit security boundary narrows one. A profile difference must be visible policy, not an incidental command-line flag hidden in one agent definition.

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

The reference defaults both agents to native OpenClaw for ordinary conversation. Native execution has the fewest process and delivery boundaries. Pi is a candidate first-party default after its adapter, packaging, permissions, and state paths are reproducible. Cursor and Codex are approved task harnesses for coding, review, and other specialized work.

## Dispatch and switching

OpenClaw remains owner of the conversation when it delegates a task to an external harness. The task receives an isolated worktree and a structured handoff containing objective, conversation root, agent identity, decisions, source references, branch, changed files, tests, and unresolved questions.

Short work runs as a child task and returns results to the owning identity. A long coding conversation may explicitly bind the thread to a persistent ACP session. Permanent channel-wide ACP bindings are exceptional because they couple delivery, permissions, model choice, and startup behavior to one harness.

Switching profiles creates a handoff event; it does not pretend two harness session stores are one transcript. The visible response signature records the effective agent, model, harness, reasoning, and runtime for that message.

## Permissions

Permissions belong to profiles, not personalities. Reference levels are read-only, standard-write inside an isolated worktree, and explicitly elevated. Flags equivalent to force, trust, approve-all, or unsandboxed execution cannot be a hidden permanent default for one identity.

The control plane verifies the profile's data and tool scopes before dispatch. Selecting a coding harness does not grant raw stream access. Selecting a local model does not grant production mutation.

## Delivery

Every execution path returns one canonical final response to the control plane. The adapter owns surface publication and appends provenance after confirmed delivery. An external harness does not independently call a Slack or Buzz send tool unless the profile explicitly declares that transport and prevents duplicate delivery.

Mid-turn progress is structured telemetry. Adapters may render bounded progress when the surface supports it; internal narration and hidden harness finals never silently replace the final response.

## Health

Health is measured per boundary: adapter connection, control-plane stability, identity routing, profile availability, model authentication, workspace access, tool policy, and delivery. One optional harness or channel may be degraded without marking the agent core unavailable. A canary names the selected identity and profile so a healthy Liv-on-native check cannot mask a broken Liv-on-Cursor route.
