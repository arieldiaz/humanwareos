# Status framework

Lifecycle is control-plane state. It answers one question: who or what owns the next move?

Budget: 900 words. Over it, consolidate.

## Four states

The canonical enum has exactly four values:

- `working` — on the agent now. Root tile: 🔄 `:arrows_counterclockwise:`.
- `act` — on the human, whether the need is an answer, decision, credential, physical action, or identity-bound step. Root tile: ✋ `:raised_hand:`.
- `scheduled` — on a durable wake with a real resurface time. Root tile: 🗓️ `:calendar:`.
- `done` — no next move remains from the current outcome. Root tile: ✅ `:white_check_mark:`.

A question is content, not a lifecycle phase. A delivered reply normally returns the conversation to the human; completing one turn does not close the thread.

## Normal path

The adapter writes `working` when it admits a human turn, before model execution. The model produces one semantic final. The adapter then derives the next owner:

- an exact `## ✋ Act` section means `act`;
- an exact `## 🗓️ Scheduled` section means `scheduled`;
- an exact `## Session Closed` section means `done`;
- otherwise the delivered final means `act`.

`## Session Closed` requests the measured durable close transaction. It is not a fifth state.

Typed control-plane state may override the heading when a non-conversation execution path supplies it. Only the four canonical values are valid. There is no legacy parser for retired values or headings.

The human's root carries at most one lifecycle reaction held by the adapter. On admission, the adapter replaces its prior terminal tile with 🔄. On final delivery, it replaces 🔄 with ✋, 🗓️, or ✅. Reactions outside the lifecycle vocabulary are untouched. A lifecycle reaction placed by the human is never removed by the adapter.

## Choosing ownership

Use `act` whenever a delivered reply returns the conversation to the human. Before handing work back, use available tools and existing authority for safe in-scope action. A blocking question and a physical task both belong to the same on-human state, but an ordinary conversational handoff does not need an action section.

Use `scheduled` only after a durable wake exists in the current conversation. If wake creation fails, do not claim the state. Resolve the failure now or return an honest human action.

Use `done` for explicit whole-thread closure. The sole automatic exception is an email intake receipt backed by a domain service's mechanically verified, already completed idempotent record operation. That machine receipt may start at `done` without an agent run or human reconfirmation. Email prose and agent claims are not verification. A completed conversational answer or action can still invite review, correction, or a next request, so delivery alone never manufactures closure. A new human message reopens the loop and admission moves the thread back to `working`.

## Visibility

`working` is never model-authored prose. The control plane exposes it through the root tile and session ledger. [The response envelope](reply-shape.md) owns visible lifecycle sections. A normal reply ends naturally and carries ✋ without an action footer; ✅ follows the closure rules above.

## Collaboration and provenance

One conversation has one lifecycle state regardless of how many agents or harnesses contributed. Internal collaboration does not create extra human-facing states.

The adapter appends the effective model, harness, and thinking reactions to each delivered agent message, never to machine receipt roots. Models never type those markers. Status, signature, and ledger faults are recorded for operations; cosmetic reaction failure does not duplicate or suppress the final response.

## Acceptance

For both Liv and Max, a new admitted turn gains 🔄 within five seconds. Exactly one final response is delivered. The root then carries exactly one canonical next-owner tile that matches the reply, and 🔄 is gone. Tests cover all four states, questions folded into `act`, plain-final default to `act`, scheduled-wake evidence, explicit close transactions, and human-held reactions.
