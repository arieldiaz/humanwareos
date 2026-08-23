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
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({ name: "@openclaw/slack", version: "2026.7.1", type: "module" }));
  fs.writeFileSync(path.join(distDir, "channel-test.js"), `const normalizeSlackAcpConversationId = (raw) => raw ? {conversationId: String(raw).toLowerCase()} : null;\nfunction matchSlackAcpConversation(params) {\n\tconst bindingConversationId = normalizeSlackAcpConversationId(params.bindingConversationId)?.conversationId;\n\tconst conversationId = normalizeSlackAcpConversationId(params.conversationId)?.conversationId;\n\tconst parentConversationId = normalizeSlackAcpConversationId(params.parentConversationId)?.conversationId;\n\tif (!bindingConversationId || !conversationId) return null;\n\tif (bindingConversationId === conversationId) return {\n\t\tconversationId,\n\t\tmatchPriority: 2\n\t};\n\tif (parentConversationId && parentConversationId !== conversationId && bindingConversationId === parentConversationId) return {\n\t\tconversationId: parentConversationId,\n\t\tmatchPriority: 1\n\t};\n\treturn null;\n}\nconst createChatChannelPlugin = (value) => value;\nconst slackPlugin = createChatChannelPlugin({\n\tbase: {\n\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),\n\t\t\tmatchInboundConversation: () => true\n\t\t}\n\t}\n});\nexport {matchSlackAcpConversation, slackPlugin};\n`);
  fs.writeFileSync(path.join(distDir, "pipeline.runtime-test.js"), `function resolveSlackRoutingContext(params) {\n\tif (runtimeRoute.boundSessionKey) route = runtimeRoute.route;\n\telse {\n\t\tconst configuredRoute = resolveConfiguredBindingRoute({\n\t\t\tcfg: ctx.cfg,\n\t\t\troute,\n\t\t\tconversation: {\n\t\t\t\tchannel: "slack",\n\t\t\t\taccountId: account.accountId,\n\t\t\t\tconversationId: baseConversationId\n\t\t\t}\n\t\t});\n\t}\n}\n`);
  return {
    root,
    pluginRoot,
    channelFile: path.join(distDir, "channel-test.js"),
    pipelineFile: path.join(distDir, "pipeline.runtime-test.js"),
  };
}

test("adds current-conversation support plus account-default ACP routing and is idempotent", async () => {
  const { root, pluginRoot, channelFile, pipelineFile } = fixture();
  try {
    const env = { ...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: pluginRoot };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(first.patched, 1);
    assert.equal(first.wildcardPatched, 2);
    const channelSource = fs.readFileSync(channelFile, "utf8");
    const pipelineSource = fs.readFileSync(pipelineFile, "utf8");
    assert.match(channelSource, /supportsCurrentConversationBinding: true/);
    assert.match(channelSource, /defaultTopLevelPlacement: "current"/);
    assert.match(channelSource, /arielosSlackDefaultAcpWildcard/);
    assert.match(channelSource, /matchPriority: 0/);
    assert.match(pipelineSource, /const arielosSlackDefaultAcpConversationId = routedThreadId \?\? baseConversationId/);
    assert.match(pipelineSource, /const arielosSlackDefaultAcpModelOverride = ctx\.cfg\.channels\?\.modelByChannel\?\.slack\?\.\[baseConversationId\]/);
    assert.match(pipelineSource, /arielosSlackDefaultAcpModelOverride \? \{ bindingResolution: null, route \} : resolveConfiguredBindingRoute/);
    assert.match(pipelineSource, /conversationId: arielosSlackDefaultAcpConversationId/);
    assert.match(pipelineSource, /parentConversationId: routedThreadId \? baseConversationId : void 0/);
    const { matchSlackAcpConversation } = await import(`${new URL(`file://${channelFile}`).href}?patched=1`);
    assert.deepEqual(matchSlackAcpConversation({
      bindingConversationId: "*",
      conversationId: "THREAD-1",
      parentConversationId: "CHANNEL-1",
    }), {conversationId: "thread-1", matchPriority: 0});
    assert.deepEqual(matchSlackAcpConversation({
      bindingConversationId: "CHANNEL-1",
      conversationId: "THREAD-1",
      parentConversationId: "CHANNEL-1",
    }), {conversationId: "channel-1", matchPriority: 1});
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.alreadyPatched, 1);
    assert.equal(second.wildcardAlreadyPatched, 2);
    assert.equal(fs.readFileSync(channelFile, "utf8"), channelSource);
    assert.equal(fs.readFileSync(pipelineFile, "utf8"), pipelineSource);
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
