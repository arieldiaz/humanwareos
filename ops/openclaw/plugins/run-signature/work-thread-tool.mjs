import {matchSlackChannel, startSlackWorkThread} from "../../slack-spin-out.mjs";

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

export function registerWorkThreadTool(api, {
  resolveSlackRuntimeModule,
  retrySlackRateLimit,
  maintainStatusTile,
  workThreadPosts,
}) {
  api.registerTool?.({contextVersion: 2, create: context => {
    if (context.messageChannel !== "slack") return;
    // OpenClaw's loopback MCP surface (claude-cli) omits nativeChannelId; fall back to the delivery target, then the session key.
    const currentChannel = String(
      context.nativeChannelId
        || context.deliveryContext?.to
        || /:slack:(?:channel|group):([^:]+)/i.exec(context.sessionKey ?? "")?.[1]
        || "",
    ).replace(/^channel:/i, "").toUpperCase();
    const agentId = String(context.agentId ?? "").toLowerCase();
    const accountId = context.agentAccountId ?? agentId;
    if (!currentChannel || !agentId || !accountId) return;
    return {
      name: "start_work_thread",
      description: "Start substantial Slack work in its normal shape with one call: the title as one top-level channel post, a working status, and a durable high-reasoning session that receives the brief, replies in that thread, and begins immediately. Use this instead of separate message and sessions_spawn calls.",
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
              return api.runtime.gateway.request("send", params);
            },
            prepareScaffold: clearScaffold,
            setStatus: ({rootMessageId, status}) => maintainStatusTile(status, context, {
              channel,
              rootTs: rootMessageId,
              routeKey: `${channel.toLowerCase()}:${rootMessageId}`,
              accountId,
              token,
            }),
            createSession: (params) => api.runtime.gateway.request("sessions.create", params),
          });
          return {content: [{type: "text", text: JSON.stringify(result)}], details: result};
        } catch (error) {
          return {content: [{type: "text", text: String(error?.message ?? error)}], isError: true};
        }
      },
    };
  }}, {name: "start_work_thread"});
}
