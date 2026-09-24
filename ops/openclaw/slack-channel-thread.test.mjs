import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkThreadTitle, planSlackChannelThread, slackThreadBodyEntry, slackThreadReconciliationContext } from "./slack-channel-thread.mjs";

const send = { channel: "slack", to: "channel:C123", session: { agentId: "max" }, title: " Weekly\n review ", payloads: [{ text: "Full body", mediaUrls: ["/staged/report.pdf"] }] };

test("scheduled and conversational channel posts use title metadata, never the body", () => {
  for (const to of ["C123", "channel:G123", "#C123", "general", "daily", "weekly", "updates", "team:T123:channel:C123"]) assert.deepEqual(planSlackChannelThread({ ...send, to }), { title: "Weekly review" });
  assert.deepEqual(planSlackChannelThread(send), { title: "Weekly review" });
  assert.deepEqual(planSlackChannelThread({ ...send, title: undefined, session: { agentId: "liv", label: "A named task" } }), { title: "A named task" });
  assert.deepEqual(planSlackChannelThread({ ...send, title: undefined }), { title: "Update" });
  assert.equal(send.payloads[0].mediaUrls[0], "/staged/report.pdf");
  assert.equal(normalizeWorkThreadTitle("word ".repeat(80)).length, 160);
  assert.throws(() => normalizeWorkThreadTitle(" \n "), /required/);
});

test("existing threads, DMs, other channels and system messages stay unchanged", () => {
  for (const changes of [{ deliveryQueueId: "pre-upgrade-row" }, { threadId: "1.2" }, { replyToId: "1.2" }, { reply: { replyToId: "1.2" } }, { payloads: [{ text: "reply", replyToId: "1.2" }] }, { to: "D123" }, { to: "user:U123" }, { to: "channel:D123" }, { to: "slack:U123" }, { to: "team:T123:user:U123" }, { session: { agentId: "max", conversationType: "direct" } }, { channel: "telegram" }, { session: undefined }]) {
    assert.equal(planSlackChannelThread({ ...send, ...changes }), undefined, JSON.stringify(changes));
  }
});

test("root checkpoint preserves body/media custody and resets only the root attempt", () => {
  const entry = { id: "queue", slackChannelThread: { title: "Title" }, preparedBatch: { attachments: ["spooled.pdf"] }, deliveryCompletion: { kind: "conversation" }, availableAt: 1234, recoveryState: "unknown_after_send", platformSendAttemptId: "owner", platformSendStartedAt: 1000 };
  const body = slackThreadBodyEntry(entry, "1.2", "owner");
  assert.equal(body.preparedBatch, entry.preparedBatch);
  assert.equal(body.deliveryCompletion, entry.deliveryCompletion);
  assert.equal(body.threadId, "1.2");
  assert.equal(body.producerClaimId, "owner");
  assert.equal(body.availableAt, 1234);
  assert.equal(body.platformSendStartedAt, undefined);
  assert.equal(body.recoveryState, "producer_claimed");
  assert.equal(entry.recoveryState, "unknown_after_send");
  const recovered = slackThreadBodyEntry(entry, "1.2");
  assert.equal(recovered.recoveryState, undefined);
  assert.equal(recovered.producerClaimId, undefined);
  assert.throws(() => slackThreadBodyEntry(entry, ""), /no messageId/);
});

test("unknown root and body use disjoint reconciliation markers", () => {
  const entry = { id: "queue", slackChannelThread: { title: "Title" } };
  const context = { queueId: "queue", payloads: send.payloads, threadId: "stale", renderedBatchPlan: { kind: "media" } };
  const root = slackThreadReconciliationContext(entry, context);
  assert.equal(root.queueId, "queue:slack-root");
  assert.deepEqual(root.payloads, [{ text: "Title" }]);
  assert.equal(root.threadId, undefined);
  assert.equal(root.renderedBatchPlan, undefined);
  assert.equal(slackThreadReconciliationContext(slackThreadBodyEntry(entry, "1.2"), context), context);
  assert.equal(slackThreadReconciliationContext({ id: "ordinary" }, context), context);
});
