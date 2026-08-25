import fs from "node:fs";
import path from "node:path";

// Slack thread sessions encode their bound thread timestamp in agentSessionKey,
// but createMessageTool only considers the separately supplied thread fields.
// When those fields are absent, a same-channel message-tool send silently falls
// back to a new channel root and the Slack plugin's fail-closed guard never sees
// the thread context. Recover only the canonical Slack channel/group thread key
// as the final fallback; explicit route context keeps its existing precedence.

const distDir = process.env.OPENCLAW_DIST_DIR ?? "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^openclaw-tools-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs);`;

const after = `\tconst arielosSlackThreadSessionMatch = typeof options?.agentSessionKey === "string" ? options.agentSessionKey.match(/^agent:[^:]+:slack:(?:channel|group):[^:]+:thread:([^:]+)$/i) : null;
\tconst arielosSlackThreadFromSessionKey = arielosSlackThreadSessionMatch?.[1];
\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs ?? arielosSlackThreadFromSessionKey);`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("const arielosSlackThreadFromSessionKey =")) {
    alreadyPatched += 1;
    continue;
  }
  if (!source.includes(before)) {
    continue;
  }
  fs.writeFileSync(file, source.replace(before, after));
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error(
    "No matching OpenClaw message-tool bundle found; the installed version changed and must be reviewed.",
  );
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
