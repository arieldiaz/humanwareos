# Upstream bug report: message_tool_only silently discards produced replies

Draft for an OpenClaw issue. Observed on OpenClaw 2026.7.1-2 (macOS arm64,
Slack channel, claude-cli harness). File against the gateway/dispatch area.

## Summary

When a session's `sourceReplyDeliveryMode` resolves to `message_tool_only`
and the agent produces final text without calling the message tool, the
gateway discards the reply with only a WARN
(`visible channel turn dispatched with no queued reply payloads`). The user
sees the turn's ack/status reactions and then nothing — from their side the
agent "worked and never answered." The agent's transcript shows a completed
turn with a reply, so the failure is invisible from the inside too.

## Where the mode comes from

`message_tool_only` is not only opt-in config; the runtime forces it in at
least three code paths:

- restart-recovery resumes (`server-restart-sentinel`:
  `replyOptions: { sourceReplyDeliveryMode: "message_tool_only" }`)
- subagent completion announces (`openclaw-tools`, agent steps with
  `deliver: false`)
- heartbeat turns (`heartbeat-runner`, when the heartbeat response tool is
  forced)

So a session can enter this mode without any operator configuration —
notably right after a gateway restart, which is exactly when an agent is
most likely to reply with plain text (its in-flight tool context was lost).

## Why the existing fallback does not cover it

`dispatchReplyFromConfig` computes `noVisibleReplyFallbackEligible` on its
result when a turn ends with nothing visible. But the only consumer,
`shouldSendNoVisibleReplyFallback`, lives in the Feishu extension
(`extensions/feishu/src/bot.ts`) — no other channel has the fallback — and
it explicitly returns false when
`dispatchResult.sourceReplyDeliveryMode === "message_tool_only"`. The mode
with the highest risk of a produced-but-undelivered reply is the one mode
the safety net excludes, and the channel coverage is Feishu-only besides.

## Repro

1. Slack channel session on any CLI harness, delivery mode
   `message_tool_only` (easiest: interrupt the gateway mid-turn and let
   restart recovery resume the session).
2. Have the agent answer in plain final text without calling the message
   tool.
3. Turn completes; log shows the zero-payload WARN; nothing is posted.

## Incident data (2026-07-24)

User pinged agent in a Slack channel ("you here?"); agent's session
transcript ends with assistant text "Yep, here. …"; gateway logged
`visible channel turn dispatched with no queued reply payloads`; nothing
reached Slack. Reported by the user as "the agent looks like she's working
but never posts."

## Suggested fix

In the final-reply suppression branch of `dispatchReplyFromConfig`, deliver
the payload instead of dropping it when all of:

- `sourceReplyDeliveryMode === "message_tool_only"` and send policy allows
- no message-tool delivery was observed this turn (`observedReplyDelivery`
  is already tracked and is set by the agent runner precisely on a committed
  message-tool send, so well-behaved turns cannot double-post)
- the turn is a user turn (exclude `heartbeat`/`cron-event`/`exec-event`
  providers and `room_event` inbound kinds, matching the exclusions of
  `isSystemChannelTurn` and the existing
  `deliverDespiteSourceReplySuppression` escape hatch)
- the payload has non-empty outbound content

Alternatively: promote the Feishu `shouldSendNoVisibleReplyFallback` into
the shared channel-turn pipeline and drop its `message_tool_only` exclusion
for user turns. We run the first variant as a local dist patch
(`patch-2026.7.1-2-message-tool-only-fallback.mjs` in this directory) and
can confirm it does not double-post for turns that use the message tool.

## Related defect: observed delivery only reported in message_tool_only mode

In the agent runner, a committed message-tool send is only reported to the
dispatch layer when the session mode is `message_tool_only`:

```js
if (opts?.sourceReplyDeliveryMode === "message_tool_only" &&
    committedMessagingToolSourceReplyDelivery)
  await opts.onObservedReplyDelivery?.();
```

`committedMessagingToolSourceReplyDelivery` itself is computed
mode-independently from delivery evidence. The consequence in `automatic`
mode: a turn that successfully replies via the message tool and ends with
empty final text still counts as "no visible dispatch" —
`hasVisibleChannelTurnDispatch` is false, the gateway logs the zero-payload
WARN for a turn the user actually saw answered, and
`noVisibleReplyFallbackEligible` is set on a turn that needs no fallback.
Any monitoring keyed on that WARN (ours is) gets false positives for every
well-behaved tool-replying agent. Suggested fix: drop the mode condition and
notify on `committedMessagingToolSourceReplyDelivery` alone (our local
patch `patch-2026.7.1-2-observed-delivery-all-modes.mjs`).
