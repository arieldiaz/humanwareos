import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildRowFromRoot,
  discoverSlackRoots,
  existingRowFromPage,
  isoFromSlackTs,
  isMainModule,
  isSlackMessageRoot,
  notionProperties,
  rootFingerprint,
  sessionStats,
  slackPermalink,
  statusFromRoot,
  statusesFromRoot,
  migratedStatusForThread,
  pendingStatusEvents,
  hasUnprocessedStatusEvents,
  titleFromSlackText,
  validateInput,
} from "./sync.mjs";

test("recognizes a runtime entrypoint whose path contains spaces", () => {
  const entrypoint = "/Users/admin/Library/Application Support/HumanwareOS/sync.mjs";
  assert.equal(isMainModule(pathToFileURL(entrypoint).href, entrypoint), true);
  assert.equal(isMainModule(pathToFileURL(entrypoint).href, undefined), false);
});

test("builds a bounded title without Slack mentions or links", () => {
  assert.equal(
    titleFromSlackText("<@U123> Ship <https://example.com/spec|the spec> with https://example.com/raw *today*"),
    "Ship the spec with today",
  );
  assert.equal(titleFromSlackText("<@U123> <https://example.com>"), "Untitled Slack thread");
  assert.equal(titleFromSlackText("x".repeat(100)).length, 80);
});

test("discovers every message root across paginated member channels", async () => {
  const responses = new Map([
    ["auth.test:", { url: "https://workspace.slack.com/" }],
    ["conversations.list:", {
      channels: [
        { id: "C1", name: "work", is_member: true },
        { id: "C2", name: "outside", is_member: false },
      ],
      response_metadata: { next_cursor: "next" },
    }],
    ["conversations.list:next", {
      channels: [{ id: "C3", name: "private", is_member: true }],
      response_metadata: { next_cursor: "" },
    }],
    ["conversations.history:C1", {
      messages: [
        { ts: "2.0", text: "Second", reply_count: 0 },
        { ts: "1.0", text: "First", reply_count: 1 },
        { ts: "0.5", thread_ts: "1.0", text: "Reply" },
        { ts: "0.1", subtype: "channel_join", text: "joined" },
      ],
      response_metadata: { next_cursor: "" },
    }],
    ["conversations.history:C3", {
      messages: [{ ts: "3.0", subtype: "bot_message", text: "Bot root" }],
      response_metadata: { next_cursor: "" },
    }],
  ]);
  const calls = [];
  const fakeSlack = async (method, query = {}) => {
    calls.push([method, query]);
    const key = method === "conversations.list"
      ? `${method}:${query.cursor || ""}`
      : method === "conversations.history"
        ? `${method}:${query.channel}`
        : `${method}:`;
    return responses.get(key);
  };
  const result = await discoverSlackRoots(fakeSlack);
  assert.equal(result.channels, 2);
  assert.deepEqual(result.roots.map((item) => item.channelId), ["C1", "C1", "C3"]);
  assert.equal(result.roots[0].slackLink, "https://workspace.slack.com/archives/C1/p20");
  assert.equal(calls.find(([method]) => method === "conversations.list")[1].exclude_archived, "false");
  assert.equal(calls.some(([method, query]) => method === "conversations.history" && query.channel === "C2"), false);
});

test("classifies message roots and builds rows without session enrichment", () => {
  assert.equal(isSlackMessageRoot({ ts: "1.0", text: "hello" }), true);
  assert.equal(isSlackMessageRoot({ ts: "1.0", subtype: "bot_message", text: "hello" }), true);
  assert.equal(isSlackMessageRoot({ ts: "1.1", thread_ts: "1.0", text: "reply" }), false);
  assert.equal(isSlackMessageRoot({ ts: "1.0", subtype: "channel_join" }), false);
  assert.equal(slackPermalink("https://workspace.slack.com/", "C1", "1.002"), "https://workspace.slack.com/archives/C1/p1002");
  const discovered = {
    channelId: "C1",
    channelName: "work",
    slackLink: "https://workspace.slack.com/archives/C1/p1002",
    root: { ts: "1.002", text: "A root", reply_count: 0 },
  };
  const row = buildRowFromRoot(discovered, null, "2026-10-15T12:00:00Z");
  assert.equal(row.threadKey, "C1:1.002");
  assert.equal(row.sessionStats, null);
  assert.equal(row.sessionSummary, null);
  assert.equal(rootFingerprint("work", discovered.root), rootFingerprint("work", discovered.root));
  assert.notEqual(rootFingerprint("work", discovered.root), rootFingerprint("work", { ...discovered.root, reply_count: 1 }));
});

test("derives status only from configured human-held canonical reactions", () => {
  const actors = new Set(["UOWNER"]);
  assert.equal(statusFromRoot({ reactions: [{ name: "hand", users: ["UOWNER"] }] }, actors), "✋ Act");
  assert.equal(statusFromRoot({ reactions: [{ name: "raised_hand", users: ["UBOT"] }] }, actors), null);
  assert.equal(statusFromRoot({ reactions: [{ name: "eyes", users: ["UOWNER"] }] }, actors), null);
  assert.deepEqual(statusesFromRoot({ reactions: [
    { name: "raised_hand", users: ["UOWNER"] },
    { name: "white_check_mark", users: ["UOWNER"] },
  ] }, actors), ["raised_hand", "white_check_mark"]);
  assert.equal(statusFromRoot({ reactions: [
    { name: "raised_hand", users: ["UOWNER"] },
    { name: "white_check_mark", users: ["UOWNER"] },
  ] }, actors), null);
});

test("preserves a migrated status until the human claims the thread", () => {
  const actors = new Set(["UOWNER"]);
  const baseline = {"C1:1.0": "✋ Act"};
  assert.equal(migratedStatusForThread("C1:1.0", {reactions: []}, baseline, {}, actors), "✋ Act");
  assert.equal(migratedStatusForThread("C1:1.0", {
    reactions: [{name: "arrows_counterclockwise", users: ["UOWNER"]}],
  }, baseline, {}, actors), "🔄 Working");
  assert.equal(migratedStatusForThread("C1:1.0", {reactions: []}, baseline, {"C1:1.0": "claimed"}, actors), null);
});

test("leaves conflicting human statuses blank instead of falling back to migration", () => {
  const root = {reactions: [
    {name: "hand", users: ["UOWNER"]},
    {name: "calendar", users: ["UOWNER"]},
  ]};
  assert.equal(migratedStatusForThread("C1:1.0", root, {"C1:1.0": "✋ Act"}, {}, new Set(["UOWNER"])), null);
});

test("includes the effective migrated status in the workflow fingerprint", () => {
  const root = {ts: "1.0", text: "A root", reactions: []};
  assert.notEqual(rootFingerprint("work", root, "✋ Act"), rootFingerprint("work", root, null));
});

test("ignores social reactions in the workflow fingerprint", () => {
  const root = { ts: "1.0", text: "A root", reactions: [{ name: "butterfly", users: ["UOTHER"] }] };
  assert.equal(
    rootFingerprint("work", root),
    rootFingerprint("work", { ...root, reactions: [{ name: "chart_with_upwards_trend", users: ["UOTHER"] }] }),
  );
});

test("debounces and deduplicates structured status events by thread", () => {
  const first = {id: "a", observedAt: "2026-10-15T12:00:00Z", channelId: "C1", messageTs: "1.0", eventTs: "1.1"};
  const second = {...first, id: "b", observedAt: "2026-10-15T12:00:01Z", eventTs: "1.2"};
  const text = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
  assert.deepEqual(pendingStatusEvents(text, {processedEvents: {}}, new Date("2026-10-15T12:00:02Z")), []);
  const ready = pendingStatusEvents(text, {processedEvents: {a: "done"}}, new Date("2026-10-15T12:00:04Z"));
  assert.equal(ready.length, 1);
  assert.equal(ready[0].event.id, "b");
  assert.deepEqual(ready[0].ids, ["b"]);
  assert.equal(hasUnprocessedStatusEvents(text, {processedEvents: {a: "done"}}), true);
  assert.equal(hasUnprocessedStatusEvents(text, {processedEvents: {a: "done", b: "done"}}), false);
  assert.doesNotThrow(() => pendingStatusEvents(`${JSON.stringify(first)}\n{`, {processedEvents: {}}, new Date("2026-10-15T12:00:04Z")));
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
