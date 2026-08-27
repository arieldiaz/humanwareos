import fs from "node:fs";
import path from "node:path";

// A configured ACP channel binding can inherit message_tool_only from the
// source conversation even though an external ACP harness does not receive
// OpenClaw's core message tool. The harness completes normally, but
// suppressUserDelivery drops every projected reply and the channel dispatcher
// reports zero queued payloads.
//
// For a real user request whose ACP session is bound to that source
// conversation, automatic projection is the only available delivery owner.
// Keep every other ACP mode unchanged, including background and parent-stream
// sessions where suppression is intentional.

const distDir = process.env.OPENCLAW_DIST_DIR ?? "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^dispatch-acp-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const marker = "arielosProjectedFinalGuidance";
const threadContextMarker = "arielosAcpThreadHistoryBody";
const staticMarker = "arielosStaticBindingPrefix";
const legacyMarker = "arielosBoundChannelTurn";
const sessionAnchor = `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);`;
const legacySessionReplacement = `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);\n\tconst arielosBoundChannelTurn = params.sourceReplyDeliveryMode === "message_tool_only" && params.ctx.InboundEventKind === "user_request" && await hasBoundConversationForSession({\n\t\tcfg: params.cfg,\n\t\tsessionKey: canonicalSessionKey,\n\t\tchannelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,\n\t\taccountIdRaw: params.ctx.AccountId\n\t});\n\tconst arielosAcpSourceReplyDeliveryMode = arielosBoundChannelTurn ? "automatic" : params.sourceReplyDeliveryMode;`;
const sessionReplacement = `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);\n\tconst arielosBoundChannel = normalizeOptionalLowercaseString(params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider) ?? "";\n\tconst arielosBoundAccountId = normalizeOptionalLowercaseString(params.ctx.AccountId) ?? normalizeOptionalLowercaseString(params.cfg.channels?.[arielosBoundChannel]?.defaultAccount) ?? "default";\n\tconst arielosStaticBindingPrefix = \`agent:\${acpAgentId}:acp:binding:\${arielosBoundChannel}:\${arielosBoundAccountId}:\`;\n\tconst arielosBoundChannelTurn = params.sourceReplyDeliveryMode === "message_tool_only" && params.ctx.InboundEventKind === "user_request" && (canonicalSessionKey.startsWith(arielosStaticBindingPrefix) || await hasBoundConversationForSession({\n\t\tcfg: params.cfg,\n\t\tsessionKey: canonicalSessionKey,\n\t\tchannelRaw: arielosBoundChannel,\n\t\taccountIdRaw: arielosBoundAccountId\n\t}));\n\tconst arielosAcpSourceReplyDeliveryMode = arielosBoundChannelTurn ? "automatic" : params.sourceReplyDeliveryMode;`;
const suppressAnchor = `\t\tsuppressUserDelivery: params.suppressUserDelivery,`;
const suppressReplacement = `\t\tsuppressUserDelivery: arielosBoundChannelTurn ? false : params.suppressUserDelivery,`;
const promptAnchor = `\t\t\t\tsourceReplyDeliveryMode: params.sourceReplyDeliveryMode`;
const promptReplacement = `\t\t\t\tsourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode`;
const turnTextAnchor = `function resolveAcpTurnText(params) {\n\tif (params.sourceReplyDeliveryMode !== "message_tool_only") return params.promptText;`;
const turnTextReplacement = `function resolveAcpTurnText(params) {\n\tif (params.arielosProjectedFinal) {\n\t\tconst arielosProjectedFinalGuidance = prefixSystemMessage([\n\t\t\t"Source channel delivery is automatic for this bound ACP turn.",\n\t\t\t"Return only the polished user-visible reply in your final assistant text.",\n\t\t\t"Do not call message(action=send) or any CLI delivery fallback.",\n\t\t\t"Do not include progress narration, delivery tests, or internal work notes.",\n\t\t\t"OpenClaw posts the final assistant text to the source channel after the turn completes."\n\t\t].join(" "));\n\t\treturn params.promptText ? \`\${arielosProjectedFinalGuidance}\\n\\n\${params.promptText}\` : arielosProjectedFinalGuidance;\n\t}\n\tif (params.sourceReplyDeliveryMode !== "message_tool_only") return params.promptText;`;
const turnCallAnchor = `\t\t\ttext: resolveAcpTurnText({\n\t\t\t\tpromptText: turnPromptText,\n\t\t\t\tsourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode\n\t\t\t}),`;
const turnCallReplacement = `\t\t\ttext: resolveAcpTurnText({\n\t\t\t\tpromptText: turnPromptText,\n\t\t\t\tsourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode,\n\t\t\t\tarielosProjectedFinal: arielosBoundChannelTurn\n\t\t\t}),`;
const promptTextAnchor = `function resolveAcpPromptText(ctx) {\n\treturn resolveFirstContextText(ctx, [\n\t\t"BodyForAgent",\n\t\t"BodyForCommands",\n\t\t"CommandBody",\n\t\t"RawBody",\n\t\t"Body"\n\t]).trim();\n}`;
const promptTextReplacement = `function resolveAcpPromptText(ctx) {\n\tconst arielosAcpCurrentBody = resolveFirstContextText(ctx, [\n\t\t"BodyForAgent",\n\t\t"BodyForCommands",\n\t\t"CommandBody",\n\t\t"RawBody",\n\t\t"Body"\n\t]).trim();\n\tconst arielosAcpThreadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);\n\tconst arielosAcpThreadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);\n\tconst arielosAcpThreadContext = arielosAcpThreadHistoryBody ? \`[Thread history - for context]\\n\${arielosAcpThreadHistoryBody}\` : arielosAcpThreadStarterBody ? \`[Thread starter - for context]\\n\${arielosAcpThreadStarterBody}\` : "";\n\treturn [arielosAcpThreadContext, arielosAcpCurrentBody].filter(Boolean).join("\\n\\n");\n}`;

function addThreadContext(source, file) {
  if (source.includes(threadContextMarker)) return source;
  if (!source.includes(promptTextAnchor)) {
    throw new Error(`ACP prompt text anchor missing in ${file}; review the installed OpenClaw shape before patching.`);
  }
  return source.replace(promptTextAnchor, promptTextReplacement);
}

function addProjectedFinalGuidance(source, file) {
  for (const [before, after, label] of [
    [turnTextAnchor, turnTextReplacement, "projected-final prompt guidance"],
    [turnCallAnchor, turnCallReplacement, "projected-final prompt flag"],
  ]) {
    if (!source.includes(before)) {
      throw new Error(`${label} anchor missing in ${file}; review the installed OpenClaw shape before patching.`);
    }
    source = source.replace(before, after);
  }
  return source;
}

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes("async function tryDispatchAcpReply")) continue;
  if (source.includes(marker) && source.includes(threadContextMarker)) {
    alreadyPatched += 1;
    continue;
  }
  source = addThreadContext(source, file);
  if (source.includes(staticMarker)) {
    if (!source.includes(marker)) source = addProjectedFinalGuidance(source, file);
    fs.writeFileSync(file, source);
    patched += 1;
    continue;
  }
  if (source.includes(legacyMarker)) {
    if (!source.includes(legacySessionReplacement)) {
      throw new Error(`legacy bound conversation decision shape changed in ${file}; review the installed OpenClaw shape before patching.`);
    }
    source = source.replace(legacySessionReplacement, sessionReplacement);
    source = addProjectedFinalGuidance(source, file);
    fs.writeFileSync(file, source);
    patched += 1;
    continue;
  }
  for (const [before, after, label] of [
    [sessionAnchor, sessionReplacement, "bound conversation decision"],
    [suppressAnchor, suppressReplacement, "delivery suppression override"],
    [promptAnchor, promptReplacement, "ACP prompt delivery mode"],
  ]) {
    if (!source.includes(before)) {
      throw new Error(`${label} anchor missing in ${file}; review the installed OpenClaw shape before patching.`);
    }
    source = source.replace(before, after);
  }
  source = addProjectedFinalGuidance(source, file);
  fs.writeFileSync(file, source);
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error("No matching ACP dispatch bundle found; the installed OpenClaw version changed and must be reviewed.");
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
