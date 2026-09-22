import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorkThreadTitle, startSlackWorkThread } from "./slack-spin-out.mjs";

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    input: {
      accountId: "max",
      agentId: "max",
      channel: "C123",
      title: "  Ship the focused fix.\nDo not put this in the root.  ",
      detail: "Scope and first action are underway.",
      group: "Humanware OS",
      parentSessionKey: "agent:max:slack:channel:C123:thread:1",
      operationId: "call-1",
      send: async (params) => {
        calls.push(["send", params]);
        return { messageId: calls.filter(([kind]) => kind === "send").length === 1 ? "1787000000.100000" : "1787000000.200000" };
      },
      prepareScaffold: async (params) => calls.push(["scaffold", params]),
      setStatus: async (params) => calls.push(["status", params]),
      createSession: async (params) => {
        calls.push(["session", params]);
        return { key: "agent:max:dashboard:child", runId: "run-1", runStarted: true };
      },
      ...overrides,
    },
  };
}

test("uses one short root, one detailed reply, and starts high before work begins", async () => {
  const { calls, input } = fixture();
  const result = await startSlackWorkThread(input);

  assert.deepEqual(calls.map(([kind]) => kind), ["send", "send", "scaffold", "status", "session"]);
  assert.equal(calls[0][1].message, "Ship the focused fix. Do not put this in the root.");
  assert.equal(calls[0][1].topLevel, true);
  assert.equal(calls[0][1].threadId, undefined);
  assert.equal(calls[1][1].message, input.detail);
  assert.equal(calls[1][1].threadId, "1787000000.100000");
  assert.deepEqual(calls[2][1], { channel: "C123", messageIds: ["1787000000.100000", "1787000000.200000"] });
  assert.deepEqual(calls[3][1], { channel: "C123", rootMessageId: "1787000000.100000", status: "working" });
  assert.equal(calls[4][1].thinkingLevel, "high");
  assert.equal(calls[4][1].parentSessionKey, input.parentSessionKey);
  assert.match(calls[4][1].task, /Slack channel C123, thread root 1787000000\.100000/);
  assert.match(calls[4][1].task, /Begin this work now/);
  assert.deepEqual(result, {
    rootMessageId: "1787000000.100000",
    replyMessageId: "1787000000.200000",
    childSessionKey: "agent:max:dashboard:child",
    runId: "run-1",
    thinkingLevel: "high",
  });
});

test("uses stable idempotency keys for a repeated tool call", async () => {
  const { calls, input } = fixture();
  await startSlackWorkThread(input);
  assert.equal(calls[0][1].idempotencyKey, "work-thread:call-1:root");
  assert.equal(calls[1][1].idempotencyKey, "work-thread:call-1:detail");
  assert.equal(calls[4][1].idempotencyKey, "work-thread:call-1:session");
});

test("marks the root for human action if the work session cannot start", async () => {
  const { calls, input } = fixture({
    createSession: async (params) => {
      calls.push(["session", params]);
      return { key: "agent:max:dashboard:child", runStarted: false, runError: "launch failed" };
    },
  });
  await assert.rejects(startSlackWorkThread(input), /launch failed/);
  assert.deepEqual(calls.at(-1), ["status", { channel: "C123", rootMessageId: "1787000000.100000", status: "act" }]);
});

test("does not post details when root identity is unavailable", async () => {
  const { calls, input } = fixture({ send: async (params) => { calls.push(["send", params]); return {}; } });
  await assert.rejects(startSlackWorkThread(input), /root send returned no messageId/);
  assert.equal(calls.length, 1);
});

test("truncates an overlong title without creating another line", () => {
  const title = normalizeWorkThreadTitle(` ${"word ".repeat(50)}\nend `);
  assert.equal(title.includes("\n"), false);
  assert.equal(title.length, 160);
  assert.equal(title.endsWith("…"), true);
});
