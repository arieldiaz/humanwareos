import assert from "node:assert/strict";
import test from "node:test";

import {
  existingRowFromPage,
  isoFromSlackTs,
  notionProperties,
  sessionStats,
  statusFromRoot,
  titleFromSlackText,
  validateInput,
} from "./sync.mjs";

test("builds a bounded title without Slack mentions or links", () => {
  assert.equal(
    titleFromSlackText("<@U123> Ship <https://example.com/spec|the spec> with https://example.com/raw *today*"),
    "Ship the spec with today",
  );
  assert.equal(titleFromSlackText("<@U123> <https://example.com>"), "Untitled Slack thread");
  assert.equal(titleFromSlackText("x".repeat(100)).length, 80);
});

test("uses the first root reaction and leaves only absent reactions blank", () => {
  assert.equal(statusFromRoot({ reactions: [{ name: "raised_hand" }, { name: "white_check_mark" }] }), "✋ Act");
  assert.equal(statusFromRoot({ reactions: [{ name: "eyes" }] }), "👀 Eyes");
  assert.equal(statusFromRoot({ reactions: [{ name: "custom_state" }] }), ":custom_state: Custom State");
  assert.equal(statusFromRoot({}), null);
});

test("formats timestamps and session stats from primary sources", () => {
  assert.equal(isoFromSlackTs("1792071262.224389"), "2026-10-15T13:34:22.224Z");
  const messages = Array.from({ length: 42 }, (_, index) => ({ type: index % 2 ? "model.completed" : "prompt.submitted", runId: index < 20 ? "a" : "b" }));
  const stats = sessionStats(
    { runtimeMs: 4_800_000, spend: [{ exact: 0.84 }], events: [] },
    2,
    { details: messages },
  );
  assert.equal(stats, "2 sessions · 42 msgs · 1h 20m · $0.84");
});

test("preserves status changed while status is stable and updates it on transition", () => {
  const row = {
    title: "Thread", status: "✋ Act", slackLink: "https://slack.test/t", channel: "work",
    channelId: "C1", started: "2026-10-15T10:00:00Z", lastActivity: "2026-10-15T11:00:00Z",
    replies: 2, statusChanged: "2026-10-15T11:00:00Z", sessionStats: "1 session", sessionSummary: "https://os.test/s.md",
    threadKey: "C1:1.0",
  };
  const stable = notionProperties(row, { status: "✋ Act", statusChanged: "2026-10-15T10:30:00Z" }, "2026-10-15T12:00:00Z");
  assert.equal(stable["Status changed"].date.start, "2026-10-15T10:30:00Z");
  const changed = notionProperties(row, { status: "🔄 Working", statusChanged: "2026-10-15T10:30:00Z" }, "2026-10-15T12:00:00Z");
  assert.equal(changed["Status changed"].date.start, "2026-10-15T11:00:00Z");
});

test("reads the upsert key and prior status from a Notion page", () => {
  const row = existingRowFromPage({ id: "p1", properties: {
    "Thread key": { rich_text: [{ plain_text: "C1:1.0" }] },
    Status: { select: { name: "✅ Closed" } },
    "Status changed": { date: { start: "2026-10-15T12:00:00Z" } },
  } });
  assert.deepEqual(row, { pageId: "p1", threadKey: "C1:1.0", status: "✅ Closed", statusChanged: "2026-10-15T12:00:00Z" });
});

test("rejects stale projections", () => {
  assert.equal(validateInput({ generatedAt: "2026-10-15T12:00:00Z", sessions: [{ channelId: "C1", threadId: "1" }, {}] }, new Date("2026-10-15T12:01:00Z")).length, 1);
  assert.throws(() => validateInput({ generatedAt: "2026-10-15T10:00:00Z", sessions: [] }, new Date("2026-10-15T12:01:00Z")), /stale/);
});
