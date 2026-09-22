import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^cli-live-session-registry-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `\tconst classifyClaudeCommentary = Boolean(params.onCommentaryText) && supportsCliJsonlToolEvents(params);`;
const after = `\t// humanware:project-cli-pretool-commentary\n\tconst classifyClaudeCommentary = supportsCliJsonlToolEvents(params);`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(after)) {
    alreadyPatched += 1;
    continue;
  }
  if (!source.includes(before)) continue;
  fs.writeFileSync(file, source.replace(before, after));
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error("No matching OpenClaw CLI commentary parser found; the installed version changed and must be reviewed.");
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
