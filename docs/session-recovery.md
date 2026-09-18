# Session recovery

The control-plane contract for recovering an interrupted agent run without replaying stale authority or uncertain external effects. Execution-profile selection remains in [Channels, agents, and execution profiles](channel-runtime.md); authority semantics remain in the [Permission model](permission-model.md); session storage remains in the [Data plane](data-plane.md); host and gateway restart remain in [Runtime](runtime.md). Those documents link here rather than restating this contract.

Status: proposed for implementation. Budget: 1,500 words. Over it, consolidate.

## Decision

Restart recovery is a new control-plane execution with origin `recovery`, not a continuation of the interrupted run's authority. It may reconstruct state, reason over read-only evidence, append normalized recovery events through the session service, and return one canonical response for idempotent delivery to the originating conversation. It cannot mutate source, data, operational control state, schedules, external systems, or approval state.

The control plane installs the recovery capability envelope before invoking any model or harness. Prompts, memories, transcripts, tool output, execution-profile metadata, and prior approvals cannot widen it. If the control plane cannot prove the recovery origin, originating destination, durable checkpoint, or effective capability envelope, it does not dispatch the recovery run.

This is a negative-capability boundary: an implementation may provide fewer recovery capabilities, never more. A fresh verified human event creates a new interactive run when additional authority is required; it does not upgrade the recovered run in place.

## Recovery classification

The reconciler reads the canonical session ledger and classifies the interrupted run from durable events, not from assistant prose, process state, or a harness transcript alone.

- **Reconstructable:** No external effect was prepared or started after the last durable checkpoint. Recovery may inspect allowed evidence and produce a response.
- **Effect uncertain:** An external effect was proposed, awaiting approval, prepared, dispatched without a durable receipt, or otherwise cannot be proven complete. Recovery records `needs_human_reauthorization` and does not execute, retry, complete, cancel, or compensate for that effect.
- **Report only:** A durable receipt proves the external effect completed, but no canonical response was recorded. Recovery may compose a report grounded in that receipt without invoking the effect again.
- **Delivery only:** The canonical response is durably recorded but confirmed delivery is absent. The adapter may retry that exact response to the exact originating destination with the original delivery idempotency key.
- **Terminal:** Durable evidence already proves completion, failure, cancellation, or confirmed delivery. Recovery performs projection repair if necessary but does not invoke the agent or publish another response.

Ambiguity resolves to `effect uncertain`. Absence of a receipt is not evidence that an effect did not happen. A process exit, timeout, stale `running` row, or gateway restart is a reason to reconcile state, never sufficient authority to repeat work.

## Capability envelope

A recovery run may use only capabilities supplied by a dedicated recovery profile:

- read the canonical events for the interrupted logical session and bounded source references already authorized for that session;
- read explicitly declared non-secret operational health needed to explain the interruption;
- use model inference to classify the situation or compose the canonical response;
- request that the session service append normalized recovery status, fault, and terminal events;
- return one canonical response to the control plane for delivery to the original channel, account, conversation, and thread.

A recovery run never receives:

- shell, arbitrary process execution, file edit, patch, package-manager, browser-control, or general network tools;
- write access to source repositories, workspaces, the data plane, runtime state, service definitions, or `operations/control`;
- deployment, restart, scheduler, cron, subagent, app, connector, or mutating MCP tools;
- an approval-minting or approval-consumption capability;
- a general message tool, a destination selector, or permission to publish outside the originating conversation;
- credentials that are unnecessary for read-only reconstruction and origin-bound delivery.

The session service and channel adapter perform their narrow writes on the recovery run's behalf. Those services validate the origin, event schema, destination, idempotency key, and allowed transition; the model does not receive their underlying filesystem or transport credentials.

## Authority and reauthorization

Conversation authority and technical approval expire at the interrupted execution boundary unless a separate authority contract explicitly proves otherwise. In the initial implementation, no mutating authority crosses that boundary.

For `effect uncertain`, the control plane records the internal recovery result `needs_human_reauthorization` and presents the exact unresolved action, last proven state, possible side effects, and originating request in the original conversation. This result does not add a new human-visible lifecycle value; the adapter renders the existing truthful handoff from the [Status framework](status-framework.md). A verified human response may create a fresh interactive run with a new run identifier and the normal profile-selection and approval flow. Silence, an agent-authored message, a scheduled wake, or recovery's own request cannot satisfy reauthorization.

Approval records are inputs to independent enforcement, not writable session artifacts. Recovery may report that an approval existed or expired, but it cannot create, rewrite, refresh, move, consume, or infer one. Text such as `approvedBy`, regardless of its source, is not proof of authority.

## External effects and delivery

Every externally visible effect needs a stable effect identifier and durable transitions that distinguish preparation, dispatch, and confirmation. The eventual effect broker may reconcile provider state or return a previously confirmed result, but a model-driven recovery run does not retry an uncertain effect. This spec does not claim exactly-once execution from a transcript; it requires at-most-once automatic recovery until an idempotent effect contract exists.

Channel delivery is the sole permitted recovered effect. It is safe only when the canonical response body, originating destination, and delivery idempotency key were durably recorded. A retry sends that exact payload through the adapter; recovery cannot revise the content, select another destination, or add a second final. A confirmed receipt makes later retries no-ops.

A working acknowledgement means the control plane durably accepted a run. It does not prove that a harness started or that a recovered mutation will continue. If recovery pauses for reauthorization, the adapter replaces stale working state with the truthful handoff rather than leaving the thread apparently active.

## Evidence and observability

Each recovery attempt records the logical session, interrupted run, recovery run, execution origin, effective recovery-profile revision, last durable event, classification, denied capability attempts, resulting state, and delivery receipt or reauthorization handoff. Raw harness traces remain evidence and never override the normalized ledger.

Operators must be able to distinguish no dispatch, reconstructing, awaiting reauthorization, delivery retry, projection repair, and terminal no-op without opening a model transcript. Recovery failures must not be reported as ordinary model latency.

## Acceptance

Implementation is not complete until automated tests prove:

1. A recovered run that asks directly or indirectly for shell, file writes, network access, scheduling, a deployment, or an approval operation is denied before the capability reaches the harness.
2. Writing an approval-shaped file or launching an independent child process is impossible because recovery receives neither filesystem mutation nor process execution.
3. A pending, prepared, dispatched-without-receipt, expired-approval, or otherwise uncertain effect becomes `needs_human_reauthorization` without replay.
4. A confirmed effect with no response produces a receipt-grounded report without repeating the effect.
5. A durably recorded response with no receipt is delivered at most once to the original conversation, and a confirmed receipt makes recovery a no-op.
6. A terminal session is not reinvoked even when stale process or projection state says `running`.
7. Prompt text, memory, prior profile settings, and harness resume arguments cannot widen the recovery envelope.
8. Missing or malformed origin, destination, checkpoint, profile, or idempotency evidence fails closed and produces an operator-visible fault.
9. The incident path in which a recovered Slack turn manufactures restart approval and starts a deployment is reproduced as a regression fixture and blocked at the first requested mutation.

Production acceptance uses an isolated or shadow gateway with no user sessions. It verifies the exact restart-recovery ingress, effective capability profile, state transition, original-thread handoff, and absence of mutation; a neighboring interactive canary is not substitute evidence.

## Rollout and non-goals

Rollout first adds origin and classification telemetry, then exercises strict recovery in an isolated gateway, then enables the recovery profile in production, and finally removes the legacy full-authority recovery path. Instrumentation may precede enforcement briefly, but production mutation replay is never an acceptable compatibility fallback.

This spec does not design cryptographic approval capabilities, the general external-effect broker, deployment supervision, hermetic rollback, scheduled-run authority, or the complete session state machine. Those changes may build on this boundary, but none is required to remove mutation authority from restart recovery.
