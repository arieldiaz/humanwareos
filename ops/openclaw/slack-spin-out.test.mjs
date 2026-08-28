import assert from "node:assert/strict";
import test from "node:test";

import { createSlackWorkThread } from "./slack-spin-out.mjs";

test("creates a root, then targets the returned root with the first reply", async () => {
  const calls = [];
  const ids = ["1787000000.100000", "1787000000.200000"];
  const result = await createSlackWorkThread({
    accountId: "max",
    agentId: "max",
    channel: "C123",
    goal: "Ship the focused fix.",
    detail: "Scope and first action are underway.",
    send: async (params) => {
      calls.push(params);
      return { messageId: ids[calls.length - 1] };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].message, "Goal: Ship the focused fix.");
  assert.equal(calls[0].topLevel, true);
  assert.equal(calls[0].threadId, undefined);
  assert.equal(calls[1].threadId, ids[0]);
  assert.equal(calls[1].topLevel, undefined);
  assert.deepEqual(result, { rootMessageId: ids[0], replyMessageId: ids[1] });
});

test("does not send the detail reply when root identity is unavailable", async () => {
  let calls = 0;
  await assert.rejects(
    createSlackWorkThread({
      accountId: "max",
      agentId: "max",
      channel: "C123",
      goal: "Ship the focused fix.",
      detail: "Scope and first action are underway.",
      send: async () => {
        calls += 1;
        return {};
      },
    }),
    /root send returned no messageId/,
  );
  assert.equal(calls, 1);
});
