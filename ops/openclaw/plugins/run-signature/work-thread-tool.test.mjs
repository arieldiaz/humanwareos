import assert from "node:assert/strict";
import test from "node:test";

import {registerWorkThreadTool} from "./work-thread-tool.mjs";

test("starts Slack work without privileged gateway RPC", async () => {
  let factory;
  const sends = [];
  const runs = [];
  const patches = [];
  const workThreadPosts = new Set();
  const api = {
    config: {channels: {slack: {accounts: {max: {}}}}},
    registerTool(value) { factory = value; },
    runtime: {
      channel: {outbound: {async loadAdapter(channel) {
        assert.equal(channel, "slack");
        return {async sendText(params) {
          sends.push(params);
          return {messageId: params.threadId ? "1792416000.000002" : "1792416000.000001"};
        }};
      }}},
      subagent: {
        async run(params) {
          runs.push(params);
          return runs.length === 1
            ? {runId: "thinking-run", sessionKey: params.sessionKey}
            : {runId: "work-run", sessionKey: params.sessionKey};
        },
        async waitForRun(params) {
          assert.deepEqual(params, {runId: "thinking-run", timeoutMs: 30_000});
          return {status: "ok"};
        },
      },
      agent: {session: {async patchSessionEntry(params) {
        patches.push({sessionKey: params.sessionKey, update: params.update({})});
        return {};
      }}},
      gateway: {request() { throw new Error("gateway RPC must not be used"); }},
    },
  };
  registerWorkThreadTool(api, {
    resolveSlackRuntimeModule: () => new URL("./host-close.test-accounts.mjs", import.meta.url).pathname,
    retrySlackRateLimit: (run) => run(),
    workThreadPosts,
  });
  const tool = factory.create({
    messageChannel: "slack",
    nativeChannelId: "C123456",
    agentId: "max",
    agentAccountId: "max",
    sessionKey: "agent:max:slack:channel:C123456:thread:1792415000.000001",
  });

  const result = await tool.execute("tool-call-1", {
    title: "Fix: work threads",
    detail: "Repair and verify the workflow.",
    group: "Humanware OS",
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.rootMessageId, "1792416000.000001");
  assert.equal(result.details.runId, "work-run");
  assert.equal(result.details.thinkingLevel, "high");
  assert.deepEqual(sends.map(({to, text, threadId, deliveryQueueId}) => ({to, text, threadId, deliveryQueueId})), [
    {
      to: "channel:C123456",
      text: "Fix: work threads",
      threadId: undefined,
      deliveryQueueId: "work-thread:tool-call-1:publication",
    },
    {
      to: "channel:C123456",
      text: "Repair and verify the workflow.",
      threadId: "1792416000.000001",
      deliveryQueueId: "work-thread:tool-call-1:brief",
    },
  ]);
  assert.equal(runs[0].message, "/think high");
  assert.equal(runs[0].disableTools, true);
  assert.match(runs[0].sessionKey, /^agent:max:subagent:work-thread-[a-f0-9]{20}$/);
  assert.equal(runs[1].sessionKey, runs[0].sessionKey);
  assert.match(runs[1].message, /Use Slack channel C123456, thread root 1792416000\.000001/);
  assert.deepEqual(patches, [{
    sessionKey: runs[0].sessionKey,
    update: {label: "Fix: work threads", displayName: "Fix: work threads", category: "Humanware OS"},
  }]);
  assert.deepEqual([...workThreadPosts], ["Fix: work threads", "Repair and verify the workflow."]);
});

test("does not dispatch work when high-reasoning setup fails", async () => {
  let factory;
  const runs = [];
  const api = {
    config: {},
    registerTool(value) { factory = value; },
    runtime: {
      channel: {outbound: {async loadAdapter() {
        return {async sendText(params) { return {messageId: params.threadId ? "reply" : "1792416000.000001"}; }};
      }}},
      subagent: {
        async run(params) { runs.push(params); return {runId: "thinking-run", sessionKey: params.sessionKey}; },
        async waitForRun() { return {status: "error", error: "thinking rejected"}; },
      },
      agent: {session: {async patchSessionEntry() { throw new Error("must not patch"); }}},
    },
  };
  registerWorkThreadTool(api, {
    resolveSlackRuntimeModule: () => new URL("./host-close.test-accounts.mjs", import.meta.url).pathname,
    retrySlackRateLimit: (run) => run(),
    workThreadPosts: new Set(),
  });
  const result = await factory.create({messageChannel: "slack", nativeChannelId: "C123456", agentId: "max", agentAccountId: "max"})
    .execute("tool-call-2", {title: "Fix: work threads", detail: "Repair it."});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /thinking rejected/);
  assert.equal(runs.length, 1);
});
