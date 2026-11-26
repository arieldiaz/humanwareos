import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  slackMrkdwn,
  formatCloseReport,
  loadPullRequests,
  measureSlackThread,
  recordSessionClose,
  usageLine,
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

const FABLE = {amount: 334.12, reports: 120, unavailable: 0,
  tokens: {cacheRead: 275839762, cacheWrite: 0, cacheWrite1h: 20327998, input: 1154, output: 541469, total: 296710383}};

test("the close report is short: what, tokens with API cost, code, follow-up", () => {
  const stats = measureSlackThread([...messages, { ts: "200.000000", bot_id: "B1", text: "opened <https://github.com/o/r/pull/142|PR>" }]);
  assert.deepEqual(stats.pullRequests, ["https://github.com/o/r/pull/142"]);
  const text = formatCloseReport({ stats, usage: FABLE,
    pullRequests: [{url: stats.pullRequests[0], number: 142, state: "OPEN", additions: 62, deletions: 140, changedFiles: 2}] });
  assert.equal(text, [
    "**Session closed** · 2m · 3 msgs",
    "- What: please fix this",
    "- Tokens: 296.2M in (93% cached) · 541k out · $334.12 API list-price equivalent",
    "- Code: [PR #142](https://github.com/o/r/pull/142) · open · +62/−140 · 2 files",
    "- Follow-up: none",
  ].join("\n"));
});

test("unpriced reports are counted, and missing usage is never printed as zero", () => {
  assert.equal(usageLine({...FABLE, amount: 12.5, reports: 4, unavailable: 1, tokens: {input: 100, cacheWrite1h: 900, output: 5, total: 1005}}),
    "- Tokens: 1k in (0% cached) · 5 out · $12.50 API list-price equivalent; 1 of 4 usage reports unpriced");
  assert.equal(usageLine({amount: null, reports: 1, unavailable: 1, tokens: {input: 10, output: 1, total: 11}}), "- Tokens: 10 in (0% cached) · 1 out · price unavailable");
  for (const usage of [undefined, {error: "OSError: no ledger"}, {amount: null, reports: 0, unavailable: 0, tokens: {}}])
    assert.equal(usageLine(usage), "- Tokens: usage unavailable");
  assert.match(formatCloseReport({}), /^\*\*Session closed\*\*\n- Tokens: usage unavailable\n- Follow-up: none$/);
  assert.equal(slackMrkdwn("**Session closed** · 2m\n- Code: [PR #142](https://github.com/o/r/pull/142) · open"), "*Session closed* · 2m\n• Code: <https://github.com/o/r/pull/142|PR #142> · open");
});

test("records one idempotent completion event", async () => {
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
