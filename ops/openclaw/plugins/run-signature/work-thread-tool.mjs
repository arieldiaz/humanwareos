import {matchSlackChannel, startSlackWorkThread} from "../../slack-spin-out.mjs";
import {resolveSlackChannel} from "./slack-route.mjs";
import {createHash} from "node:crypto";

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

function workSessionKey(agentId, operationId) {
  const id = createHash("sha256").update(String(operationId)).digest("hex").slice(0, 20);
  return `agent:${agentId}:subagent:work-thread-${id}`;
}

async function createWorkSession(api, params) {
  const key = workSessionKey(params.agentId, params.idempotencyKey);
  const thinking = await api.runtime.subagent.run({
    sessionKey: key,
    message: "/think high",
    disableTools: true,
    deliver: false,
    idempotencyKey: `${params.idempotencyKey}:thinking`,
  });
  const configured = await api.runtime.subagent.waitForRun({runId: thinking.runId, timeoutMs: 30_000});
  if (configured.status !== "ok") {
    throw new Error(configured.error ?? `work session reasoning setup ${configured.status}`);
  }
  await api.runtime.agent.session.patchSessionEntry({
    sessionKey: key,
    update: () => ({
      label: params.label,
      displayName: params.label,
      ...(params.category ? {category: params.category} : {}),
    }),
  });
  const started = await api.runtime.subagent.run({
    sessionKey: key,
    message: params.task,
    deliver: false,
    idempotencyKey: params.idempotencyKey,
  });
  return {key: started.sessionKey ?? key, runId: started.runId, runStarted: true};
}

export function registerWorkThreadTool(api, {
  resolveSlackRuntimeModule,
  retrySlackRateLimit,
  workThreadPosts,
}) {
  api.registerTool?.({contextVersion: 2, create: context => {
    if (context.messageChannel !== "slack") return;
    const currentChannel = resolveSlackChannel({channel: context.nativeChannelId, origin: context.deliveryContext, sessionKey: context.sessionKey});
    const agentId = String(context.agentId ?? "").toLowerCase();
    const accountId = context.agentAccountId ?? agentId;
    if (!currentChannel || !agentId || !accountId) return;
    return {
      name: "start_work_thread",
      description: "Start substantial Slack work in its normal shape with one call: the title as one top-level channel post and a durable high-reasoning session that receives the brief, replies in that thread, and begins immediately. Use this instead of separate message and sessions_spawn calls.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail"],
        properties: {
          title: {type: "string", minLength: 1, description: "The whole top-level post: one line, type word, colon, short summary (e.g. \"Fix: raw JSON wrapper in Slack replies\")."},
          detail: {type: "string", minLength: 1, description: "Complete work brief for the session; not posted at the root."},
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
            detail: args.detail,
            group: args.group,
            parentSessionKey: context.sessionKey,
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
            createSession: (params) => createWorkSession(api, params),
          });
          return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
        } catch (error) {
          return {content: [{type: "text", text: String(error?.message ?? error)}], isError: true};
        }
      },
    };
  }}, {name: "start_work_thread"});
}
