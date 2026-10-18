import assert from 'node:assert/strict';
import test from 'node:test';
import plugin, {createVoiceSlackTool, deriveHumanStatus} from './index.js';

const config = {
  sessionKey: 'agent:liv:voice-chief-of-staff',
  agentId: 'liv',
  slackAccount: 'liv',
  humanStatusActors: ['OWNER'],
};

function context(overrides = {}) {
  return {sessionKey: config.sessionKey, agentId: 'liv', ...overrides};
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('derives status only from configured human actors and rejects ambiguity', () => {
  assert.equal(deriveHumanStatus([{name: 'raised_hand', users: ['OWNER']}], ['OWNER']), 'act');
  assert.equal(deriveHumanStatus([{name: 'raised_hand', users: ['BOT']}], ['OWNER']), 'unknown');
  assert.equal(deriveHumanStatus([
    {name: 'raised_hand', users: ['OWNER']},
    {name: 'calendar', users: ['OWNER']},
  ], ['OWNER']), 'unknown');
});

test('tool exists only in the exact configured Liv voice session', () => {
  const deps = {config, tokenFor: async () => 'token', call: async () => ({ok: true})};
  assert.ok(createVoiceSlackTool(context(), deps));
  assert.ok(createVoiceSlackTool(context({agentId: undefined}), deps));
  assert.equal(createVoiceSlackTool(context({sessionKey: 'agent:liv:other'}), deps), undefined);
  assert.equal(createVoiceSlackTool(context({agentId: 'max'}), deps), undefined);
});

test('lists active threads with human-owned status', async () => {
  const calls = [];
  const tool = createVoiceSlackTool(context(), {
    config,
    tokenFor: async () => 'token',
    call: async (method, _token, body) => {
      calls.push({method, body});
      if (method === 'users.conversations') return {channels: [{id: 'C1', name: 'humanware-os'}], response_metadata: {next_cursor: ''}};
      if (method === 'conversations.history') return {messages: [
        {ts: '3.0', text: 'Closed', reactions: [{name: 'white_check_mark', users: ['OWNER']}]},
        {ts: '2.0', text: 'Needs Ariel', reply_count: 2, reactions: [{name: 'raised_hand', users: ['OWNER']}]},
        {ts: '1.0', text: 'Unclassified'},
      ], response_metadata: {next_cursor: ''}};
      throw new Error(method);
    },
  });
  const result = payload(await tool.execute('call-1', {action: 'list_threads', channel: '#humanware-os'}));
  assert.deepEqual(result.threads.map(({id, status}) => ({id, status})), [{id: '2.0', status: 'act'}]);
  assert.equal(result.truncated, false);
  assert.deepEqual(calls.map(({method}) => method), ['users.conversations', 'conversations.history']);
});

test('reads and replies to a thread through the configured Slack account', async () => {
  let resolvedAccount;
  const calls = [];
  const tool = createVoiceSlackTool(context(), {
    config,
    tokenFor: async (account) => { resolvedAccount = account; return 'token'; },
    call: async (method, _token, body) => {
      calls.push({method, body});
      if (method === 'users.conversations') return {channels: [{id: 'C1', name: 'humanware-os'}], response_metadata: {next_cursor: ''}};
      if (method === 'conversations.replies') return {messages: [{ts: '1.0', text: 'Root'}, {ts: '1.1', text: 'Reply'}]};
      if (method === 'chat.postMessage') return {ts: '1.2'};
      throw new Error(method);
    },
  });
  const read = payload(await tool.execute('call-2', {action: 'read_thread', channel: 'C1', threadId: '1.0'}));
  const posted = payload(await tool.execute('call-3', {action: 'reply_thread', channel: 'C1', threadId: '1.0', message: 'Ship it'}));
  assert.equal(resolvedAccount, 'liv');
  assert.deepEqual(read.messages.map(({text}) => text), ['Root', 'Reply']);
  assert.deepEqual(posted, {channel: {id: 'C1', name: 'humanware-os', private: false}, threadId: '1.0', messageId: '1.2', posted: true});
  assert.equal(calls.at(-1).body.text, 'Ship it');
});

test('registers one context-versioned tool factory', () => {
  const registrations = [];
  plugin.register({pluginConfig: config, registerTool: (factory, options) => registrations.push({factory, options})});
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].factory.contextVersion, 2);
  assert.deepEqual(registrations[0].options, {name: 'slack_workspace'});
});
