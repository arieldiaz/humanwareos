import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ThreadLifecycle} from './lifecycle.mjs';
import {closeThreadTool, registerHostClose} from './host-close.mjs';
import {loadSlackThreadSnapshot} from './close-report.mjs';
import {exportSlackThread, runSessionRecords} from './session-record.mjs';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
  assert.deepEqual(manifest.contracts.tools, ['start_work_thread', 'close_thread', 'set_thread_status', 'switch_model']);
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

// A stand-in for session_records.py: the same step bookkeeping, in memory.
function fakeRecords({writes = []} = {}) {
  const calls = [], state = {};
  const records = async (dataRoot, args, {input} = {}) => {
    const payload = input ? JSON.parse(input) : undefined;
    calls.push({command: args[0], session: args.at(-1), steps: Object.keys(payload?.steps ?? {}), payload});
    if (args[0] === 'write') return writes.shift()?.promise;
    if (payload.retry && !state.close) throw new Error('no close to retry');
    if (!payload.retry && state.close?.closeId !== payload.closeId) state.close = {closeId: payload.closeId, closedAt: payload.closedAt, steps: {}};
    for (const [name, step] of Object.entries(payload.steps)) {
      if (state.close.steps[name]?.status !== 'ok') state.close.steps[name] = step.error ? {status: 'failed', error: step.error} : {status: 'ok'};
    }
    return JSON.stringify({folder: '/data/x', close: structuredClone(state.close)});
  };
  return {records, calls, state};
}

async function host({slack, records, dataRoot = '/nonexistent'}) {
  const hooks = new Map(), faults = [];
  const lifecycle = registerHostClose({config: {channels: {slack: {accounts: {}}}}, on: (name, fn) => hooks.set(name, fn), registerTool() {}}, {
    isExcludedChannel: () => false,
    recordRunLifecycle: async () => {},
    appendFaultJournal: async entry => faults.push(entry),
    resolveDataRoot: () => dataRoot,
    resolveSlackRuntimeModule: () => new URL('./host-close.test-accounts.mjs', import.meta.url).pathname,
    slackApi: slack,
    records,
  });
  return {hooks, faults, lifecycle};
}

function fakeSlack({repliesError, postErrors = 0} = {}) {
  const order = [], posts = [];
  const slack = async (method, token, body) => {
    order.push(method);
    if (method === 'conversations.replies') {
      if (repliesError) throw new Error(repliesError);
      return {messages: [{ts: route.threadId, text: 'please fix', user: 'U1'}, {ts: '1790050401.000001', text: 'done', bot_id: 'B1'}]};
    }
    if (postErrors-- > 0) throw new Error('slack chat.postMessage failed: channel_not_found');
    posts.push(body.text);
    return {ok: true};
  };
  return {slack, order, posts};
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const settle = () => new Promise(done => setImmediate(done));

test('a run end starts one detached write and coalesces the ends that arrive while it runs into one more', async () => {
  const writes = [deferred(), deferred()];
  const fake = fakeRecords({writes: [...writes]});
  const {hooks} = await host({slack: fakeSlack().slack, records: fake.records});
  for (const runId of ['r1', 'r2', 'r3']) await hooks.get('agent_end')({sessionKey: params.sessionKey, runId}, {});
  await settle();
  assert.deepEqual(fake.calls.map(call => [call.command, call.session]), [['write', 'slack:C123:1790050400.000001']]);
  writes[0].resolve('{}');
  await settle();
  assert.equal(fake.calls.length, 2, 'exactly one more write for the ends that came in meanwhile');
  writes[1].resolve('{}');
  await settle();
  assert.equal(fake.calls.length, 2);
  await hooks.get('agent_end')({sessionKey: 'agent:max:cron:nightly', runId: 'r4'}, {});
  await settle();
  assert.deepEqual(fake.calls.at(-1).session, 'agent:max:cron:nightly', 'every session is captured, not only Slack threads');
});

test('a failed run-end write is journaled and never reaches the run', async () => {
  const {hooks, faults} = await host({slack: fakeSlack().slack, records: async () => { throw new Error('python3 missing'); }});
  await hooks.get('agent_end')({sessionKey: params.sessionKey, runId: 'r1'}, {});
  await settle();
  assert.match(faults[0].reason, /Session record slack:C123:1790050400.000001: python3 missing/);
});

test('close runs every step in order and records each one', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'seal-'));
  t.after(() => rm(dataRoot, {recursive: true, force: true}));
  const fake = fakeRecords(), slack = fakeSlack();
  const {lifecycle, faults} = await host({slack: slack.slack, records: fake.records, dataRoot});
  assert.deepEqual(await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max'}), []);
  assert.deepEqual(fake.calls.map(call => call.steps), [['capture'], ['slackThread', 'summary'], ['ledger', 'post']]);
  assert.deepEqual(slack.order, ['conversations.replies', 'chat.postMessage']);
  assert.equal(fake.calls[1].payload.steps.slackThread.data.messageCount, 2);
  assert.match(fake.calls[1].payload.steps.summary.text, /^\*\*Session closed\*\*/);
  assert.equal(fake.calls[2].payload.closeId, fake.calls[0].payload.closeId);
  assert.ok(Object.values(fake.state.close.steps).every(step => step.status === 'ok'));
  assert.doesNotMatch(slack.posts[0], /Not saved/);
  const [day] = await readdir(join(dataRoot, 'evidence/sessions/events'));
  assert.match(await readFile(join(dataRoot, 'evidence/sessions/events', day), 'utf8'), /"kind":"session.completed"/);
  assert.deepEqual(faults, []);
});

test('a failing Slack export still writes the summary, still posts the report, and names the failed step', async () => {
  const fake = fakeRecords(), slack = fakeSlack({repliesError: 'slack conversations.replies failed: missing_scope'});
  const {lifecycle, faults} = await host({slack: slack.slack, records: fake.records});
  const failed = await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max'});
  assert.equal(fake.state.close.steps.slackThread.status, 'failed');
  assert.equal(fake.state.close.steps.summary.status, 'ok');
  assert.equal(fake.state.close.steps.post.status, 'ok');
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0], /• Not saved: Slack export, ledger event\. Say "finish closing" to retry\.$/);
  assert.deepEqual(failed.map(line => line.split(' (')[0]), ['Slack export', 'ledger event'], 'the ledger write fails too: /nonexistent');
  assert.match(faults[0].reason, /Close steps failed: Slack export \(.*missing_scope\)/);
});

test('a failed post falls back to one short line, and a retry completes only what is missing', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'seal-'));
  t.after(() => rm(dataRoot, {recursive: true, force: true}));
  const fake = fakeRecords(), slack = fakeSlack({postErrors: 1});
  const {lifecycle} = await host({slack: slack.slack, records: fake.records, dataRoot});
  const failed = await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max'});
  assert.deepEqual(failed.map(line => line.split(' (')[0]), ['close report post']);
  assert.match(slack.posts[0], /^Session closed, but the close report could not be posted \(.*channel_not_found\)\.$/);
  const first = structuredClone(fake.state.close);
  fake.calls.length = 0;
  assert.deepEqual(await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max', retry: true}), []);
  assert.deepEqual(fake.calls.map(call => call.steps), [['capture'], ['post']], 'no re-export, no rewrite, no second ledger event');
  assert.equal(fake.calls[0].payload.retry, true);
  assert.equal(fake.state.close.closeId, first.closeId);
  assert.equal(slack.posts.length, 2);
  assert.match(slack.posts[1], /^\*Session closed\*/);
});

test('a retry with no earlier close says so instead of posting', async () => {
  const slack = fakeSlack();
  const {lifecycle} = await host({slack: slack.slack, records: fakeRecords().records});
  const failed = await lifecycle.close({route, sessionKey: params.sessionKey, accountId: 'max', retry: true});
  assert.match(failed[0], /close sequence \(.*no close to retry\)/);
  assert.deepEqual(slack.posts, []);
});

test('the tool tells the agent which close steps failed', async () => {
  const lifecycle = {close: async ({retry}) => retry ? [] : ['Slack export (missing_scope)']};
  const tool = closeThreadTool(toolContext, {lifecycle});
  assert.match((await tool.execute('call', {})).content[0].text, /failed: Slack export \(missing_scope\).*one plain line/);
  assert.match((await tool.execute('call', {retry: true})).content[0].text, /^Closed: /);
  assert.equal(tool.parameters.properties.retry.type, 'boolean');
});

test('the Slack export collects every page and lists files without downloading them', async () => {
  const calls = [];
  const pages = [
    {messages: [{ts: '1.000001', text: 'root', files: [{id: 'F1', name: 'a.png', size: 9, url_private: 'https://files/a.png', thumb_64: 'x'}]}],
     has_more: true, response_metadata: {next_cursor: 'next'}},
    {messages: [{ts: '2.000001'}, {ts: '3.000001'}], has_more: false},
  ];
  const thread = await exportSlackThread({channel: 'C123', threadId: '1.000001', latest: '9.000001', token: 'token',
    call: async (method, token, body) => { calls.push(body); return pages[calls.length - 1]; }});
  assert.equal(thread.messageCount, 3);
  assert.deepEqual(calls.map(body => [body.cursor, body.limit]), [[undefined, 200], ['next', 200]]);
  assert.deepEqual(thread.files, [{messageTs: '1.000001', id: 'F1', name: 'a.png', size: 9, url_private: 'https://files/a.png'}]);
});

test('the record writer runs session_records.py beside the plugin and surfaces its failure', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'records-'));
  t.after(() => rm(dataRoot, {recursive: true, force: true}));
  assert.equal(await runSessionRecords(dataRoot, ['index']), '');
  await assert.rejects(runSessionRecords(dataRoot, ['seal', '--session', 'slack:C1:1.1'], {input: '{"retry": true}'}), /session_records seal exited 1: ValueError: no close to retry/);
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
