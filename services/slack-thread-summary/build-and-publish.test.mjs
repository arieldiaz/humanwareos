import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { buildProjection, isMainModule, lifecycleForSession, missingRequiredConfig, renderMessage } from "./build-and-publish.mjs";

const now = new Date("2026-08-24T12:30:00.000Z");

test("maps only explicit open lifecycle states", () => {
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "1", workflow: { state: "active" } }), "active");
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "2", workflow: { state: "needs_you", emoji: "raised_hand" } }), "act");
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "3", workflow: { state: "needs_you" } }), "clarify");
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "4", workflow: { state: "scheduled" } }), "scheduled");
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "5", status: "idle" }), null);
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "6", status: "completed" }), null);
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "7", status: "active" }), null);
  assert.equal(lifecycleForSession({ channelId: "C1", threadId: "8", status: "error" }), null);
});

test("builds a versioned projection with source bounds", () => {
  const projection = buildProjection({
    schemaVersion: 1,
    generatedAt: "2026-08-24T12:00:00.000Z",
    sessions: [
      { channelId: "C1", threadId: "1", updatedAt: "2026-08-24T10:00:00Z", workflow: { state: "active" } },
      { channelId: "C1", threadId: "2", updatedAt: "2026-08-24T11:00:00Z", workflow: { state: "needs_you" } },
      { channelId: "C1", threadId: "3", updatedAt: "2026-08-24T11:30:00Z", status: "idle" },
    ],
  }, now);
  assert.deepEqual(projection.counts, { active: 1, clarify: 1, act: 0, scheduled: 0 });
  assert.equal(projection.totalOpen, 2);
  assert.equal(projection.source.earliestActivityAt, "2026-08-24T10:00:00Z");
  assert.equal(projection.source.latestActivityAt, "2026-08-24T11:00:00Z");
  assert.match(renderMessage(projection, now), /Open Slack threads/);
});

test("fails closed on stale input", () => {
  assert.throws(() => buildProjection({ generatedAt: "2026-08-23T00:00:00Z", sessions: [] }, now), /input is stale/);
});

test("reports required configuration when unset", { skip: Boolean(process.env.HUMANWARE_DATA_ROOT || process.env.SLACK_THREAD_SUMMARY_CHANNEL) }, () => {
  const missing = missingRequiredConfig();
  assert.ok(missing.includes("SLACK_THREAD_SUMMARY_CHANNEL"));
  assert.ok(missing.some((name) => name.startsWith("HUMANWARE_DATA_ROOT")));
  assert.ok(!missingRequiredConfig({ dryRun: true }).includes("SLACK_THREAD_SUMMARY_CHANNEL"));
});

test("producer defaults to a generic identifier", { skip: Boolean(process.env.SLACK_THREAD_SUMMARY_PRODUCER) }, () => {
  const projection = buildProjection({ generatedAt: "2026-08-24T12:00:00.000Z", sessions: [] }, now);
  assert.equal(projection.producer, "humanwareos/slack-thread-summary@1");
});

test("recognizes the entrypoint through a symlink and a path with a space", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread summary "));
  const real = path.join(directory, "build-and-publish.mjs");
  const link = path.join(directory, "current.mjs");
  fs.writeFileSync(real, "");
  fs.symlinkSync(real, link);
  const moduleUrl = pathToFileURL(fs.realpathSync(real)).href;
  assert.equal(isMainModule(moduleUrl, link), true);
  assert.equal(isMainModule(moduleUrl, real), true);
  assert.equal(isMainModule(moduleUrl, path.join(directory, "other.mjs")), false);
  assert.equal(isMainModule(moduleUrl, undefined), false);
});
