import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ThreadLifecycle} from './lifecycle.mjs';
import {closeThreadTool, registerHostClose} from './host-close.mjs';
import {loadSlackThreadSnapshot} from './close-report.mjs';

const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url)));
const params = {sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001', runId: 'r1'};
const route = {channel: 'C123', threadId: '1790050400.000001'};

// Stubbed host: the root tile and an ordered trace are the only observable effects.
function fixture() {
  const order = [], reports = [], root = [];
  const runtime = new ThreadLifecycle({
    record: async turn => {order.push(`record:${turn.status}`);},
    project: async status => {order.push(status); root.splice(0, root.length, {name: {working: 'arrows_counterclockwise', act: 'raised_hand', closed: 'white_check_mark'}[status], users: ['UMAX']});},
    report: async turn => {order.push('report'); reports.push(turn);},
  });
  return {order, reports, root, runtime};
}
const toolContext = {messageChannel: 'slack', sessionKey: params.sessionKey, agentAccountId: 'max', senderIsOwner: true, assertInvocationCurrent: () => {}};

test('the plugin no longer configures an owner principal', () => {
  assert.equal(manifest.configSchema.properties.ownerUserId, undefined);
  assert.deepEqual(manifest.contracts.tools, ['start_work_thread', 'close_thread', 'switch_model']);
});

test('owner close during a run: ✅ at once, the report after the run ends', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const result = await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /final response/);
  assert.deepEqual(f.root, [{name: 'white_check_mark', users: ['UMAX']}]);
  assert.equal(f.reports.length, 0, 'the report waits for the final reply');
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'working', 'record:closed', 'closed', 'report']);
  assert.deepEqual(f.root, [{name: 'white_check_mark', users: ['UMAX']}], 'the run end does not replace ✅ with ✋');
  assert.deepEqual(f.reports[0].route, route);
});

test('close after a restart: no in-memory run still closes and reports immediately', async () => {
  const f = fixture();
  const result = await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.order, ['record:closed', 'closed', 'report']);
  await f.runtime.end(params);
  assert.deepEqual(f.order.slice(3), [], 'an unknown run end is ignored');
});

test('the host refuses a close the runtime attributes to a non-owner', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const result = await closeThreadTool({...toolContext, senderIsOwner: false}, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only the owner/);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'working', 'record:act', 'act']);
});

test('an unattributed sender may close: the bridge to an external harness does not always carry the owner bit', async () => {
  const f = fixture();
  const {senderIsOwner, ...noOwnerBit} = toolContext;
  assert.equal((await closeThreadTool(noOwnerBit, {lifecycle: f.runtime}).execute()).isError, undefined);
  assert.equal(f.order.at(-1), 'report');
});

test('a stale invocation is refused before anything is projected', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const result = await closeThreadTool({...toolContext, assertInvocationCurrent: () => { throw new Error('stale invocation'); }}, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale invocation/);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'working', 'record:act', 'act']);
});

test('closure uses the delivery route when the harness session key is not the Slack thread', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const harnessContext = {...toolContext, sessionKey: 'agent:max:acp:claude-cli:session-1', nativeChannelId: 'C123', deliveryContext: {channel: 'slack', to: 'channel:C123', threadId: route.threadId}};
  assert.equal((await closeThreadTool(harnessContext, {lifecycle: f.runtime}).execute()).isError, undefined);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'working', 'record:closed', 'closed', 'report']);
});

test('the tool exists only on Slack thread sessions', () => {
  const f = fixture();
  assert.equal(closeThreadTool({...toolContext, messageChannel: 'webchat'}, {lifecycle: f.runtime}), undefined);
  assert.equal(closeThreadTool({...toolContext, sessionKey: 'agent:max:slack:direct:u1'}, {lifecycle: f.runtime}), undefined);
});

test('no close without a request: a run that never calls close_thread ends in act', async () => {
  const f = fixture();
  await f.runtime.start(params); await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'working', 'record:act', 'act']);
});

test('closed is soft: the next admitted run replaces ✅ and the thread can be closed again', async () => {
  const f = fixture();
  await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  await f.runtime.start({...params, runId: 'r2'});
  assert.deepEqual(f.root, [{name: 'arrows_counterclockwise', users: ['UMAX']}]);
  await f.runtime.end({...params, runId: 'r2'});
  assert.deepEqual(f.root, [{name: 'raised_hand', users: ['UMAX']}]);
  await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(f.reports.length, 2);
});

test('an older run ending after a newer one started cannot overwrite the newer tile', async () => {
  const f = fixture();
  await f.runtime.start(params);
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.end(params);
  assert.deepEqual(f.root, [{name: 'arrows_counterclockwise', users: ['UMAX']}]);
});

test('a failing report is journaled and leaves ✅ in place', async () => {
  const hooks = new Map(), faults = [], tiles = [];
  const lifecycle = registerHostClose({config: {channels: {slack: {accounts: {max: {}}}}}, on: (name, fn) => hooks.set(name, fn), registerTool() {}}, {
    isExcludedChannel: () => false,
    maintainStatusTile: async status => tiles.push(status),
    recordOutboundStatus: async () => {},
    appendFaultJournal: async entry => faults.push(entry),
    resolveDataRoot: () => '/nonexistent',
    resolveSlackRuntimeModule: () => new URL('./host-close.test-accounts.mjs', import.meta.url).pathname,
    slackApi: async () => { throw new Error('slack down'); },
  });
  await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max'});
  assert.deepEqual(tiles, ['closed']);
  assert.equal(faults.length, 1);
  assert.match(faults[0].reason, /Close report/);
  assert.ok(hooks.has('agent_end') && hooks.has('llm_input') && hooks.has('before_tool_call'));
});

test('large thread snapshots page with a cursor and fail closed without one', async () => {
  const calls = [];
  const pages = [
    {messages: [{ts: '1.000001'}, {ts: '2.000001'}], has_more: true, response_metadata: {next_cursor: 'next'}},
    {messages: [{ts: '3.000001'}, {ts: '5.000001'}], has_more: false, response_metadata: {next_cursor: ''}},
  ];
  const messages = await loadSlackThreadSnapshot({channel: 'C123', threadId: '1.000001', latest: '4.000001', token: 'token', call: async (method, token, body) => {
    calls.push(body); return pages[calls.length - 1];
  }});
  assert.deepEqual(messages.map(message => message.ts), ['1.000001', '2.000001', '3.000001']);
  assert.equal(calls[1].cursor, 'next');
  await assert.rejects(loadSlackThreadSnapshot({channel: 'C123', threadId: '1.000001', latest: '4.000001', token: 'token',
    call: async () => ({messages: [], has_more: true, response_metadata: {}})}), /continuation cursor/);
});
