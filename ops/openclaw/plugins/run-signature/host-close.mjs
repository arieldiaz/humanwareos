import {
  formatCloseReport, loadPullRequests, modelPrices, loadThreadUsage, measureSlackThread, recordSessionClose, slackMrkdwn,
} from "./close-report.mjs";
import {ThreadLifecycle} from "./lifecycle.mjs";
import {slackRoute, slackRouteKey} from "./slack-route.mjs";
import {createSessionCapture, exportSlackThread, runSessionRecords, sessionRecordId} from "./session-record.mjs";

const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});
const message = error => String(error?.message ?? error);
// The close steps session_records.py records in close.json, in order, with the name the thread sees.
const STEPS = {capture: "session record", slackThread: "Slack export", summary: "summary file", ledger: "ledger event", post: "close report post"};

export function closeThreadTool(context, {lifecycle}) {
  if (context.messageChannel !== "slack" || !context.sessionKey) return;
  const accountId = context.agentAccountId ?? String(context.agentId ?? "").toLowerCase();
  const route = slackRoute({channel: context.nativeChannelId, threadId: context.deliveryContext?.threadId, sessionKey: context.sessionKey, origin: context.deliveryContext});
  if (!route) return;
  return {
    name: "close_thread",
    description: "Close this Slack thread. Call it only when the owner asks to close the thread, after finishing the other requested work. The host records closure, seals the session record and posts the close report at once; your final reply follows it. Do not announce the closure or touch any other state after calling it.",
    parameters: {type: "object", additionalProperties: false, properties: {
      retry: {type: "boolean", description: "Only to finish an earlier close whose report named a step that was not saved: runs just the missing or failed steps."},
    }},
    // No sender check: OpenClaw hands external-harness runs senderIsOwner=false
    // unconditionally, so the owner's request as the agent understood it is the authority.
    async execute(_toolCallId, params) {
      let failed;
      try {
        context.assertInvocationCurrent?.();
        failed = await lifecycle.close({route, sessionKey: context.sessionKey, accountId, retry: params?.retry === true});
      } catch (error) {
        return reply(message(error), true);
      }
      if (failed?.length) return reply(`Closed, but these close steps failed: ${failed.join("; ")}. The thread already says so. Put the complete answer to the owner's message in your final response, with one plain line about the failure.`);
      return reply("Closed: the lifecycle record, session record and close report are done. Put the complete answer to the owner's message in your final response and do nothing else.");
    },
  };
}

export function registerHostClose(api, {
  isExcludedChannel, recordRunLifecycle, appendFaultJournal, resolveDataRoot, resolveSlackRuntimeModule, slackApi, records = runSessionRecords,
}) {
  const tokenFor = async accountId => (await import(resolveSlackRuntimeModule("accounts"))).resolveSlackAccount({cfg: api.config, accountId})?.botToken;
  const dataRootFor = accountId => resolveDataRoot(api.config, api.pluginConfig, accountId);

  // Run end: the session's record is captured in the background. No timer, never blocks the run.
  const capture = createSessionCapture((session, dataRoot) => records(dataRoot, ["write", "--session", session]),
    (session, error) => appendFaultJournal({reason: `Session record ${session}: ${message(error)}`}));

  // The close sequence. Every step is idempotent and recorded in the session folder's close.json, a failed
  // step never stops the ones that do not need it, and a retry runs only the steps not yet ok.
  // Slack is fetched and posted here; session_records.py writes every file.
  async function sealThread(turn) {
    const {channel, threadId} = turn.route;
    const dataRoot = dataRootFor(turn.accountId);
    if (!dataRoot) throw new Error("the canonical Humanware data root is unavailable");
    const now = Date.now();
    let close = {closeId: turn.retry ? undefined : `${turn.conversation}:close:${now}`, closedAt: new Date(now).toISOString(), steps: {}};
    const seal = async steps => {
      try {
        ({close} = JSON.parse(await records(dataRoot, ["seal", "--session", slackRouteKey(turn.route)],
          {input: JSON.stringify({closeId: close.closeId, closedAt: close.closedAt, retry: !close.closeId, steps})})));
      } catch (error) {
        for (const name of Object.keys(steps)) close.steps[name] = {status: "failed", error: message(error)};
      }
    };
    const pending = name => close.steps[name]?.status !== "ok";
    await seal({capture: {}});
    if (!close.closeId) throw new Error(close.steps.capture?.error ?? "no earlier close to finish");

    let token, thread, slackError;
    if (["slackThread", "summary", "ledger", "post"].some(pending)) {
      try {
        token = await tokenFor(turn.accountId);
        if (!token) throw new Error(`No Slack token for ${turn.accountId}`);
        thread = await exportSlackThread({channel, threadId, latest: (Date.parse(close.closedAt) / 1000).toFixed(6), token, call: slackApi});
      } catch (error) { slackError = error; }
    }
    const stats = thread?.messages.length ? measureSlackThread(thread.messages) : undefined;
    const before = Date.parse(close.closedAt);
    const usage = (await Promise.all(Object.keys(api.config?.channels?.slack?.accounts ?? {}).map(async agent =>
      ({agent, usage: await loadThreadUsage({agent, channel, thread: threadId, before}).catch(() => undefined)})))).filter(record => record.usage);
    const report = formatCloseReport({stats, usage, pullRequests: await loadPullRequests(stats?.pullRequests), agent: turn.accountId, prices: modelPrices(api.config)});
    const files = {
      ...(pending("slackThread") ? {slackThread: thread ? {data: thread} : {error: message(slackError)}} : {}),
      ...(pending("summary") ? {summary: {text: report}} : {}),
    };
    if (Object.keys(files).length) await seal(files);

    const outcome = task => task.then(() => ({}), error => ({error: message(error)}));
    const done = {};
    if (pending("ledger")) done.ledger = await outcome(recordSessionClose({dataRoot, channel, thread: threadId, agent: turn.accountId,
      summary: stats?.topic || "Session closed", stats, usage, operationId: close.closeId, now: new Date(close.closedAt)}));
    if (pending("post")) {
      const post = text => token ? slackApi("chat.postMessage", token, {channel, thread_ts: threadId, text, unfurl_links: false})
        : Promise.reject(slackError ?? new Error("no Slack token"));
      const missing = Object.keys(STEPS).filter(name => name !== "post" && (done[name]?.error || close.steps[name]?.status === "failed"));
      const line = missing.length ? `\n- Not saved: ${missing.map(name => STEPS[name]).join(", ")}. Say "finish closing" to retry.` : "";
      done.post = await outcome(post(slackMrkdwn(report + line)).catch(async error => {
        await post(slackMrkdwn(`Session closed, but the close report could not be posted (${message(error)}).${line}`)).catch(() => {});
        throw error;
      }));
    }
    if (Object.keys(done).length) await seal(done);
    return Object.keys(STEPS).filter(pending).map(name => `${STEPS[name]} (${close.steps[name]?.error ?? "not run"})`);
  }

  const lifecycle = new ThreadLifecycle({
    excluded: isExcludedChannel,
    record: turn => recordRunLifecycle({dataRoot: dataRootFor(turn.accountId),
      channel: turn.route.channel, threadId: turn.route.threadId, status: turn.status, agent: turn.accountId, sessionKey: turn.sessionKey, runId: turn.runId}),
    // Lifecycle is already recorded; what failed is journaled and returned so the agent can say so.
    report: async turn => {
      let failed;
      try { failed = await sealThread(turn); }
      catch (error) { failed = [`close sequence (${message(error)})`]; }
      if (failed.length) await appendFaultJournal({channel: turn.route.channel, rootTs: turn.route.threadId, reason: `Close steps failed: ${failed.join("; ")}`});
      return failed;
    },
  });

  const lifecycleHook = transition => async (event, ctx) => {
    try { await lifecycle[transition]({sessionKey: event.sessionKey ?? ctx.sessionKey, runId: event.runId ?? ctx.runId}); }
    catch (error) { await appendFaultJournal({runId: event.runId ?? ctx.runId, reason: `Lifecycle ${transition}: ${String(error)}`}); }
  };
  api.on("llm_input", lifecycleHook("start"));
  api.on("model_call_started", lifecycleHook("start"));
  api.on("agent_end", async (event, ctx) => {
    await lifecycleHook("end")(event, ctx);
    const sessionKey = event.sessionKey ?? ctx.sessionKey, dataRoot = sessionKey && dataRootFor(sessionKey.split(":")[1]);
    if (dataRoot) capture(sessionRecordId(sessionKey), dataRoot);
  });
  api.on("before_tool_call", (event) => {
    const params = event.params ?? {};
    const emoji = String(params.emoji ?? "").replaceAll(":", "");
    if (/(?:^|__)message$/.test(event.toolName) && params.action === "react" &&
        (!emoji || ["arrows_counterclockwise", "raised_hand", "hand", "calendar", "white_check_mark", "🔄", "✋", "🗓", "🗓️", "✅"].includes(emoji)))
      return {block: true, blockReason: "Slack root workflow status is human-authored"};
  });
  api.registerTool?.({contextVersion: 2, create: context => closeThreadTool(context, {lifecycle})}, {name: "close_thread"});
  return lifecycle;
}
