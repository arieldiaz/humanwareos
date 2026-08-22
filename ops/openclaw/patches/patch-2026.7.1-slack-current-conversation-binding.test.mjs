import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-slack-current-conversation-binding.mjs", import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-binding-"));
  const pluginRoot = path.join(root, "slack");
  const distDir = path.join(pluginRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "@openclaw/slack", version: "2026.7.1" }));
  fs.writeFileSync(path.join(distDir, "channel-test.js"), `const slackPlugin = createChatChannelPlugin({\n\tbase: {\n\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),\n\t\t\tmatchInboundConversation: () => true\n\t\t}\n\t}\n});\n`);
  return { root, pluginRoot, file: path.join(distDir, "channel-test.js") };
}

test("adds Slack current-conversation binding capability and is idempotent", () => {
  const { root, pluginRoot, file } = fixture();
  try {
    const env = { ...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: pluginRoot };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(first.patched, 1);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /supportsCurrentConversationBinding: true/);
    assert.match(source, /defaultTopLevelPlacement: "current"/);
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.alreadyPatched, 1);
    assert.equal(fs.readFileSync(file, "utf8"), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the plugin version changes", () => {
  const { root, pluginRoot } = fixture();
  try {
    fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "@openclaw/slack", version: "2026.8.0" }));
    assert.throws(() => execFileSync(process.execPath, [patchPath], {
      env: { ...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: pluginRoot },
      stdio: "pipe",
    }), /Unsupported Slack plugin/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
