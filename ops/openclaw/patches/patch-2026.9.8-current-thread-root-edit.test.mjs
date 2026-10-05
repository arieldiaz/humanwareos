import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-current-thread-root-edit.mjs", import.meta.url));

function fixture(version = "2026.9.8") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-current-root-edit-"));
  const coreDist = path.join(root, "core", "dist");
  fs.mkdirSync(coreDist, { recursive: true });
  fs.writeFileSync(path.join(root, "core", "package.json"), JSON.stringify({ version }));
  const bundle = path.join(coreDist, "message-action-normalization-fixture.mjs");
  fs.writeFileSync(bundle, `export function attachExternalCurrentTargetSibling(params) {
\tif (params.origin === "direct-operator" || params.actionPolicy.kind !== "conversation-read" || params.enforcement.kind !== "host-exact-current" || params.enforcement.pluginTrust !== "external") return params.ctx;
\tconst target = typeof params.ctx.params.target === "string" ? params.ctx.params.target.trim() : "";
\tif (!target) return params.ctx;
\tconst mirroredTo = params.ctx.params.to;
\tif (typeof mirroredTo !== "string" || mirroredTo.trim() !== target) return params.ctx;
\treturn params.ctx;
}
`);
  return { root, coreDist, bundle };
}

function patch(coreDist) {
  return JSON.parse(execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_CORE_DIST: coreDist },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function invocation(overrides = {}) {
  const ctx = {
    channel: "slack",
    action: "edit",
    accountId: "liv",
    requesterAccountId: "liv",
    params: {
      channel: "C123",
      messageId: "1800000000.100000",
      message: "Build: Correct root",
    },
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "C123",
      currentMessagingTarget: "channel:C123",
      currentThreadTs: "1800000000.100000",
    },
  };
  return {
    origin: "delegated",
    actionPolicy: { kind: "conversation-read" },
    enforcement: { kind: "host-exact-current", pluginTrust: "external" },
    ctx: { ...ctx, ...overrides, params: { ...ctx.params, ...overrides.params }, toolContext: { ...ctx.toolContext, ...overrides.toolContext } },
  };
}

test("infers only the trusted current Slack thread root", async () => {
  const { root, coreDist, bundle } = fixture();
  try {
    assert.deepEqual(patch(coreDist), { patched: 1, alreadyPatched: 0 });
    assert.deepEqual(patch(coreDist), { patched: 0, alreadyPatched: 1 });
    const { attachExternalCurrentTargetSibling } = await import(`${pathToFileURL(bundle)}?patched=1`);

    const accepted = attachExternalCurrentTargetSibling(invocation());
    assert.equal(accepted.params.target, "channel:C123");
    assert.equal(accepted.params.to, "channel:C123");

    for (const rejected of [
      invocation({ params: { messageId: "1800000000.200000" } }),
      invocation({ params: { target: "channel:C999" } }),
      invocation({ requesterAccountId: "max" }),
      invocation({ toolContext: { currentChannelProvider: "discord" } }),
      invocation({ channel: "discord" }),
    ]) {
      assert.strictEqual(attachExternalCurrentTargetSibling(rejected), rejected.ctx);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects other OpenClaw versions", () => {
  const { root, coreDist } = fixture("2026.9.1");
  try {
    assert.throws(() => patch(coreDist), /Unsupported OpenClaw core version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
