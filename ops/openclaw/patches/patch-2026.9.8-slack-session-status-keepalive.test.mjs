import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-slack-session-status-keepalive.mjs", import.meta.url));

function fixture(version = "2026.9.8") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-status-"));
  const pluginRoot = path.join(root, "slack");
  const setupDir = path.join(pluginRoot, "dist", ".setup");
  fs.mkdirSync(setupDir, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ version }));
  const bundle = path.join(setupDir, "pipeline.runtime-fixture.mjs");
  fs.writeFileSync(bundle, `export function makeCallbacks({ ctx, message, statusThreadTs, prepared, threadStatusGate, typingReaction, reactSlackMessage }) {
\tlet didSetStatus = false;
\tlet statusWasSet = false;
\tlet didAddTypingReaction = false;
\treturn {
\t\t\tstart: async () => {
\t\t\t\tif (!didSetStatus && !threadStatusGate.hasVisibleOutput()) {
\t\t\t\t\tdidSetStatus = true;
\t\t\t\t\tstatusWasSet = await ctx.setSlackSessionStatus({
\t\t\t\t\t\tchannelId: message.channel,
\t\t\t\t\t\tthreadTs: statusThreadTs,
\t\t\t\t\t\tstatus: "processing",
\t\t\t\t\t\ttitle: prepared.sessionDisplayName ?? prepared.ctxPayload.ThreadLabel,
\t\t\t\t\t\teventScope: prepared.eventScope
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\tif (typingReaction && message.ts) {
\t\t\t\t\tdidAddTypingReaction = true;
\t\t\t\t\tawait reactSlackMessage(message.channel, message.ts, typingReaction, {});
\t\t\t\t}
\t\t\t},
\t\t\tstate: () => ({ didSetStatus, statusWasSet, didAddTypingReaction })
\t};
}
`);
  return { root, pluginRoot, bundle };
}

function apply(pluginRoot) {
  return JSON.parse(execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: pluginRoot },
    encoding: "utf8",
  }));
}

test("refreshes processing status while keeping the reaction single-shot", async () => {
  const { root, pluginRoot, bundle } = fixture();
  try {
    assert.deepEqual(apply(pluginRoot), { patched: 1, alreadyPatched: 0 });
    assert.deepEqual(apply(pluginRoot), { patched: 0, alreadyPatched: 1 });
    const { makeCallbacks } = await import(`${pathToFileURL(bundle)}?patched=1`);
    const statuses = [];
    const reactions = [];
    const callbacks = makeCallbacks({
      ctx: { setSlackSessionStatus: async (value) => (statuses.push(value.status), true) },
      message: { channel: "C123", ts: "1800000000.100000" },
      statusThreadTs: "1800000000.000001",
      prepared: { sessionDisplayName: "Liv", ctxPayload: {}, eventScope: {} },
      threadStatusGate: { hasVisibleOutput: () => false },
      typingReaction: "hourglass",
      reactSlackMessage: async (...args) => reactions.push(args),
    });

    await callbacks.start();
    await callbacks.start();
    assert.deepEqual(statuses, ["processing", "processing"]);
    assert.equal(reactions.length, 1);
    assert.deepEqual(callbacks.state(), { didSetStatus: true, statusWasSet: true, didAddTypingReaction: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects other Slack plugin versions", () => {
  const { root, pluginRoot } = fixture("2026.9.1");
  try {
    assert.throws(() => apply(pluginRoot), /Unsupported Slack plugin version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
