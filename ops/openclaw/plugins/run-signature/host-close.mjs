import {AsyncLocalStorage} from "node:async_hooks";
import {join} from "node:path";
import {
  formatCloseReport,
  writeCloseReport,
  reportParts,
  loadPullRequests,
  modelPrices,
  loadThreadUsage,
  measureSlackThread,
  recordSessionClose,
} from "./close-report.mjs";
import {ThreadLifecycle} from "./lifecycle.mjs";
import {normalizeReactions} from "./strip-core.mjs";
import {conversationFenceRoute} from "./conversation-fence.mjs";

const closeTransport = new AsyncLocalStorage();

export function isCloseTransport() {
  return Boolean(closeTransport.getStore()?.closeOperation);
}

export function shouldClaimClosedBotInbound({closingOrClosed, senderId, botUserIds}) {
  return Boolean(closingOrClosed && senderId && botUserIds?.has(senderId));
}

export async function loadSlackThreadSnapshot({channel, threadId, latest, token, call, limit = 20}) {
  const messages = [];
  let cursor;
  do {
    const page = await call("conversations.replies", token, {
      channel, ts: threadId, latest, inclusive: true, limit, ...(cursor ? {cursor} : {}),
    });
    messages.push(...(page.messages ?? []).filter(message => Number(message.ts) <= Number(latest)));
    cursor = page.response_metadata?.next_cursor;
    if (page.has_more && !cursor) throw new Error("Incomplete thread evidence without a continuation cursor");
  } while (cursor);
  return messages;
}

export function loadCoreSdk(name) {
  return import(join(process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw", "dist", "plugin-sdk", `${name}.js`));
}

export async function sendThreadMessage(config, turn, sdk) {
  return closeTransport.run(turn, async () => {
    sdk ??= await loadCoreSdk("channel-outbound");
    const parts = turn.closeOperation ? reportParts(turn.text) : [turn.text];
    for (const [index, text] of parts.entries()) {
      const id = `humanware-final:${turn.key}${turn.closeOperation ? ":part:" + index : ""}`;
      const sent = await sdk.sendDurableMessageBatch({
        cfg: config, channel: "slack", accountId: turn.accountId,
        to: `channel:${turn.route.channel}`, threadId: turn.route.threadId,
        session: sdk.buildOutboundSessionContext({cfg: config, agentId: turn.accountId, sessionKey: turn.sessionKey}),
        payloads: [{text}],
        deliveryIntentId: id, reusePendingDeliveryIntent: true,
        durability: "required", queuePolicy: "required", requireUnknownSendReconciliation: true,
        completionRetention: {idPrefix: "humanware-final:", maxAgeMs: 86400000, maxEntries: 2000},
        mirror: {sessionKey: turn.sessionKey, agentId: turn.accountId, text, idempotencyKey: id},
      });
      if (!["sent", "suppressed"].includes(sent.status)) throw sent.error ?? new Error(`Final send ${sent.status}`);
    }
  });
}

export function closeThreadTool(context, {config, lifecycle}) {
  if (context.messageChannel !== "slack" || !context.sessionKey) return;
  const accountId = context.agentAccountId ?? String(context.agentId ?? "").toLowerCase();
  const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});
  return {
    name: "close_thread",
    description: "Close this Slack thread when the current run ends. Call it only when the owner asks to close the thread, after finishing the other requested work. Only your final response after this call is delivered, so it must contain the complete answer.",
    parameters: {type: "object", additionalProperties: false},
    async execute() {
      // The run's own thread is the only input; nothing about the triggering message is required.
      const route = conversationFenceRoute({
        channel: context.nativeChannelId,
        threadId: context.deliveryContext?.threadId,
        sessionKey: context.sessionKey,
        origin: context.deliveryContext,
      });
      if (!route || !config?.channels?.slack?.accounts?.[accountId]) return reply("close_thread needs a Slack thread and a configured Slack sender", true);
      await lifecycle.requestClose(route, accountId);
      return reply("Accepted. Only your final response after this call is delivered: put the complete answer to the owner's message there, never a placeholder like \"(Final reply above.)\". The host then posts the close report and ✅; do not announce the closure yourself.");
    },
  };
}

// Slack is the record of closure: a configured bot holds ✅ on the root.
export function rootShowsClosed(reactions, botUserIds) {
  return normalizeReactions(reactions).some(reaction => reaction.name === "white_check_mark" && (reaction.users ?? []).some(user => botUserIds.has(user)));
}

export function registerHostClose(api, {
  isExcludedChannel,
  maintainStatusTile,
  recordOutboundStatus,
  appendFaultJournal,
  resolveDataRoot,
  resolveSlackRuntimeModule,
  resolveBotUserId,
  slackApi,
  botIdCache,
}) {
  const threadLeads = new Map();
  const slackAccounts = async () => {
    const accounts = await import(resolveSlackRuntimeModule("accounts"));
    const tokens = new Map(), accountByBotUserId = new Map();
    for (const accountId of Object.keys(api.config?.channels?.slack?.accounts ?? {})) {
      const token = accounts.resolveSlackAccount({cfg: api.config, accountId})?.botToken;
      const botUserId = await resolveBotUserId(token, botIdCache);
      if (token) tokens.set(accountId, token);
      if (botUserId) accountByBotUserId.set(botUserId, accountId);
    }
    return {tokens, accountByBotUserId};
  };
  const lifecycle = new ThreadLifecycle({
    closed: async (route, accountId) => {
      const {tokens, accountByBotUserId} = await slackAccounts();
      accountId = tokens.has(accountId) ? accountId : String(api.pluginConfig?.defaultSlackAccount ?? "").toLowerCase();
      const actions = await import(resolveSlackRuntimeModule("actions"));
      const reactions = await actions.listSlackReactions(route.channel, route.threadId, {cfg: api.config, accountId, token: tokens.get(accountId)});
      return rootShowsClosed(reactions, new Set(accountByBotUserId.keys()));
    },
    excluded: isExcludedChannel,
    project: async (status, turn) => {
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const token = accounts.resolveSlackAccount({cfg: api.config, accountId: turn.accountId})?.botToken;
      if (!token) throw new Error("No account token for lifecycle projection");
      await maintainStatusTile(status, {sessionKey: turn.sessionKey, runId: turn.runId}, {
        channel: turn.route.channel, rootTs: turn.route.threadId,
        routeKey: turn.conversation, accountId: turn.accountId, token,
      });
    },
    record: turn => recordOutboundStatus({dataRoot: resolveDataRoot(api.config, api.pluginConfig, turn.accountId),
      channel: turn.route.channel, threadId: turn.route.threadId, status: turn.status,
      agent: turn.accountId, sessionKey: turn.sessionKey, runId: turn.runId, recovery: turn.recovery}),
    send: turn => sendThreadMessage(api.config, turn),
    snapshot: async close => {
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const token = accounts.resolveSlackAccount({cfg: api.config, accountId: close.accountId})?.botToken;
      const snapshotThrough = close.startedAt;
      const latest = (snapshotThrough / 1000).toFixed(6);
      const messages = await loadSlackThreadSnapshot({
        channel: close.route.channel, threadId: close.route.threadId, latest, token, call: slackApi,
      });
      const stats = messages.length ? measureSlackThread(messages) : undefined;
      const usage = (await Promise.all(Object.keys(api.config?.channels?.slack?.accounts ?? {}).map(async agent => ({agent,
        usage: await loadThreadUsage({agent, channel: close.route.channel, thread: close.route.threadId, before: snapshotThrough})})))).filter(record => record.usage);
      const followUps = close.evidence.filter(turn => turn.phase === "running").map(turn => `${turn.runId}: work unresolved at closure`);
      const pullRequests = await loadPullRequests(stats?.pullRequests);
      const snapshot = {summary: stats?.topic || "Session closed", followUps, stats, usage, pullRequests,
        boundary: `thread messages and timestamped usage through reservation ${latest}; later work and this report excluded`};
      return {...snapshot, report: formatCloseReport({...snapshot, agent: close.accountId, prices: modelPrices(api.config)})};
    },
    writeReport: close => writeCloseReport({dataRoot: resolveDataRoot(api.config, api.pluginConfig, close.accountId), operationId: close.key, report: close.snapshot.report}),
    completeClose: async close => {
      await recordSessionClose({dataRoot: resolveDataRoot(api.config, api.pluginConfig, close.accountId),
        channel: close.route.channel, thread: close.route.threadId, agent: close.accountId,
        ...close.snapshot, operationId: close.key, now: new Date(close.startedAt)});
      await recordOutboundStatus({dataRoot: resolveDataRoot(api.config, api.pluginConfig, close.accountId), channel: close.route.channel, threadId: close.route.threadId, status: "closed", agent: close.accountId, sessionKey: close.sessionKey, runId: close.key});
    },
  });

  api.on("inbound_claim", async (event, ctx) => {
    if (String(event.channel ?? ctx.channelId ?? "").toLowerCase() !== "slack") return;
    const channel = String(event.conversationId ?? ctx.conversationId ?? "").replace(/^channel:/i, "").toUpperCase();
    const threadId = String(event.threadId ?? event.replyToId ?? ctx.threadId ?? event.messageId ?? "");
    const senderId = event.senderId ?? ctx.senderId;
    if (!channel || !threadId || !senderId) return;
    if (isExcludedChannel(channel)) return;
    const {accountByBotUserId} = await slackAccounts();
    const botUserIds = new Set(accountByBotUserId.keys());
    const accountId = String(event.accountId ?? ctx.accountId ?? ctx.sessionKey?.match(/^agent:([^:]+)/i)?.[1] ?? "").toLowerCase();
    // Only bot-authored messages can be fenced, so only they cost a Slack read.
    if (shouldClaimClosedBotInbound({
      closingOrClosed: botUserIds.has(senderId) && await lifecycle.isClosingOrClosed({channel, threadId}, accountId), senderId, botUserIds,
    })) return {handled: true};
    const fallback = String(api.pluginConfig?.defaultSlackAccount ?? "").toLowerCase();
    if (!fallback) return;
    if (botUserIds.has(senderId)) return {handled: true};
    const routeKey = `${channel}:${threadId}`;
    const lead = (event.wasMentioned ? accountId : "") || threadLeads.get(routeKey) || fallback;
    if (!lead) return {handled: true};
    threadLeads.set(routeKey, lead);
    if (accountId !== lead) return {handled: true};
  });
  const lifecycleHook = transition => async (event, ctx) => {
    try { await lifecycle[transition]({sessionKey: event.sessionKey ?? ctx.sessionKey, runId: event.runId ?? ctx.runId}); }
    catch (error) { await appendFaultJournal({runId: event.runId ?? ctx.runId, reason: `Lifecycle ${transition}: ${String(error)}`}); }
  };
  api.on("llm_input", lifecycleHook("start"));
  api.on("model_call_started", lifecycleHook("start"));
  api.on("agent_end", lifecycleHook("end"));
  api.on("before_tool_call", (event) => {
    const params = event.params ?? {};
    const emoji = String(params.emoji ?? "").replaceAll(":", "");
    if (/(?:^|__)message$/.test(event.toolName) && params.action === "react" &&
        (!emoji || ["arrows_counterclockwise", "raised_hand", "hand", "calendar", "white_check_mark", "🔄", "✋", "🗓", "🗓️", "✅"].includes(emoji)))
      return {block: true, blockReason: "Lifecycle reactions belong to the projector"};
  });
  api.registerTool?.({contextVersion: 2, create: context => closeThreadTool(context, {config: api.config, lifecycle})}, {name: "close_thread"});
  return lifecycle;
}
