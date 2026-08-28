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

const messageCandidates = fs
  .readdirSync(distDir)
  .filter((name) => /^message-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const messageActionCandidates = fs
  .readdirSync(distDir)
  .filter((name) => /^message-action-runner-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const sendCandidates = fs
  .readdirSync(distDir)
  .filter((name) => /^send-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const schemaCandidates = fs
  .readdirSync(distDir)
  .filter((name) => /^schema-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs);`;

const after = `\tconst arielosSlackThreadSessionMatch = typeof options?.agentSessionKey === "string" ? options.agentSessionKey.match(/^agent:[^:]+:slack:(?:channel|group):[^:]+:thread:([^:]+)$/i) : null;
\tconst arielosSlackThreadFromSessionKey = arielosSlackThreadSessionMatch?.[1];
\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs ?? arielosSlackThreadFromSessionKey);`;

const messageBefore = `\t\t\tthreadId: params.threadId != null ? String(params.threadId) : params.topLevel === true ? "" : void 0,`;
const messageAfter = `\t\t\tthreadId: params.threadId != null ? String(params.threadId) : void 0,
\t\t\ttopLevel: params.topLevel === true ? true : void 0,`;

const actionSendBefore = `\t\treplyToId: params.replyToId,
\t\tthreadId: params.threadId,
\t\tgifPlayback: params.gifPlayback,`;
const actionSendAfter = `\t\treplyToId: params.replyToId,
\t\tthreadId: params.threadId,
\t\ttopLevel: params.topLevel === true ? true : void 0,
\t\tgifPlayback: params.gifPlayback,`;

const actionCallBefore = `\t\treplyToId: resolvedReplyToId ?? void 0,
\t\tthreadId: resolvedThreadId ?? void 0
\t});`;
const actionCallAfter = `\t\treplyToId: resolvedReplyToId ?? void 0,
\t\tthreadId: resolvedThreadId ?? void 0,
\t\ttopLevel: params.topLevel === true ? true : void 0
\t});`;

const sendBefore = `\t\tconst threadId = normalizeOptionalString(request.threadId);`;
const sendAfter = `\t\tconst threadId = normalizeOptionalString(request.threadId);
\t\tconst topLevel = request.topLevel === true;`;
const routeBefore = `\t\t\t\t\t\tcurrentSessionKey: providedSessionKey,`;
const routeAfter = `\t\t\t\t\t\tcurrentSessionKey: topLevel ? void 0 : providedSessionKey,`;
const deliveryBefore = `\t\t\t\t\t\tthreadId: outboundRoute?.threadId ?? threadId ?? null,`;
const deliveryAfter = `\t\t\t\t\t\tthreadId: topLevel ? null : outboundRoute?.threadId ?? threadId ?? null,`;
const sessionBefore = `\t\t\t\t\tconst outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;`;
const sessionAfter = `\t\t\t\t\tconst outboundSessionKey = topLevel ? outboundRoute?.sessionKey : outboundRoute?.sessionKey ?? providedSessionKey;`;

const schemaBefore = `\t/** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
\tthreadId: Type.Optional(Type.String()),`;
const schemaAfter = `\t/** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
\tthreadId: Type.Optional(Type.String()),
\t/** Explicitly suppress inherited thread placement and send to the channel root. */
\ttopLevel: Type.Optional(Type.Boolean()),`;

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

function patchFiles(files, replacements, marker) {
  for (const file of files) {
    let source = fs.readFileSync(file, "utf8");
    if (source.includes(marker)) {
      alreadyPatched += 1;
      continue;
    }
    if (!replacements.every(({ before }) => source.includes(before))) {
      continue;
    }
    for (const replacement of replacements) {
      source = source.replace(replacement.before, replacement.after);
    }
    fs.writeFileSync(file, source);
    patched += 1;
  }
}

patchFiles(messageCandidates, [{ before: messageBefore, after: messageAfter }], "topLevel: params.topLevel === true ? true : void 0,");
patchFiles(messageActionCandidates, [
  { before: actionSendBefore, after: actionSendAfter },
  { before: actionCallBefore, after: actionCallAfter },
], "topLevel: params.topLevel === true ? true : void 0");
patchFiles(sendCandidates, [
  { before: sendBefore, after: sendAfter },
  { before: routeBefore, after: routeAfter },
  { before: deliveryBefore, after: deliveryAfter },
], "currentSessionKey: topLevel ? void 0 : providedSessionKey,");
patchFiles(sendCandidates, [{ before: sessionBefore, after: sessionAfter }], "const outboundSessionKey = topLevel ? outboundRoute?.sessionKey");
patchFiles(schemaCandidates, [{ before: schemaBefore, after: schemaAfter }], "Explicitly suppress inherited thread placement and send to the channel root.");

if (patched === 0 && alreadyPatched === 0) {
  throw new Error(
    "No matching OpenClaw message-tool bundle found; the installed version changed and must be reviewed.",
  );
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
