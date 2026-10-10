import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  slackMrkdwn,
  formatCloseReport,
  loadPullRequests,
  loadThreadUsage,
  measureSlackThread,
  recordSessionClose,
  summarizeTrajectory,
} from "./close-report.mjs";

const messages = [
  { ts: "100.000000", text: "please fix this", user: "U1" },
  { ts: "160.000000", text: "fixed and verified", bot_id: "B1" },
];

test("measures Slack thread activity without estimates", () => {
  assert.deepEqual(measureSlackThread(messages), {
    elapsed: "1 min (0.0 h)",
    elapsedSeconds: 60,
    topic: "please fix this",
    pullRequests: [],
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
    peakContext: 0,
    coverage: {input: 2, output: 2, cacheRead: 1, cacheWrite: 1, peakContext: 0},
    byModel: {"grok-4.6": {input: 15, output: 5, cacheRead: 20, cacheWrite: 4}},
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
    coverage: {input: 1, output: 1, cacheRead: 1, cacheWrite: 1, peakContext: 1},
    byModel: {"grok-4.6-low-fast": {input: 40, output: 8, cacheRead: 10, cacheWrite: 2}},
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

test("the close report is short: what, tokens with API cost, code, follow-up", () => {
  const stats = measureSlackThread([...messages, { ts: "200.000000", bot_id: "B1", text: "opened <https://github.com/o/r/pull/142|PR>" }]);
  assert.deepEqual(stats.pullRequests, ["https://github.com/o/r/pull/142"]);
  const usage = summarizeTrajectory([{ type: "model.completed", modelId: "claude-opus-5-5", data: { usage: { input: 1000, output: 1000, cacheRead: 1000000, cacheWrite: 0 } } }]);
  const text = formatCloseReport({ stats, agent: "liv", usage: [{agent: "liv", usage}, {agent: "max"}, {agent: "default"}],
    pullRequests: [{url: stats.pullRequests[0], number: 142, state: "OPEN", additions: 62, deletions: 140, changedFiles: 2}] });
  assert.equal(text, [
    "**Session closed** · 2m · 3 msgs",
    "- What: please fix this",
    "- Tokens: 1.0M in (100% cached) · 1k out · ~$0.22 API",
    "- Code: [PR #142](https://github.com/o/r/pull/142) · open · +62/−140 · 2 files",
    "- Follow-up: none",
  ].join("\n"));
});

test("unpriced models mark cost as a lower bound and missing usage stays explicit", () => {
  const usage = summarizeTrajectory([{ type: "model.completed", modelId: "mystery", data: { usage: { input: 10, output: 1 } } }]);
  assert.match(formatCloseReport({ usage, agent: "liv" }), /≥\$0\.00 API/);
  assert.match(formatCloseReport({ agent: "liv" }), /Tokens: liv usage unavailable\n- Follow-up: none$/);
  assert.equal(slackMrkdwn("**Session closed** · 2m\n- Code: [PR #142](https://github.com/o/r/pull/142) · open"), "*Session closed* · 2m\n• Code: <https://github.com/o/r/pull/142|PR #142> · open");
});

test("records one idempotent completion event and one generated view", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "close-report-"));
  const params = {
    dataRoot,
    channel: "C1",
    thread: "100.000000",
    agent: "liv",
    operationId: "C1:100.000000:close:200.000000",
    summary: "Done.",
    stats: measureSlackThread(messages),
    usage: undefined,
    now: new Date("2026-08-25T20:00:00Z"),
  };
  const first = await recordSessionClose(params);
  await recordSessionClose(params);
  const events = await readFile(join(dataRoot, "evidence", "sessions", "events", "2026-08-25.jsonl"), "utf8");
  assert.equal(events.trim().split("\n").length, 1);
});

test("pull request details degrade to a link when gh is unavailable", async () => {
  const url = "https://github.com/o/r/pull/7";
  assert.deepEqual(await loadPullRequests([url], async () => { throw new Error("no gh"); }), [{url, number: 7}]);
  assert.deepEqual(await loadPullRequests([url], async () => ({stdout: '{"number":7,"state":"MERGED","additions":1,"deletions":2,"changedFiles":1}'})),
    [{url, number: 7, state: "MERGED", additions: 1, deletions: 2, changedFiles: 1}]);
});
