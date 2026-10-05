import assert from "node:assert/strict";
import test from "node:test";

import { startSlackWorkThread } from "./slack-spin-out.mjs";

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    input: {
      accountId: "max",
      agentId: "max",
      channel: "C123",
      detail: "  Fix: focused patch\nScope and first action are underway.  ",
      group: "Humanware OS",
      parentSessionKey: "agent:max:slack:channel:C123:thread:1",
      operationId: "call-1",
      send: async (params) => {
        calls.push(["send", params]);
        return { messageId: "1787000000.100000" };
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

test("posts the brief as one top-level message and starts high before work begins", async () => {
  const { calls, input } = fixture();
  const result = await startSlackWorkThread(input);

  assert.deepEqual(calls.map(([kind]) => kind), ["send", "scaffold", "status", "session"]);
  assert.equal("title" in calls[0][1], false);
  assert.equal(calls[0][1].topLevel, true);
  assert.equal(calls[0][1].threadId, undefined);
  assert.equal(calls[0][1].message, input.detail.trim());
  assert.deepEqual(calls[1][1], { channel: "C123", messageIds: ["1787000000.100000"] });
  assert.deepEqual(calls[2][1], { channel: "C123", rootMessageId: "1787000000.100000", status: "working" });
  assert.equal(calls[3][1].label, "Fix: focused patch");
  assert.equal(calls[3][1].thinkingLevel, "high");
  assert.equal(calls[3][1].parentSessionKey, input.parentSessionKey);
  assert.match(calls[3][1].task, /Slack channel C123, thread root 1787000000\.100000/);
  assert.match(calls[3][1].task, /Begin this work now/);
  assert.deepEqual(result, {
    rootMessageId: "1787000000.100000",
    childSessionKey: "agent:max:dashboard:child",
    runId: "run-1",
    thinkingLevel: "high",
  });
});

test("uses stable idempotency keys for a repeated tool call", async () => {
  const { calls, input } = fixture();
  await startSlackWorkThread(input);
  assert.equal(calls[0][1].idempotencyKey, "work-thread:call-1:publication");
  assert.equal(calls[3][1].idempotencyKey, "work-thread:call-1:session");
});

test("clears the transient tile without selecting a terminal if the session cannot start", async () => {
  const { calls, input } = fixture({
    createSession: async (params) => {
      calls.push(["session", params]);
      return { key: "agent:max:dashboard:child", runStarted: false, runError: "launch failed" };
    },
  });
  await assert.rejects(startSlackWorkThread(input), /launch failed/);
  assert.deepEqual(calls.at(-1), ["status", { channel: "C123", rootMessageId: "1787000000.100000", status: undefined }]);
});

test("does not start work when durable publication identity is unavailable", async () => {
  const { calls, input } = fixture({ send: async (params) => { calls.push(["send", params]); return {}; } });
  await assert.rejects(startSlackWorkThread(input), /publication returned no message identity/);
  assert.equal(calls.length, 1);
});

