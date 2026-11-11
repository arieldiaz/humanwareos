import assert from "node:assert/strict";
import test from "node:test";

import {registerWorkThreadTool} from "./work-thread-tool.mjs";

// OpenClaw counts `subagent:` segments in a session key to classify a worker.
const isSubagentShaped = (key) => /(^|:)subagent:/i.test(String(key).replace(/^agent:[^:]+:/i, ""));

function harness({run} = {}) {
  let factory;
  const sends = [];
  const runs = [];
  const routes = [];
  const patches = [];
  const workThreadPosts = new Set();
  const api = {
    config: {channels: {slack: {accounts: {max: {}}}}},
    registerTool(value) { factory = value; },
    runtime: {
      channel: {
        outbound: {async loadAdapter(channel) {
          assert.equal(channel, "slack");
          return {async sendText(params) {
            sends.push(params);
            return {messageId: params.threadId ? "1792416000.000002" : "1792416000.000001"};
          }};
        }},
        routing: {resolveAgentRoute(params) {
          routes.push(params);
          return {agentId: params.accountId, sessionKey: `agent:${params.accountId}:slack:${params.peer.kind}:${params.peer.id.toLowerCase()}`};
        }},
      },
      subagent: {
        run: run ?? (async (params) => { runs.push(params); return {runId: "work-run", sessionKey: params.sessionKey}; }),
        waitForRun() { throw new Error("work threads must not wait on a setup run"); },
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
    retrySlackRateLimit: (task) => task(),
    workThreadPosts,
  });
  const tool = factory.create({
    messageChannel: "slack",
    nativeChannelId: "C123456",
    agentId: "max",
    agentAccountId: "max",
    sessionKey: "agent:max:slack:channel:c123456:thread:1792415000.000001",
  });
  return {tool, sends, runs, routes, patches, workThreadPosts};
}

test("starts Slack work in the thread's own root session without privileged gateway RPC", async () => {
  const {tool, sends, runs, routes, patches, workThreadPosts} = harness();

  const result = await tool.execute("tool-call-1", {
    title: "Fix: work threads",
    summary: "Repairing work threads; nothing needed from you yet.",
    detail: "Repair and verify the workflow.",
    group: "Humanware OS",
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.details.rootMessageId, "1792416000.000001");
  assert.equal(result.details.runId, "work-run");
  assert.deepEqual(sends.map(({to, text, threadId, deliveryQueueId}) => ({to, text, threadId, deliveryQueueId})), [
    {
      to: "channel:C123456",
      text: "Fix: work threads",
      threadId: undefined,
      deliveryQueueId: "work-thread:tool-call-1:publication",
    },
    {
      to: "channel:C123456",
      text: "Repairing work threads; nothing needed from you yet.",
      threadId: "1792416000.000001",
      deliveryQueueId: "work-thread:tool-call-1:summary",
    },
  ]);
  assert.deepEqual(routes.map(({channel, accountId, peer}) => ({channel, accountId, peer})), [
    {channel: "slack", accountId: "max", peer: {kind: "channel", id: "C123456"}},
  ]);
  assert.equal(runs.length, 1, "no separate reasoning-setup run");
  assert.equal(runs[0].sessionKey, "agent:max:slack:channel:c123456:thread:1792416000.000001");
  assert.equal(result.details.childSessionKey, runs[0].sessionKey);
  assert.equal(runs[0].disableTools, undefined);
  assert.match(runs[0].message, /Report in Slack channel C123456, thread root 1792416000\.000001/);
  assert.deepEqual(patches, [{
    sessionKey: runs[0].sessionKey,
    update: {label: "Fix: work threads", displayName: "Fix: work threads", category: "Humanware OS"},
  }]);
  assert.deepEqual([...workThreadPosts], ["Fix: work threads", "Repairing work threads; nothing needed from you yet."]);
  assert.match(runs[0].message, /Repair and verify the workflow\./);
});

test("the work-thread session is a root, never sub-agent-shaped", async () => {
  const {tool, runs} = harness();
  const result = await tool.execute("tool-call-3", {title: "Fix: roots", summary: "Fixing roots.", detail: "Coordinate it."});

  assert.equal(isSubagentShaped(result.details.childSessionKey), false);
  assert.equal(isSubagentShaped(runs[0].sessionKey), false);
  assert.equal(isSubagentShaped("agent:max:subagent:work-thread-0123456789abcdef0123"), true);
});

test("reports a run that does not start", async () => {
  const {tool, patches} = harness({run: async () => { throw new Error("admission rejected"); }});
  const result = await tool.execute("tool-call-2", {title: "Fix: work threads", summary: "Repairing it.", detail: "Repair it."});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /admission rejected/);
  assert.deepEqual(patches, []);
});
