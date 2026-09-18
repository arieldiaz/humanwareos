import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");
const marker = "humanware:restart-recovery-capability-boundary";

function findOne(pattern, label) {
  const candidates = fs.readdirSync(distDir).filter((name) => pattern.test(name));
  if (candidates.length !== 1) throw new Error(`Expected one OpenClaw ${label} bundle, found ${candidates.length}.`);
  return path.join(distDir, candidates[0]);
}

const file = findOne(/^main-session-restart-recovery-.*\.js$/, "main-session restart recovery");
const source = fs.readFileSync(file, "utf8");

if (source.includes(marker)) {
  console.log(JSON.stringify({recoveryCapabilityBoundary: "already patched"}));
  process.exit(0);
}

const noticeBefore = "const TOMBSTONED_SESSION_NOTICE = \"I couldn't continue this session after a gateway restart. Your transcript is safe. In WebChat, use Resume in new session to continue it; in other channels, use /new or /reset to start a replacement session.\";";
const noticeAfter = "const TOMBSTONED_SESSION_NOTICE = \"I paused this work after a gateway restart because I can't prove whether the interrupted turn caused an external effect. I won't replay it automatically. Your transcript is safe. Use /new or /reset, then tell me what you want to do next.\";";
const startAnchor = "\t\tconst expectedRecoverySourceRunId = normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId);";
const endAnchor = "\n\t}\n\treturn result;\n}\n//#endregion\n//#region src/agents/main-session-recovery/main-session-restart-recovery-runtime.ts";

if (!source.includes(noticeBefore)) throw new Error("OpenClaw restart recovery notice changed and must be reviewed.");
const start = source.indexOf(startAnchor);
const end = source.indexOf(endAnchor, start);
if (start < 0 || end < 0 || source.indexOf(startAnchor, start + startAnchor.length) >= 0) throw new Error("OpenClaw restart recovery dispatch block changed and must be reviewed.");

const boundary = `\t\t// ${marker}
\t\tconst pendingAction = entry.pendingFinalDelivery ? pendingFinalRecoveryAction(entry.pendingFinalDelivery, params.stateDir) : void 0;
\t\tif (pendingAction === "defer") {
\t\t\tresult.skipped++;
\t\t\tcontinue;
\t\t}
\t\tif (pendingAction === "complete") {
\t\t\tif ((await markSessionCompletedAfterRecoveryCheckpoint({
\t\t\t\tagentId,
\t\t\t\tentry,
\t\t\t\tmessages: [],
\t\t\t\tpendingFinalDeliveryIntentId: entry.pendingFinalDelivery?.intentId,
\t\t\t\treason: "delivered-terminal-receipt",
\t\t\t\tsessionKey,
\t\t\t\tstorePath: params.storePath
\t\t\t})).outcome === "completed") {
\t\t\t\tparams.handledSessionKeys.add(resumeDedupeKey);
\t\t\t\tresult.settled++;
\t\t\t} else result.skipped++;
\t\t\tcontinue;
\t\t}
\t\tif (pendingAction === "notice") {
\t\t\tconst completed = await completePendingFinalRecoveryWithNotice(entry, sessionKey, params.storePath);
\t\t\tresult[completed ? "settled" : "skipped"]++;
\t\t\tcontinue;
\t\t}
\t\tif (pendingAction === "retry") {
\t\t\tconst pending = entry.pendingFinalDelivery;
\t\t\tconst deliveryContext = normalizeDeliveryContext(pending?.context);
\t\t\tconst originContext = normalizeDeliveryContext(deliveryContextFromSession(entry));
\t\t\tconst pendingText = pending?.kind === "replayable" && typeof pending.text === "string" ? pending.text : "";
\t\t\tconst pendingIntentId = normalizeOptionalString(pending?.intentId);
\t\t\tconst matchesOrigin = Boolean(deliveryContext && originContext && deliveryContext.channel === originContext.channel && deliveryContext.to === originContext.to && normalizeOptionalString(deliveryContext.accountId) === normalizeOptionalString(originContext.accountId) && normalizeOptionalString(deliveryContext.threadId) === normalizeOptionalString(originContext.threadId));
\t\t\tif (pendingText && pendingIntentId && matchesOrigin && isDeliverableMessageChannel(deliveryContext.channel) && resolveSendPolicy({
\t\t\t\tcfg: params.cfg,
\t\t\t\tentry,
\t\t\t\tsessionKey,
\t\t\t\tchannel: deliveryContext.channel,
\t\t\t\tchatType: entry.chatType
\t\t\t}) !== "deny") {
\t\t\t\ttry {
\t\t\t\t\tawait params.gatewayRuntime.sendRecoveryNotice({
\t\t\t\t\t\tchannel: deliveryContext.channel,
\t\t\t\t\t\tto: deliveryContext.to,
\t\t\t\t\t\taccountId: deliveryContext.accountId,
\t\t\t\t\t\tthreadId: deliveryContext.threadId,
\t\t\t\t\t\ttext: pendingText,
\t\t\t\t\t\tidempotencyKey: pendingIntentId
\t\t\t\t\t});
\t\t\t\t\tconst completion = await markSessionCompletedAfterRecoveryCheckpoint({
\t\t\t\t\t\tagentId,
\t\t\t\t\t\tentry,
\t\t\t\t\t\tmessages: [],
\t\t\t\t\t\tpendingFinalDeliveryIntentId: pendingIntentId,
\t\t\t\t\t\treason: "delivered-terminal-receipt",
\t\t\t\t\t\tsessionKey,
\t\t\t\t\t\tstorePath: params.storePath
\t\t\t\t\t});
\t\t\t\t\tif (completion.outcome === "completed") {
\t\t\t\t\t\tparams.handledSessionKeys.add(resumeDedupeKey);
\t\t\t\t\t\tresult.settled++;
\t\t\t\t\t} else result.skipped++;
\t\t\t\t} catch (error) {
\t\t\t\t\tmainSessionRecoveryLog.warn("failed exact pending-final recovery delivery " + sessionKey + ": " + String(error));
\t\t\t\t\tresult.failed++;
\t\t\t\t}
\t\t\t\tcontinue;
\t\t\t}
\t\t}
\t\tif (stopped()) return result;
\t\tconst handoff = await tombstoneMainRestartRecoveryWithNotice({
\t\t\tagentId,
\t\t\tcfg: params.cfg,
\t\t\tentry,
\t\t\tgatewayRuntime: params.gatewayRuntime,
\t\t\tobservation: recoveryView.observation,
\t\t\treason: "needs_human_reauthorization: interrupted external effects are uncertain",
\t\t\tsessionKey,
\t\t\tstorePath: params.storePath
\t\t});
\t\tif (handoff === "notice_failed") result.failed++;
\t\telse {
\t\t\tparams.handledSessionKeys.add(resumeDedupeKey);
\t\t\tresult.skipped++;
\t\t}
\t\tcontinue;`;

const bounded = source.slice(0, start) + boundary + source.slice(end);
const updated = bounded.replace(noticeBefore, noticeAfter);
fs.writeFileSync(file, updated);
console.log(JSON.stringify({recoveryCapabilityBoundary: "patched"}));
