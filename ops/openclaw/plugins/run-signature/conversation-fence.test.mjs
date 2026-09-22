import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationFenceStore, conversationContentHash, conversationFenceKey, findDeliveredConversationClose, isHumanSlackUserProfile, shouldSuppressConversationDelivery } from "./conversation-fence.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fence-"));
  let now = 1_000;
  let id = 0;
  const route = { channel: "C012ABC", threadId: "1790050330.465569" };
  const store = new ConversationFenceStore({ path: path.join(root, "fences.json"), now: () => now, uuid: () => `token-${++id}` });
  return { route, store, tick: (value = 1) => (now += value) };
}

test("canonicalizes native Slack session routes", () => {
  assert.equal(conversationFenceKey({ sessionKey: "agent:max:slack:channel:c012abc:thread:1790050330.465569" }), "slack:C012ABC:1790050330.465569");
});

test("only verified non-bot Slack users count as human authors", () => {
  assert.equal(isHumanSlackUserProfile({ id: "UHUMAN", is_bot: false }), true);
  assert.equal(isHumanSlackUserProfile({ id: "UBOT", is_bot: true }), false);
  assert.equal(isHumanSlackUserProfile({ id: "UAPP", is_app_user: true }), false);
  assert.equal(isHumanSlackUserProfile(undefined), false);
});

test("close with two running children suppresses both completions", async () => {
  const { route, store, tick } = fixture();
  await store.ensureOpen(route);
  const first = await store.beginClosing(route);
  tick();
  assert.equal((await store.commitClose(route, first.token, { messageId: "1790050400.000001" })).committed, true);
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), true);
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 950 }), true);
});

test("completion racing close is fenced before close delivery and after commit", async () => {
  const { route, store } = fixture();
  await store.ensureOpen(route);
  const closing = await store.beginClosing(route);
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), true);
  await store.commitClose(route, closing.token, { messageId: "1790050400.000001" });
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), true);
});

test("closed state survives restart and suppresses pending retries", async () => {
  const { route, store } = fixture();
  const closing = await store.beginClosing(route);
  await store.commitClose(route, closing.token, { messageId: "1790050400.000001" });
  const restarted = new ConversationFenceStore({ path: store.path });
  assert.equal(restarted.read(route).state, "closed");
  assert.equal(shouldSuppressConversationDelivery(route, { path: store.path, workCreatedAt: 900 }), true);
});

test("only a human reopen admits new work while retired child work remains suppressed", async () => {
  const { route, store, tick } = fixture();
  const closing = await store.beginClosing(route);
  tick();
  await store.commitClose(route, closing.token, { messageId: "1790050400.000001" });
  tick(100);
  const reopened = await store.reopenFromHuman(route, { messageId: "1790050500.000001" });
  assert.equal(reopened.reopened, true);
  assert.equal(store.read(route).state, "open");
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), true);
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 1_050 }), false);
});

test("failed close removes the fence and retains eligible completion", async () => {
  const { route, store, tick } = fixture();
  const closing = await store.beginClosing(route);
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), true);
  tick();
  assert.equal((await store.abortClose(route, closing.token)).aborted, true);
  assert.equal(store.read(route).state, "open");
  assert.equal(store.shouldSuppress(route, { workCreatedAt: 900 }), false);
});

test("a superseded close token cannot close a human-reopened thread", async () => {
  const { route, store, tick } = fixture();
  const closing = await store.beginClosing(route);
  tick();
  await store.reopenFromHuman(route, { messageId: "1790050500.000001" });
  tick();
  assert.equal((await store.commitClose(route, closing.token, { messageId: "1790050400.000001" })).committed, false);
  assert.equal(store.read(route).state, "open");
});

test("an interrupted prepared close is durably discoverable after restart", async () => {
  const { route, store } = fixture();
  const closing = await store.beginClosing(route, { accountId: "max" });
  await store.armClose(route, closing.token, { content: "Summary\n\n## Session Closed" });
  const restarted = new ConversationFenceStore({ path: store.path });
  const [{ fence }] = restarted.listClosing();
  assert.equal(fence.closeAccountId, "max");
  assert.equal(fence.closeContentHash, conversationContentHash("Summary\n\n## Session Closed"));
  assert.equal(findDeliveredConversationClose([
    { ts: "0.999999", user: "UBOT", text: "Summary\n\n## Session Closed" },
    { ts: "1.001000", user: "UHUMAN", text: "Summary\n\n## Session Closed" },
    { ts: "1.002000", user: "UBOT", text: "Summary\n\n## Session Closed" },
  ], fence, { botUserId: "UBOT" })?.ts, "1.002000");
});
