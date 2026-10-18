import {resolveSlackRuntimeModule, slackApi} from '../run-signature/plugin-runtime.mjs';

const STATUS_REACTIONS = new Map([
  ['arrows_counterclockwise', 'working'],
  ['raised_hand', 'act'],
  ['hand', 'act'],
  ['calendar', 'scheduled'],
  ['white_check_mark', 'closed'],
]);

const reply = (value, isError = false) => ({
  content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}],
  ...(isError ? {isError: true} : {}),
});

export function deriveHumanStatus(reactions = [], actors = []) {
  const allowed = new Set(actors);
  const statuses = new Set();
  for (const reaction of reactions) {
    const status = STATUS_REACTIONS.get(reaction?.name);
    if (status && reaction?.users?.some((user) => allowed.has(user))) statuses.add(status);
  }
  return statuses.size === 1 ? [...statuses][0] : 'unknown';
}

async function listChannels(token, call) {
  const channels = [];
  let cursor = '';
  do {
    const page = await call('users.conversations', token, {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? {cursor} : {}),
    });
    channels.push(...(page.channels ?? []).map(({id, name, is_private}) => ({id, name, private: Boolean(is_private)})));
    cursor = page.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return channels;
}

async function resolveChannel(token, query, call) {
  const channels = await listChannels(token, call);
  const normalized = String(query ?? '').trim().replace(/^#/, '').toLowerCase();
  const channel = channels.find(({id, name}) => id.toLowerCase() === normalized || name.toLowerCase() === normalized);
  if (!channel) throw new Error(`Slack channel not found or unavailable: ${query}`);
  return channel;
}

function cleanMessage(message) {
  return {
    id: message.ts,
    user: message.user ?? message.bot_id ?? null,
    text: String(message.text ?? ''),
    replyCount: Number(message.reply_count ?? 0),
    latestReply: message.latest_reply ?? null,
  };
}

function isActiveStatus(status) {
  return status === 'working' || status === 'act' || status === 'scheduled';
}

export function createVoiceSlackTool(context, {config, tokenFor, call = slackApi}) {
  const sessionKey = config.sessionKey;
  const agentId = config.agentId ?? 'liv';
  const contextAgent = context.agentId ?? String(context.sessionKey ?? '').match(/^agent:([^:]+):/)?.[1];
  if (context.sessionKey !== sessionKey || String(contextAgent ?? '').toLowerCase() !== agentId) return;
  const actors = config.humanStatusActors ?? [];
  const accountId = config.slackAccount ?? 'liv';

  return {
    name: 'slack_workspace',
    description: 'Read and update Ariel\'s Slack workspace from the authenticated Liv voice session. Supports accessible channel discovery, thread listing and reading, replies, and new top-level threads. Never changes root status reactions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {type: 'string', enum: ['list_channels', 'list_threads', 'read_thread', 'reply_thread', 'create_thread']},
        channel: {type: 'string', description: 'Slack channel name, #name, or ID.'},
        threadId: {type: 'string', pattern: '^\\d+\\.\\d+$', description: 'Slack root message timestamp.'},
        status: {type: 'string', enum: ['any', 'active', 'working', 'act', 'scheduled', 'closed', 'unknown'], description: 'Optional thread-status filter; defaults to active.'},
        query: {type: 'string', description: 'Optional case-insensitive channel-name filter.'},
        limit: {type: 'integer', minimum: 1, maximum: 100},
        message: {type: 'string', minLength: 1, maxLength: 5000},
      },
    },
    async execute(_toolCallId, args) {
      try {
        const token = await tokenFor(accountId);
        if (!token) throw new Error(`Slack account ${accountId} is unavailable`);
        const limit = Math.min(100, Math.max(1, Number(args.limit ?? 30)));
        if (args.action === 'list_channels') {
          const query = String(args.query ?? '').trim().toLowerCase();
          const channels = (await listChannels(token, call))
            .filter(({name}) => !query || name.toLowerCase().includes(query))
            .slice(0, limit);
          return reply({channels});
        }
        if (!args.channel) throw new Error(`${args.action} requires channel`);
        const channel = await resolveChannel(token, args.channel, call);
        if (args.action === 'list_threads') {
          const statusFilter = args.status ?? 'active';
          const threads = [];
          let cursor = '';
          let pages = 0;
          do {
            const history = await call('conversations.history', token, {channel: channel.id, limit: 100, ...(cursor ? {cursor} : {})});
            threads.push(...(history.messages ?? [])
              .filter((message) => !message.thread_ts || message.thread_ts === message.ts)
              .map((message) => ({...cleanMessage(message), status: deriveHumanStatus(message.reactions, actors)}))
              .filter(({status}) => statusFilter === 'any' || (statusFilter === 'active' ? isActiveStatus(status) : status === statusFilter)));
            cursor = history.response_metadata?.next_cursor ?? '';
            pages += 1;
          } while (threads.length < limit && cursor && pages < 10);
          return reply({channel, threads: threads.slice(0, limit), truncated: Boolean(cursor)});
        }
        if (args.action === 'read_thread') {
          if (!args.threadId) throw new Error('read_thread requires threadId');
          const result = await call('conversations.replies', token, {channel: channel.id, ts: args.threadId, limit});
          const messages = (result.messages ?? []).map(cleanMessage);
          return reply({channel, threadId: args.threadId, messages});
        }
        if (args.action === 'reply_thread') {
          if (!args.threadId || !args.message?.trim()) throw new Error('reply_thread requires threadId and message');
          const result = await call('chat.postMessage', token, {channel: channel.id, thread_ts: args.threadId, text: args.message.trim(), unfurl_links: false, unfurl_media: false});
          return reply({channel, threadId: args.threadId, messageId: result.ts, posted: true});
        }
        if (args.action === 'create_thread') {
          if (!args.message?.trim()) throw new Error('create_thread requires message');
          const result = await call('chat.postMessage', token, {channel: channel.id, text: args.message.trim(), unfurl_links: false, unfurl_media: false});
          return reply({channel, threadId: result.ts, messageId: result.ts, posted: true});
        }
        throw new Error(`Unsupported action: ${args.action}`);
      } catch (error) {
        return reply(String(error?.message ?? error), true);
      }
    },
  };
}

export default {
  id: 'voice-slack',
  name: 'Voice Slack workspace',
  description: 'A session-scoped Slack workspace capability for the authenticated Liv voice interface.',
  register(api) {
    const tokenFor = async (accountId) => {
      const accounts = await import(resolveSlackRuntimeModule('accounts'));
      return accounts.resolveSlackAccount({cfg: api.config, accountId})?.botToken;
    };
    api.registerTool?.({
      contextVersion: 2,
      create: (context) => createVoiceSlackTool(context, {config: api.pluginConfig ?? {}, tokenFor}),
    }, {name: 'slack_workspace'});
  },
};
