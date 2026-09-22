import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-cli-commentary-projection.mjs", import.meta.url));
const parserFixture = `function supportsCliJsonlToolEvents() { return true; }
function parse(params, parts) {
\tlet assistantText = "", pendingClaudeText = "";
\tconst classifyClaudeCommentary = Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);
\tfor (const [kind, value] of parts) {
\t\tif (kind === "text") classifyClaudeCommentary ? pendingClaudeText += value : assistantText += value;
\t\tif (kind === "tool" && classifyClaudeCommentary) {
\t\t\tconst commentary = pendingClaudeText.trim();
\t\t\tpendingClaudeText = "";
\t\t\tif (commentary) params.onCommentaryText?.(commentary);
\t\t}
\t}
\treturn assistantText + pendingClaudeText;
}`;

test("projects CLI pre-tool text as commentary without changing terminal answers", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-commentary-"));
  const file = path.join(dist, "cli-live-session-registry-fixture.js");
  fs.writeFileSync(file, parserFixture);
  const apply = () => execFileSync(process.execPath, [patchPath], { env: { ...process.env, OPENCLAW_CORE_DIST: dist } });
  apply();
  const patched = fs.readFileSync(file, "utf8");
  const parse = Function(`${patched}; return parse;`)();
  const turn = [["text", "Checking context."], ["tool"], ["text", "## TLDR\nThe answer."]];
  assert.equal(parse({}, turn), "## TLDR\nThe answer.");
  const commentary = [];
  assert.equal(parse({ onCommentaryText: (text) => commentary.push(text) }, turn), "## TLDR\nThe answer.");
  assert.deepEqual(commentary, ["Checking context."]);
  assert.equal(parse({}, [["text", "A short answer."]]), "A short answer.");
  apply();
  assert.equal(fs.readFileSync(file, "utf8"), patched);
});
