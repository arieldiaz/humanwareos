import fs from "node:fs";
import path from "node:path";

// In message_tool_only delivery mode (forced for restart-recovered sessions,
// and the session-stable mode some normal turns resolve to), a completed
// turn's final text is silently discarded when the agent did not deliver via
// the message tool — the user sees status reactions and then nothing
// (2026-07-24: Liv's #marriage reply existed in her transcript, never posted).
// Upstream has a no-visible-reply fallback concept, but it is only wired for
// the Feishu channel and explicitly disabled for message_tool_only.
//
// This patch adds a channel-agnostic fallback at the dispatch drop site:
// deliver the final reply anyway IFF the turn is a real user turn and nothing
// was delivered during the run. observedReplyDelivery is set by the agent
// runner exactly when a message-tool send committed in message_tool_only mode,
// so healthy tool-using turns keep today's behavior (no duplicates).

const distDir = "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^dispatch-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
\t\t\t\tif (hasOutboundReplyContent(reply, { trimText: true })) logVerbose([
\t\t\t\t\t\`dispatch-from-config: final reply suppressed by \${deliverySuppressionReason || "source delivery policy"}\`,
\t\t\t\t\t\`(session=\${acpDispatchSessionKey ?? sessionKey ?? "unknown"}\`,
\t\t\t\t\t\`provider=\${ctx.Provider ?? "unknown"}\`,
\t\t\t\t\t\`surface=\${ctx.Surface ?? "unknown"}\`,
\t\t\t\t\t\`chatType=\${chatType ?? "unknown"}\`,
\t\t\t\t\t\`inboundEventKind=\${ctx.InboundEventKind ?? "unknown"}\`,
\t\t\t\t\t\`message=\${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"}\`,
\t\t\t\t\t\`\${formatSuppressedReplyPayloadForLog(reply)})\`
\t\t\t\t].join(" "));
\t\t\t\tcontinue;
\t\t\t}`;

const after = `if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
\t\t\t\tconst arielosUndeliveredTextFallback = sourceReplyDeliveryMode === "message_tool_only" && !sendPolicyDenied && !observedReplyDelivery && ctx.InboundEventKind !== "room_event" && ctx.Provider !== "heartbeat" && ctx.Provider !== "cron-event" && ctx.Provider !== "exec-event" && hasOutboundReplyContent(reply, { trimText: true });
\t\t\t\tif (!arielosUndeliveredTextFallback) {
\t\t\t\t\tif (hasOutboundReplyContent(reply, { trimText: true })) logVerbose([
\t\t\t\t\t\t\`dispatch-from-config: final reply suppressed by \${deliverySuppressionReason || "source delivery policy"}\`,
\t\t\t\t\t\t\`(session=\${acpDispatchSessionKey ?? sessionKey ?? "unknown"}\`,
\t\t\t\t\t\t\`provider=\${ctx.Provider ?? "unknown"}\`,
\t\t\t\t\t\t\`surface=\${ctx.Surface ?? "unknown"}\`,
\t\t\t\t\t\t\`chatType=\${chatType ?? "unknown"}\`,
\t\t\t\t\t\t\`inboundEventKind=\${ctx.InboundEventKind ?? "unknown"}\`,
\t\t\t\t\t\t\`message=\${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"}\`,
\t\t\t\t\t\t\`\${formatSuppressedReplyPayloadForLog(reply)})\`
\t\t\t\t\t].join(" "));
\t\t\t\t\tcontinue;
\t\t\t\t}
\t\t\t\tlogVerbose(\`dispatch-from-config: delivering final reply as message_tool_only fallback (no message-tool delivery observed this turn; session=\${acpDispatchSessionKey ?? sessionKey ?? "unknown"} message=\${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"})\`);
\t\t\t}`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(after)) {
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
    "No matching OpenClaw dispatch bundle found; the installed version changed and must be reviewed.",
  );
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
