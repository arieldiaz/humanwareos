import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// OpenClaw 2026.7.1 can persist generic current-conversation bindings for any
// channel plugin that advertises support. Slack already supplies an exact
// thread conversation id to the command/runtime context and routes replies by
// parent channel + child thread id, but its external plugin omits the one
// capability declaration. That makes `/acp spawn cursor --bind here` and the
// equivalent sessions_spawn flow reject Slack before the generic binding
// service can run.
//
// Add only the missing declaration. The generic binding database remains the
// owner of persistence and ACP remains the owner of harness dispatch.

const projectsRoot = process.env.OPENCLAW_NPM_PROJECTS_DIR ?? path.join(os.homedir(), ".openclaw", "npm", "projects");
const explicitRoot = process.env.OPENCLAW_SLACK_PLUGIN_ROOT;
const roots = explicitRoot
  ? [explicitRoot]
  : fs.existsSync(projectsRoot)
    ? fs.readdirSync(projectsRoot)
      .filter((name) => name.startsWith("openclaw-slack-"))
      .map((name) => path.join(projectsRoot, name, "node_modules", "@openclaw", "slack"))
      .filter((candidate) => fs.existsSync(candidate))
    : [];

const marker = "arielosSlackCurrentConversationBinding";
const anchor = `\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),`;
const replacement = `\t\tconversationBindings: {\n\t\t\tsupportsCurrentConversationBinding: true,\n\t\t\tdefaultTopLevelPlacement: "current",\n\t\t\tarielosSlackCurrentConversationBinding: true\n\t\t},\n\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),`;

let patched = 0;
let alreadyPatched = 0;
let candidates = 0;

for (const root of roots) {
  const packageJson = path.join(root, "package.json");
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(packageJson) || !fs.existsSync(distDir)) continue;
  const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  if (metadata.name !== "@openclaw/slack" || metadata.version !== "2026.7.1") {
    throw new Error(`Unsupported Slack plugin at ${root}: expected @openclaw/slack 2026.7.1.`);
  }
  for (const name of fs.readdirSync(distDir).filter((entry) => /^channel-.*\.js$/.test(entry))) {
    const file = path.join(distDir, name);
    let source = fs.readFileSync(file, "utf8");
    if (!source.includes("const slackPlugin = createChatChannelPlugin")) continue;
    candidates += 1;
    if (source.includes(marker)) {
      alreadyPatched += 1;
      continue;
    }
    if (!source.includes(anchor)) {
      throw new Error(`Slack channel binding anchor missing in ${file}; review the installed plugin shape before patching.`);
    }
    source = source.replace(anchor, replacement);
    fs.writeFileSync(file, source);
    patched += 1;
  }
}

if (candidates === 0) throw new Error("No OpenClaw Slack channel plugin bundle found; refresh the plugin registry before applying this patch.");
console.log(JSON.stringify({ patched, alreadyPatched, candidates, roots: roots.length }));
