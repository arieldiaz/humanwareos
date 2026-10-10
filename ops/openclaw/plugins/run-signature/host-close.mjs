import {
  formatCloseReport, writeCloseReport, loadPullRequests, modelPrices, loadThreadUsage,
  loadSlackThreadSnapshot, measureSlackThread, recordSessionClose, slackMrkdwn,
} from "./close-report.mjs";
import {ThreadLifecycle} from "./lifecycle.mjs";
import {slackRoute} from "./slack-route.mjs";

const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});

export function closeThreadTool(context, {lifecycle}) {
  if (context.messageChannel !== "slack" || !context.sessionKey) return;
  const accountId = context.agentAccountId ?? String(context.agentId ?? "").toLowerCase();
  const route = slackRoute({channel: context.nativeChannelId, threadId: context.deliveryContext?.threadId, sessionKey: context.sessionKey, origin: context.deliveryContext});
  if (!route) return;
  return {
    name: "close_thread",
    description: "Close this Slack thread. Call it only when the owner asks to close the thread, after finishing the other requested work. The host marks the root ✅ and posts the close report at once; your final reply follows it. Do not announce the closure or touch any other state after calling it.",
    parameters: {type: "object", additionalProperties: false},
    // No sender check: OpenClaw hands external-harness runs senderIsOwner=false
    // unconditionally, so the owner's request as the agent understood it is the authority.
    async execute() {
      try {
        context.assertInvocationCurrent?.();
        await lifecycle.close({route, sessionKey: context.sessionKey, accountId});
      } catch (error) {
        return reply(String(error?.message ?? error), true);
      }
      return reply("Closed: ✅ and the close report are posted. Put the complete answer to the owner's message in your final response and do nothing else.");
    },
  };
}

export function registerHostClose(api, {
  isExcludedChannel, maintainStatusTile, recordOutboundStatus, appendFaultJournal, resolveDataRoot, resolveSlackRuntimeModule, slackApi,
}) {
  const tokenFor = async accountId => (await import(resolveSlackRuntimeModule("accounts"))).resolveSlackAccount({cfg: api.config, accountId})?.botToken;

  // One measured report per close: thread shape, token usage with API cost, PRs. Written to the
  // generated session view, recorded in the ledger, and posted once in the thread by the bot.
  async function postCloseReport(turn) {
    const {channel, threadId} = turn.route;
    const token = await tokenFor(turn.accountId);
    if (!token) throw new Error(`No Slack token for ${turn.accountId}`);
    const now = Date.now();
    const messages = await loadSlackThreadSnapshot({channel, threadId, latest: (now / 1000).toFixed(6), token, call: slackApi});
    const stats = messages.length ? measureSlackThread(messages) : undefined;
    const usage = (await Promise.all(Object.keys(api.config?.channels?.slack?.accounts ?? {}).map(async agent =>
      ({agent, usage: await loadThreadUsage({agent, channel, thread: threadId, before: now})})))).filter(record => record.usage);
    const pullRequests = await loadPullRequests(stats?.pullRequests);
    const report = formatCloseReport({stats, usage, pullRequests, agent: turn.accountId, prices: modelPrices(api.config)});
    const dataRoot = resolveDataRoot(api.config, api.pluginConfig, turn.accountId);
    const operationId = `${turn.conversation}:close:${now}`;
    await writeCloseReport({dataRoot, operationId, report});
    await recordSessionClose({dataRoot, channel, thread: threadId, agent: turn.accountId, summary: stats?.topic || "Session closed", stats, usage, operationId, now: new Date(now)});
    await slackApi("chat.postMessage", token, {channel, thread_ts: threadId, text: slackMrkdwn(report), unfurl_links: false});
  }

  const lifecycle = new ThreadLifecycle({
    excluded: isExcludedChannel,
    project: async (status, turn) => {
      const token = await tokenFor(turn.accountId);
      if (!token) throw new Error("No account token for lifecycle projection");
      return maintainStatusTile(status, {sessionKey: turn.sessionKey, runId: turn.runId}, {
        channel: turn.route.channel, rootTs: turn.route.threadId, routeKey: turn.conversation, accountId: turn.accountId, token,
      });
    },
    record: turn => recordOutboundStatus({dataRoot: resolveDataRoot(api.config, api.pluginConfig, turn.accountId),
      channel: turn.route.channel, threadId: turn.route.threadId, status: turn.status, agent: turn.accountId, sessionKey: turn.sessionKey, runId: turn.runId}),
    // Best effort: ✅ is already on the root, so a report failure is journaled, never surfaced.
    report: async turn => {
      try { await postCloseReport(turn); }
      catch (error) { await appendFaultJournal({channel: turn.route.channel, rootTs: turn.route.threadId, reason: `Close report: ${String(error)}`}); }
    },
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
  api.registerTool?.({contextVersion: 2, create: context => closeThreadTool(context, {lifecycle})}, {name: "close_thread"});
  return lifecycle;
}
