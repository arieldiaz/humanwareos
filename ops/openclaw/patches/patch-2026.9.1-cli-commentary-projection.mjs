import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^cli-live-session-registry-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const classificationBefore = `\tconst classifyClaudeCommentary = Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);`;
const classificationAfter = `\t// humanware:project-cli-pretool-commentary\n\tconst classifyClaudeCommentary = supportsCliJsonlToolEvents(params);`;
const boundaryBefore = `\t\t\tif (classifyClaudeCommentary) {\n\t\t\t\tif (isToolUseBlockStart) flushPendingClaudeCommentaryText();\n\t\t\t\telse if (evt.type === "content_block_start" || evt.type === "message_stop") flushPendingClaudeAssistantText();\n\t\t\t}`;
const boundaryAfter = `\t\t\tif (classifyClaudeCommentary) {\n\t\t\t\tif (isToolUseBlockStart || (evt.type === "content_block_start" && pendingClaudeText)) flushPendingClaudeCommentaryText();\n\t\t\t\telse if (evt.type === "message_stop") flushPendingClaudeAssistantText();\n\t\t\t}`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(classificationBefore) && !source.includes(classificationAfter)) continue;
  let next = source.replace(classificationBefore, classificationAfter);
  if (next.includes(boundaryBefore)) next = next.replace(boundaryBefore, boundaryAfter);
  else if (!next.includes(boundaryAfter)) throw new Error(`OpenClaw CLI commentary boundaries changed in ${file}; review before patching.`);
  if (next === source) alreadyPatched += 1;
  else {
    fs.writeFileSync(file, next);
    patched += 1;
  }
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error("No matching OpenClaw CLI commentary parser found; the installed version changed and must be reviewed.");
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
