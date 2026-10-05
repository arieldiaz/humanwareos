import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.8-prompt-boilerplate.mjs", import.meta.url));

function fixture(version = "2026.9.8") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-boilerplate-"));
  const coreDist = path.join(root, "core", "dist");
  const slackDist = path.join(root, "slack", "dist");
  fs.mkdirSync(coreDist, { recursive: true });
  fs.mkdirSync(path.join(slackDist, ".setup"), { recursive: true });
  fs.writeFileSync(path.join(root, "core", "package.json"), JSON.stringify({ version }));
  const coreFile = path.join(coreDist, "get-reply-fixture.mjs");
  const slackFile = path.join(slackDist, ".setup", "shared-fixture.mjs");
  fs.writeFileSync(coreFile, `function buildGroupChatContext(params) {
\tlines.push("Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.");
\tlines.push(\`Write like a human.\${tableGuidance} Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\\\n sequences; use real line breaks sparingly.\`);
}
`);
  fs.writeFileSync(slackFile, `const plugin = {
\t\t\tinboundFormattingHints: () => ({
\t\t\t\ttext_markup: "markdown",
\t\t\t\trules: [
\t\t\t\t\t"Write replies in standard Markdown; OpenClaw converts them to Slack mrkdwn.",
\t\t\t\t\t"Use presentation table blocks for tabular data; Markdown pipe tables are not auto-promoted."
\t\t\t\t]
\t\t\t}),
};
`);
  return { root, coreDist, slackDist, coreFile, slackFile };
}

test("rewrites group-chat and Slack format hints idempotently", () => {
  const { root, coreDist, slackDist, coreFile, slackFile } = fixture();
  try {
    const env = { ...process.env, OPENCLAW_CORE_DIST: coreDist, OPENCLAW_SLACK_DIST: slackDist };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.match(first.core, /patched/);
    assert.equal(first.slack, "patched");
    const core = fs.readFileSync(coreFile, "utf8");
    const slack = fs.readFileSync(slackFile, "utf8");
    assert.match(core, /governed by the operator's channel rules/);
    assert.match(core, /An explicit mention always gets a response/);
    assert.match(core, /Follow the operator's reply-style rules/);
    assert.doesNotMatch(core, /mostly lurk|document-style spacing/);
    assert.match(slack, /the gateway renders it for Slack/);
    assert.doesNotMatch(slack, /presentation table blocks/);
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.core, "already patched");
    assert.equal(second.slack, "unchanged");
    assert.equal(fs.readFileSync(coreFile, "utf8"), core);
    assert.equal(fs.readFileSync(slackFile, "utf8"), slack);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects other core versions", () => {
  const { root, coreDist, slackDist } = fixture("2026.9.1");
  try {
    const env = { ...process.env, OPENCLAW_CORE_DIST: coreDist, OPENCLAW_SLACK_DIST: slackDist };
    assert.throws(() => execFileSync(process.execPath, [patchPath], { env, stdio: "pipe" }), /Unsupported OpenClaw core version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
