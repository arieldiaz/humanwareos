import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-cli-commentary-projection.mjs", import.meta.url));
const parserFixture = `function supportsCliJsonlToolEvents() { return true; }
function parse(params, events) {
\tlet assistantText = "", pendingClaudeText = "";
\tconst classifyClaudeCommentary = Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
\tconst flushPendingClaudeAssistantText = () => { assistantText += pendingClaudeText; pendingClaudeText = ""; };
\tconst flushPendingClaudeCommentaryText = () => {
\t\tconst commentary = pendingClaudeText.trim();
\t\tpendingClaudeText = "";
\t\tif (commentary) params.onCommentaryText?.(commentary);
\t};
\tfor (const evt of events) {
\t\tconst isToolUseBlockStart = evt.type === "content_block_start" && evt.content_block?.type === "tool_use";
\t\tif (classifyClaudeCommentary) {
\t\t\tif (isToolUseBlockStart) flushPendingClaudeCommentaryText();
\t\t\telse if (evt.type === "content_block_start" || evt.type === "message_stop") flushPendingClaudeAssistantText();
\t\t}
\t\tif (evt.type === "text") classifyClaudeCommentary ? pendingClaudeText += evt.value : assistantText += evt.value;
\t}
\treturn assistantText;
}`;

test("projects non-terminal CLI text blocks as commentary without changing terminal answers", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-commentary-"));
  const file = path.join(dist, "cli-live-session-registry-fixture.js");
  fs.writeFileSync(file, parserFixture);
  const apply = () => execFileSync(process.execPath, [patchPath], { env: { ...process.env, OPENCLAW_CORE_DIST: dist } });
  apply();
  const patched = fs.readFileSync(file, "utf8");
  const parse = Function(`${patched}; return parse;`)();
  const block = (type = "text") => ({ type: "content_block_start", content_block: { type } });
  const text = (value) => ({ type: "text", value });
  const stop = { type: "message_stop" };
  const noToolTurn = [block(), text("I'll match Liv's voice."), block(), text("## TLDR\nThe answer."), stop];
  const commentary = [];
  assert.equal(parse({ onCommentaryText: (value) => commentary.push(value) }, noToolTurn), "## TLDR\nThe answer.");
  assert.deepEqual(commentary, ["I'll match Liv's voice."]);
  assert.equal(parse({}, noToolTurn), "## TLDR\nThe answer.");
  const toolTurn = [block(), text("Checking context."), block("tool_use"), block(), text("## TLDR\nThe answer."), stop];
  const toolCommentary = [];
  assert.equal(parse({ onCommentaryText: (value) => toolCommentary.push(value) }, toolTurn), "## TLDR\nThe answer.");
  assert.deepEqual(toolCommentary, ["Checking context."]);
  assert.equal(parse({}, [block(), text("A short answer."), stop]), "A short answer.");
  apply();
  assert.equal(fs.readFileSync(file, "utf8"), patched);
});
