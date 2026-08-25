# Execution broker and delivery ledger

Issue: [humanwareos#38](https://github.com/arieldiaz/humanwareos/issues/38)

This is the executable specification for identity-neutral routing. Liv and Max use the same broker; identity changes context and authority, never the dispatch algorithm.

## Turn contract

For every accepted channel turn the control plane MUST:

1. normalize the channel envelope and stable session key;
2. parse an optional control envelope without a model call;
3. resolve one allowlisted execution profile;
4. persist the effective profile before inference;
5. create a request-coverage ledger;
6. dispatch once through the selected runtime;
7. accept exactly one canonical final from the runtime;
8. let the channel adapter deliver that final once;
9. record confirmed delivery or a visible terminal failure.

The terminal states are `delivered`, `failed-visible`, and `cancelled-visible`. A completed run with no queued final is invalid. Model, runtime, timeout, compaction, parser, and delivery errors are visible during stabilization and MUST share the turn trace id.

## Control envelope

The first message in a Slack thread may start with a directive such as:

```text
@Liv use Cursor/Grok low, fast, concise: compare the two plans and recommend one
@Max use Codex/Sol high, detailed: review this architecture
@Liv profile=cursor-agent-low: implement the accepted change
```

The directive prefix ends at the first colon. The remainder is the user task. A directive-only message is rejected before inference. The parser recognizes an exact profile id, declared aliases, harness/model family, reasoning level, execution mode, fast mode, and response style. It never invents an unsupported model/harness pair.

Resolution precedence is:

1. explicit turn directive;
2. persisted thread profile;
3. declared channel or conversation default;
4. agent default;
5. catalog default.

A persisted thread profile is reused only while it remains enabled and allowlisted for that identity. If an instance retires a profile, the next ordinary turn upgrades to the current channel, agent, or system default instead of failing the thread or silently continuing the retired runtime.

An explicit but invalid directive fails visibly. It never falls through to another profile. A profile change appends a handoff event before the new runtime starts. The original harness transcript remains evidence; the normalized request ledger and current decisions cross the boundary.

## Profile model

An execution profile binds:

- execution mode: `general`, `task`, or `workspace`;
- runtime: `native`, `cli`, `acp`, or `app-server`;
- harness/backend and model reference;
- reasoning and fast defaults;
- permissions, workspace, data scope, timeout, and style defaults.

`general` is appropriate for questions, health, planning, research, and ordinary tool work. It does not imply a coding harness. `task` is a bounded command-style run. `workspace` owns a resumable vendor session and may use native coding tools. Cursor CLI and Codex app-server are independent runtimes behind the same profile interface. ACP is reserved for an explicitly ACP-native persistent workspace; it is not a channel-wide default.

Cursor CLI profiles use a registered CLI backend. The optional read-only `cursor-ask` backend runs `cursor-agent --mode ask --print --output-format stream-json`; the workspace backend explicitly runs `cursor-agent --mode agent` with sandbox and review policy. An instance may disallow Ask profiles on an agentic channel without changing the response style for ordinary questions. Cursor session ids are stored by OpenClaw and resumed per canonical conversation.

Codex profiles use the official OpenClaw Codex plugin and model-scoped `agentRuntime.id = "codex"`. OpenClaw remains the channel, policy, tool, and delivery owner while Codex app-server owns its native thread and compaction.

## Request coverage

The broker splits explicit bullets, questions, semicolon clauses, and additive clauses into a bounded ordered ledger. The runtime receives the ledger before the user task and is instructed to address or explicitly defer every item. Completion records store the ledger and one of `addressed`, `deferred`, or `blocked` per item when the runtime provides it. Evals MUST include one-, two-, and three-intent prompts, including three asks in one sentence.

This ledger is a completeness aid, not a new visible response template. Concise prose is still allowed if all items are covered.

## Slack projection

Slack projects lifecycle state; it is not the canonical stream. Use one native progress projection updated in place, with an identity-specific label and bounded tool progress. The final replaces the progress projection. Do not post harness JSONL, reasoning deltas, or debug logs into the thread.

Normal final delivery uses `messages.groupChat.visibleReplies = "automatic"`. A harness does not call Slack directly. `message_tool`-only delivery is prohibited because a valid final without a tool send becomes a silent drop.

The root lifecycle tile and per-message model/harness/reasoning reactions are secondary projections. They may fail without cancelling readable content, but their failures go to the operational journal.

## Canonical records

All records use one trace id:

```text
evidence/sessions/events/YYYY-MM-DD.jsonl   normalized append-only events
evidence/sessions/raw/<trace-id>.jsonl     bounded harness/event references
generated/sessions/<logical-session>.md    rebuildable human view
operations/broker/                         disposable locks and diagnostics
```

Required events are `turn.accepted`, `route.resolved`, optional `handoff.created`, `execution.started`, `execution.completed` or `execution.failed`, `delivery.queued`, and `delivery.confirmed` or `delivery.failed`. Raw provider chain-of-thought is never copied into the canonical ledger.

## Acceptance and release

The release unit follows Issue → Spec → PR → Deploy → Evals. The PR contains this spec, schemas, parser/resolver tests, backend tests, data migration, rollback, and runtime verification. Deployment requires a verified external snapshot and pre-production evals. Post-production evals must observe both Slack replies from the channel, exercise profile switches and multi-intent coverage, verify explicit failures, inspect the shared trace, restart the gateway, and sample a restore. Process health alone is not delivery proof.

The private instance implements one leased transaction: checksum-verify the external snapshot, clone the old flat data classes into a new versioned v2 layout, atomically select the `active` data pointer, build and select the immutable runtime, patch and validate OpenClaw, restart once, verify both channel accounts, and run backend/outbound canaries. Any failure before completion restores the prior runtime, config, auth database, materialized bridge files, and data pointer; it retains the new layout, snapshot, and failure evidence for diagnosis.

Backend/outbound canaries do not prove inbound Slack routing. The final release gate sends real human-authored Slack messages to Liv and Max and observes the replies in Slack. Those messages cover default routes, a first-turn directive, a persisted harness switch across restart, three intents in one sentence, and an unsupported local-model directive. The release record links the resulting canonical trace events and generated session view.
