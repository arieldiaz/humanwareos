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
// Add the missing declaration and one narrow account-default extension:
// `peer.id="*"` on a typed Slack ACP binding means "materialize the agent's
// configured ACP runtime for each concrete Slack thread or conversation".
// Exact configured bindings still win. The generic binding database remains
// the owner of persistence and ACP remains the owner of harness dispatch.
//
// Slack also admits explicit mention-only turns, but after mention removal
// those turns have no actionable body and every runtime returns zero visible
// payloads. Treat an explicit mention with no letters or numbers as a nudge to
// resume the outstanding thread request. This preserves ordinary messages and
// gives both native and ACP agents the same deterministic wake behavior.

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

const capabilityMarker = "arielosSlackCurrentConversationBinding";
const capabilityAnchor = `\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),`;
const capabilityReplacement = `\t\tconversationBindings: {\n\t\t\tsupportsCurrentConversationBinding: true,\n\t\t\tdefaultTopLevelPlacement: "current",\n\t\t\tarielosSlackCurrentConversationBinding: true\n\t\t},\n\t\tbindings: {\n\t\t\tcompileConfiguredBinding: ({ conversationId }) => normalizeSlackAcpConversationId(conversationId),`;
const wildcardMarker = "arielosSlackDefaultAcpWildcard";
const wildcardMatchAnchor = `\tif (!bindingConversationId || !conversationId) return null;\n\tif (bindingConversationId === conversationId) return {`;
const wildcardMatchReplacement = `\tif (!bindingConversationId || !conversationId) return null;\n\tconst arielosSlackDefaultAcpWildcard = bindingConversationId === "*";\n\tif (arielosSlackDefaultAcpWildcard) return {\n\t\tconversationId,\n\t\tmatchPriority: 0\n\t};\n\tif (bindingConversationId === conversationId) return {`;
const wildcardRouteMarker = "arielosSlackDefaultAcpConversationId";
const wildcardRouteAnchor = `\t\tconst configuredRoute = resolveConfiguredBindingRoute({\n\t\t\tcfg: ctx.cfg,\n\t\t\troute,\n\t\t\tconversation: {\n\t\t\t\tchannel: "slack",\n\t\t\t\taccountId: account.accountId,\n\t\t\t\tconversationId: baseConversationId\n\t\t\t}\n\t\t});`;
const wildcardRouteReplacement = `\t\tconst arielosSlackDefaultAcpConversationId = routedThreadId ?? baseConversationId;\n\t\tconst arielosSlackDefaultAcpModelOverride = ctx.cfg.channels?.modelByChannel?.slack?.[baseConversationId];\n\t\tconst configuredRoute = arielosSlackDefaultAcpModelOverride ? { bindingResolution: null, route } : resolveConfiguredBindingRoute({\n\t\t\tcfg: ctx.cfg,\n\t\t\troute,\n\t\t\tconversation: {\n\t\t\t\tchannel: "slack",\n\t\t\t\taccountId: account.accountId,\n\t\t\t\tconversationId: arielosSlackDefaultAcpConversationId,\n\t\t\t\tparentConversationId: routedThreadId ? baseConversationId : void 0\n\t\t\t}\n\t\t});`;
const mentionNudgeMarker = "arielosSlackMentionOnlyNudge";
const mentionNudgeAnchor = `\tconst { rawBody, effectiveDirectMedia } = resolvedMessageContent;`;
const mentionNudgeReplacement = `\tconst { rawBody: arielosSlackResolvedRawBody, effectiveDirectMedia } = resolvedMessageContent;\n\tconst arielosSlackMentionOnlyNudge = effectiveWasMentioned && !/[\\p{L}\\p{N}]/u.test(stripSlackMentionsForCommandDetection(arielosSlackResolvedRawBody));\n\tconst rawBody = arielosSlackMentionOnlyNudge ? "The user explicitly pinged you without adding a new request. Treat this as a nudge: review the immediately preceding unresolved user request in this Slack thread, continue the work now, and reply with the next useful result or one concise blocker. Do not merely ask what they need unless the thread contains no unresolved request." : arielosSlackResolvedRawBody;`;

let patched = 0;
let alreadyPatched = 0;
let candidates = 0;
let wildcardPatched = 0;
let wildcardAlreadyPatched = 0;
let wildcardCandidates = 0;
let mentionNudgePatched = 0;
let mentionNudgeAlreadyPatched = 0;
let mentionNudgeCandidates = 0;

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
    if (source.includes(capabilityMarker)) {
      alreadyPatched += 1;
    } else if (!source.includes(capabilityAnchor)) {
      throw new Error(`Slack channel binding anchor missing in ${file}; review the installed plugin shape before patching.`);
    } else {
      source = source.replace(capabilityAnchor, capabilityReplacement);
      patched += 1;
    }
    wildcardCandidates += 1;
    if (source.includes(wildcardMarker)) {
      wildcardAlreadyPatched += 1;
    } else if (!source.includes(wildcardMatchAnchor)) {
      throw new Error(`Slack ACP wildcard match anchor missing in ${file}; review the installed plugin shape before patching.`);
    } else {
      source = source.replace(wildcardMatchAnchor, wildcardMatchReplacement);
      wildcardPatched += 1;
    }
    fs.writeFileSync(file, source);
  }
  for (const name of fs.readdirSync(distDir).filter((entry) => /^pipeline\.runtime-.*\.js$/.test(entry))) {
    const file = path.join(distDir, name);
    let source = fs.readFileSync(file, "utf8");
    if (!source.includes("function resolveSlackRoutingContext")) continue;
    wildcardCandidates += 1;
    if (source.includes(wildcardRouteMarker)) {
      wildcardAlreadyPatched += 1;
    } else if (!source.includes(wildcardRouteAnchor)) {
      throw new Error(`Slack ACP wildcard route anchor missing in ${file}; review the installed plugin shape before patching.`);
    } else {
      source = source.replace(wildcardRouteAnchor, wildcardRouteReplacement);
      wildcardPatched += 1;
    }
    mentionNudgeCandidates += 1;
    if (source.includes(mentionNudgeMarker)) {
      mentionNudgeAlreadyPatched += 1;
    } else if (!source.includes(mentionNudgeAnchor)) {
      throw new Error(`Slack mention-only nudge anchor missing in ${file}; review the installed plugin shape before patching.`);
    } else {
      source = source.replace(mentionNudgeAnchor, mentionNudgeReplacement);
      mentionNudgePatched += 1;
    }
    fs.writeFileSync(file, source);
  }
}

if (candidates === 0) throw new Error("No OpenClaw Slack channel plugin bundle found; refresh the plugin registry before applying this patch.");
if (wildcardCandidates < 2) throw new Error("OpenClaw Slack wildcard ACP patch requires both channel and pipeline bundles.");
if (mentionNudgeCandidates === 0) throw new Error("OpenClaw Slack mention-only nudge patch requires a pipeline bundle.");
console.log(JSON.stringify({ patched, alreadyPatched, candidates, wildcardPatched, wildcardAlreadyPatched, wildcardCandidates, mentionNudgePatched, mentionNudgeAlreadyPatched, mentionNudgeCandidates, roots: roots.length }));
