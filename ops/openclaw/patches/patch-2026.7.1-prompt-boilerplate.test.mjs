import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-prompt-boilerplate.mjs", import.meta.url));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-boilerplate-"));
  const coreDist = path.join(root, "core");
  const slackDist = path.join(root, "slack");
  fs.mkdirSync(coreDist);
  fs.mkdirSync(slackDist);
  const coreFile = path.join(coreDist, "get-reply-fixture.js");
  const slackFile = path.join(slackDist, "shared-fixture.js");
  fs.writeFileSync(coreFile, `function buildGroupChatContext() {
\tlines.push("Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.");
\tlines.push(\`Write like a human.\${tableGuidance} Don't over-format. Avoid document-style spacing.\`);
\tlines.push("Be extremely selective: reply only when directly addressed or clearly helpful.");
\tlines.push("Be extremely selective: reply only when directly addressed or clearly helpful.");
}
`);
  fs.writeFileSync(slackFile, `const plugin = {
\tinboundFormattingHints: () => ({
\t\ttext_markup: "slack_mrkdwn",
\t\trules: ["Use *bold* and no markdown headings."]
\t}),
};
`);
  return { root, coreDist, slackDist, coreFile, slackFile };
}

test("restores the shared reply contract in Slack prompt hints", () => {
  const { root, coreDist, slackDist, coreFile, slackFile } = fixture();
  try {
    const env = { ...process.env, OPENCLAW_CORE_DIST: coreDist, OPENCLAW_SLACK_DIST: slackDist };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.match(first.core, /patched/);
    assert.equal(first.slack, "patched");
    const core = fs.readFileSync(coreFile, "utf8");
    const slack = fs.readFileSync(slackFile, "utf8");
    assert.match(core, /Follow the operator's reply-style rules/);
    assert.doesNotMatch(core, /mostly lurk/);
    assert.match(slack, /text_markup: "markdown"/);
    assert.match(slack, /## TLDR, optional ## Background/);
    assert.match(slack, /lifecycle closing section only for a real handoff/);
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.core, "already patched");
    assert.equal(second.slack, "unchanged");
    assert.equal(fs.readFileSync(coreFile, "utf8"), core);
    assert.equal(fs.readFileSync(slackFile, "utf8"), slack);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
