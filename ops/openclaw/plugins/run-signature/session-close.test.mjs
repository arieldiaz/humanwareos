import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeSummary,
  formatCloseOut,
  loadThreadUsage,
  measureSlackThread,
  recordSessionClose,
  summarizeTrajectory,
} from "./session-close.mjs";

const messages = [
  { ts: "100.000000", text: "please fix this", user: "U1" },
  { ts: "160.000000", text: "fixed and verified", bot_id: "B1" },
];

test("measures Slack thread activity without estimates", () => {
  assert.deepEqual(measureSlackThread(messages), {
    elapsed: "1 min (0.0 h)",
    totalMessages: 2,
    humanMessages: 1,
    agentMessages: 1,
    humanWords: 3,
    agentWords: 3,
  });
});

test("sums one usage record per completed model turn", () => {
  const usage = summarizeTrajectory([
    JSON.stringify({ type: "model.completed", modelId: "grok-4.6", data: { usage: { input: 10, output: 3, cacheRead: 20 } } }),
    JSON.stringify({ type: "tool.call", data: { usage: { input: 999 } } }),
    JSON.stringify({ type: "model.completed", modelId: "grok-4.6", data: { usage: { input: 5, output: 2, cacheWrite: 4 } } }),
  ].join("\n"));
  assert.deepEqual(usage, {
    turns: 2,
    input: 15,
    output: 5,
    cacheRead: 20,
    cacheWrite: 4,
    peakContext: 30,
    models: "grok-4.6 (2 runs)",
  });
});

test("reads usage from the current OpenClaw assistant-message transcript", () => {
  const usage = summarizeTrajectory(JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      provider: "cursor-agent",
      model: "grok-4.6-low-fast",
      usage: { input: 40, output: 8, cacheRead: 10, cacheWrite: 2 },
    },
  }));
  assert.deepEqual(usage, {
    turns: 1,
    input: 40,
    output: 8,
    cacheRead: 10,
    cacheWrite: 2,
    peakContext: 52,
    models: "grok-4.6-low-fast",
  });
});

test("finds the current topic transcript from the canonical session index", async () => {
  const agentsRoot = await mkdtemp(join(tmpdir(), "thread-usage-"));
  const sessions = join(agentsRoot, "liv", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "sessions.json"), JSON.stringify({
    "agent:liv:slack:channel:c1:thread:100.000000": { sessionId: "session-1" },
  }));
  await writeFile(join(sessions, "session-1-topic-100.000000.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "assistant", model: "grok", usage: { input: 5, output: 2 } },
  }));
  assert.equal((await loadThreadUsage({ agent: "liv", channel: "C1", thread: "100.000000", agentsRoot })).models, "grok");
});

test("a close always carries a summary and measured bullets", () => {
  const stats = measureSlackThread(messages);
  assert.equal(closeSummary("## Session Closed"), "Closed at the human's request.");
  const text = formatCloseOut({ summary: "Fixed the lifecycle path.", stats, agent: "liv" });
  assert.match(text, /^## Session Closed\n- Summary:/);
  assert.match(text, /- Messages: 1 from the human \/ 1 from agents/);
  assert.match(text, /usage unavailable/);
});

test("records one idempotent completion event and one generated view", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "session-close-"));
  const params = {
    dataRoot,
    channel: "C1",
    thread: "100.000000",
    agent: "liv",
    closeMessageId: "200.000000",
    summary: "Done.",
    stats: measureSlackThread(messages),
    usage: undefined,
    now: new Date("2026-08-25T20:00:00Z"),
  };
  const first = await recordSessionClose(params);
  await recordSessionClose(params);
  const events = await readFile(join(dataRoot, "evidence", "sessions", "events", "2026-08-25.jsonl"), "utf8");
  assert.equal(events.trim().split("\n").length, 1);
  assert.match(await readFile(first.viewPath, "utf8"), /## Session Closed/);
});
