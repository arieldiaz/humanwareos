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

const distDir = "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^dispatch-acp-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const marker = "arielosBoundChannelTurn";
const sessionAnchor = `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);`;
const sessionReplacement = `\tconst canonicalSessionKey = acpResolution.sessionKey;\n\tconst acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);\n\tconst arielosBoundChannelTurn = params.sourceReplyDeliveryMode === "message_tool_only" && params.ctx.InboundEventKind === "user_request" && await hasBoundConversationForSession({\n\t\tcfg: params.cfg,\n\t\tsessionKey: canonicalSessionKey,\n\t\tchannelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,\n\t\taccountIdRaw: params.ctx.AccountId\n\t});\n\tconst arielosAcpSourceReplyDeliveryMode = arielosBoundChannelTurn ? "automatic" : params.sourceReplyDeliveryMode;`;
const suppressAnchor = `\t\tsuppressUserDelivery: params.suppressUserDelivery,`;
const suppressReplacement = `\t\tsuppressUserDelivery: arielosBoundChannelTurn ? false : params.suppressUserDelivery,`;
const promptAnchor = `\t\t\t\tsourceReplyDeliveryMode: params.sourceReplyDeliveryMode`;
const promptReplacement = `\t\t\t\tsourceReplyDeliveryMode: arielosAcpSourceReplyDeliveryMode`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes("async function tryDispatchAcpReply")) continue;
  if (source.includes(marker)) {
    alreadyPatched += 1;
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
  fs.writeFileSync(file, source);
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error("No matching ACP dispatch bundle found; the installed OpenClaw version changed and must be reviewed.");
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
