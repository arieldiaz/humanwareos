import {matchSlackChannel, startSlackWorkThread} from "../../slack-spin-out.mjs";
import {resolveSlackChannel} from "./slack-route.mjs";

async function listSlackChannels(token) {
  const channels = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? {cursor} : {})});
    const response = await (await fetch(`https://slack.com/api/users.conversations?${query}`, {headers: {authorization: `Bearer ${token}`}})).json();
    if (!response.ok) throw new Error(`Slack channel lookup failed: ${response.error}`);
    channels.push(...response.channels.map(({id, name}) => ({id, name})));
    cursor = response.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return channels;
}

// A work thread is a root conversation: its session is the one the Slack
// adapter routes the human's replies in that thread to, so it has the root tool
// surface and the agent's default reasoning. A sub-agent key would make it a
// leaf worker.
function slackThreadSessionKey(api, {accountId, channel, rootMessageId}) {
  const route = api.runtime.channel.routing.resolveAgentRoute({cfg: api.config, channel: "slack", accountId, peer: {kind: "channel", id: channel}});
  return `${route.sessionKey}:thread:${rootMessageId}`;
}

async function createWorkSession(api, params, checkBacks) {
  const key = slackThreadSessionKey(api, params);
  // No thread starts without a check-back: a registration failure stops here, before the first turn.
  await checkBacks.register(key);
  let started;
  try {
    started = await api.runtime.subagent.run({
      sessionKey: key,
      message: params.task,
      deliver: false,
      idempotencyKey: params.idempotencyKey,
    });
  } catch (error) {
    await checkBacks.remove(key).catch(() => {});
    throw error;
  }
  await api.runtime.agent.session.patchSessionEntry({
    sessionKey: key,
    update: () => ({
      label: params.label,
      displayName: params.label,
      ...(params.category ? {category: params.category} : {}),
    }),
  });
  return {key: started.sessionKey ?? key, runId: started.runId, runStarted: true};
}

export function registerWorkThreadTool(api, {
  resolveSlackRuntimeModule,
  retrySlackRateLimit,
  workThreadPosts,
  checkBacks,
}) {
  api.registerTool?.({contextVersion: 2, create: context => {
    if (context.messageChannel !== "slack") return;
    const currentChannel = resolveSlackChannel({channel: context.nativeChannelId, origin: context.deliveryContext, sessionKey: context.sessionKey});
    const agentId = String(context.agentId ?? "").toLowerCase();
    const accountId = context.agentAccountId ?? agentId;
    if (!currentChannel || !agentId || !accountId) return;
    return {
      name: "start_work_thread",
      description: "Start substantial Slack work in its normal shape with one call: the title as one top-level channel post, a short summary for the human as its first reply, and that thread's own root session, which receives the brief, replies in the thread, and begins immediately. Use this instead of separate message and sessions_spawn calls.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "detail"],
        properties: {
          title: {type: "string", minLength: 1, description: "The whole top-level post: one line, type word, colon, short summary (e.g. \"Fix: raw JSON wrapper in Slack replies\")."},
          summary: {type: "string", minLength: 1, maxLength: 600, description: "The first reply, written for the human: what this thread is for and what it will need from them, in a few plain lines."},
          detail: {type: "string", minLength: 1, description: "Complete work brief for the session only; never posted in Slack."},
          channel: {type: "string", description: "Optional target channel: a loose name (\"humanware\", \"#inbox\") or ID. Defaults to the current channel."},
          group: {type: "string", description: "Optional dashboard group."},
        },
      },
      async execute(toolCallId, args) {
        try {
          const accounts = await import(resolveSlackRuntimeModule("accounts"));
          const token = accounts.resolveSlackAccount({cfg: api.config, accountId})?.botToken;
          if (!token) throw new Error(`Slack account ${accountId} has no bot token`);
          const clearScaffold = async ({messageIds}) => {
            try {
              const actions = await import(resolveSlackRuntimeModule("actions"));
              const opts = {cfg: api.config, accountId, token};
              for (const messageId of messageIds) {
                await retrySlackRateLimit(() => actions.removeOwnSlackReactions(channel, messageId, opts));
              }
            } catch (error) {
              api.logger?.warn?.(`run-signature could not clear scaffold reactions: ${String(error)}`);
            }
          };
          const channel = args.channel?.trim()
            ? matchSlackChannel(args.channel, await listSlackChannels(token))
            : currentChannel;
          const outbound = await api.runtime.channel.outbound.loadAdapter("slack");
          if (!outbound?.sendText) throw new Error("Slack outbound text adapter is unavailable");
          const result = await startSlackWorkThread({
            accountId,
            agentId,
            channel,
            title: args.title,
            summary: args.summary,
            detail: args.detail,
            group: args.group,
            operationId: toolCallId,
            send: (params) => {
              workThreadPosts.add(String(params.message).trim());
              return outbound.sendText({
                cfg: api.config,
                to: params.to,
                text: params.message,
                accountId,
                threadId: params.threadId,
                deliveryQueueId: params.idempotencyKey,
              });
            },
            prepareScaffold: clearScaffold,
            createSession: (params) => createWorkSession(api, params, checkBacks),
          });
          return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
        } catch (error) {
          return {content: [{type: "text", text: String(error?.message ?? error)}], isError: true};
        }
      },
    };
  }}, {name: "start_work_thread"});
}
