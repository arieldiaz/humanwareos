import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ThreadLifecycle} from './lifecycle.mjs';
import {closeThreadTool, registerHostClose} from './host-close.mjs';
import {loadSlackThreadSnapshot} from './close-report.mjs';

const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url)));
const params = {sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001', runId: 'r1'};
const route = {channel: 'C123', threadId: '1790050400.000001'};

function fixture() {
  const order = [], reports = [];
  const runtime = new ThreadLifecycle({
    record: async turn => {order.push(`record:${turn.status}`);},
    report: async turn => {order.push('report'); reports.push(turn);},
  });
  return {order, reports, runtime};
}
const toolContext = {messageChannel: 'slack', sessionKey: params.sessionKey, agentAccountId: 'max', senderIsOwner: true, assertInvocationCurrent: () => {}};

test('the plugin no longer configures an owner principal', () => {
  assert.equal(manifest.configSchema.properties.ownerUserId, undefined);
  assert.deepEqual(manifest.contracts.tools, ['start_work_thread', 'close_thread', 'switch_model']);
});

test('owner close during a run records closure and posts the report without a root reaction', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const result = await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /final response/);
  assert.deepEqual(f.order, ['record:working', 'record:closed', 'report']);
  await f.runtime.end(params);
  assert.deepEqual(f.order.slice(3), [], 'in-process, the close is the latest event, so the run end records nothing');
  assert.deepEqual(f.reports[0].route, route);
});

test('close needs no in-memory run: a tool answered elsewhere, or after a restart, still closes', async () => {
  const f = fixture();
  const result = await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.order, ['record:closed', 'report']);
  await f.runtime.end(params);
  assert.deepEqual(f.order.slice(2), [], 'an unknown run end is ignored');
});

test('the runtime owner bit is not consulted: external-harness runs always carry senderIsOwner=false', async () => {
  const f = fixture();
  for (const context of [{...toolContext, senderIsOwner: false}, (({senderIsOwner, ...rest}) => rest)(toolContext)]) {
    assert.equal((await closeThreadTool(context, {lifecycle: f.runtime}).execute()).isError, undefined);
  }
  assert.equal(f.reports.length, 2);
});

test('a stale invocation is refused before closure is recorded', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const result = await closeThreadTool({...toolContext, assertInvocationCurrent: () => { throw new Error('stale invocation'); }}, {lifecycle: f.runtime}).execute();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale invocation/);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'record:act']);
});

test('closure uses the delivery route when the harness session key is not the Slack thread', async () => {
  const f = fixture();
  await f.runtime.start(params);
  const harnessContext = {...toolContext, sessionKey: 'agent:max:acp:claude-cli:session-1', nativeChannelId: 'C123', deliveryContext: {channel: 'slack', to: 'channel:C123', threadId: route.threadId}};
  assert.equal((await closeThreadTool(harnessContext, {lifecycle: f.runtime}).execute()).isError, undefined);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'record:closed', 'report']);
});

test('the tool exists only on Slack thread sessions', () => {
  const f = fixture();
  assert.equal(closeThreadTool({...toolContext, messageChannel: 'webchat'}, {lifecycle: f.runtime}), undefined);
  assert.equal(closeThreadTool({...toolContext, sessionKey: 'agent:max:slack:direct:u1'}, {lifecycle: f.runtime}), undefined);
});

test('no close without a request: a run that never calls close_thread ends in act', async () => {
  const f = fixture();
  await f.runtime.start(params); await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'record:act']);
});

test('closed is soft: the next admitted run records normally and the thread can be closed again', async () => {
  const f = fixture();
  await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.end({...params, runId: 'r2'});
  await closeThreadTool(toolContext, {lifecycle: f.runtime}).execute();
  assert.equal(f.reports.length, 2);
});

test('an older run ending after a newer one started cannot overwrite newer lifecycle evidence', async () => {
  const f = fixture();
  await f.runtime.start(params);
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['record:working', 'record:working']);
});

test('a failing report is journaled after closure is recorded', async () => {
  const hooks = new Map(), faults = [];
  const lifecycle = registerHostClose({config: {channels: {slack: {accounts: {max: {}}}}}, on: (name, fn) => hooks.set(name, fn), registerTool() {}}, {
    isExcludedChannel: () => false,
    recordRunLifecycle: async () => {},
    appendFaultJournal: async entry => faults.push(entry),
    resolveDataRoot: () => '/nonexistent',
    resolveSlackRuntimeModule: () => new URL('./host-close.test-accounts.mjs', import.meta.url).pathname,
    slackApi: async () => { throw new Error('slack down'); },
  });
  await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max'});
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
