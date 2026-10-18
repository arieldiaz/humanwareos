import assert from "node:assert/strict";
import test from "node:test";
import {setThreadStatusTool} from "./status-command.mjs";

const context = {
  messageChannel: "slack",
  sessionKey: "agent:max:slack:channel:c123:thread:1790050400.000001",
  agentAccountId: "max",
  assertInvocationCurrent() {},
};

test("queues an explicit bot-owned root status command", async () => {
  const writes = [];
  const tool = setThreadStatusTool(context, {
    dataRoot: "/data",
    makeDir: async () => {},
    append: async (filePath, content, options) => writes.push({filePath, content, options}),
    id: () => "one",
  });
  const result = await tool.execute("call", {status: "scheduled"});
  assert.equal(result.isError, undefined);
  assert.equal(writes[0].filePath, "/data/operations/slack-notion-sync/commands.jsonl");
  assert.equal(writes[0].options.mode, 0o600);
  assert.deepEqual(JSON.parse(writes[0].content), {
    schemaVersion: 1,
    id: "status-command:one",
    observedAt: JSON.parse(writes[0].content).observedAt,
    channelId: "C123",
    messageTs: "1790050400.000001",
    status: "🗓️ Scheduled",
    requestedBy: "max",
  });
});

test("is Slack-thread-only and rejects stale invocations", async () => {
  assert.equal(setThreadStatusTool({...context, messageChannel: "webchat"}, {dataRoot: "/data"}), undefined);
  const tool = setThreadStatusTool({...context, assertInvocationCurrent() { throw new Error("stale invocation"); }}, {
    dataRoot: "/data", makeDir: async () => {}, append: async () => {},
  });
  const result = await tool.execute("call", {status: "act"});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale invocation/);
});
