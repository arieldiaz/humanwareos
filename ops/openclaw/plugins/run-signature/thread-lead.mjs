import {slackRoute} from "./slack-route.mjs";

// One in-memory lead per Slack thread, so two identities never answer the same
// human turn. A deliberate mention switches the lead; otherwise the current
// lead continues, or the configured default answers when none is known.
// Agent-authored messages are context, never triggers.
export function registerThreadLead(api, {isExcludedChannel, botUserIds}) {
  const leads = new Map();
  api.on("inbound_claim", async (event, ctx) => {
    if (String(event.channel ?? ctx.channelId ?? "").toLowerCase() !== "slack") return;
    const route = slackRoute({channel: event.conversationId ?? ctx.conversationId, threadId: event.threadId ?? event.replyToId ?? ctx.threadId ?? event.messageId});
    const senderId = event.senderId ?? ctx.senderId;
    if (!route || !senderId || isExcludedChannel(route.channel)) return;
    if ((await botUserIds()).has(senderId)) return {handled: true};
    const fallback = String(api.pluginConfig?.defaultSlackAccount ?? "").toLowerCase();
    if (!fallback) return;
    const accountId = String(event.accountId ?? ctx.accountId ?? ctx.sessionKey?.match(/^agent:([^:]+)/i)?.[1] ?? "").toLowerCase();
    const key = `${route.channel}:${route.threadId}`;
    const lead = (event.wasMentioned ? accountId : "") || leads.get(key) || fallback;
    leads.set(key, lead);
    if (accountId !== lead) return {handled: true};
  });
}
