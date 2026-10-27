import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {Channel, gatewayCall, historyReply, routeMention, sessionKeyFor} from './channel.mjs';
import {NotionClient} from './notion.mjs';
import {Store} from './store.mjs';

const config = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url)));
const OWNER = config.ownerUserId;
const OTHER = '00000000-0000-4000-8000-000000000002';
const agents = {
  liv: {aliases: ['liv'], botUserId: '00000000-0000-4000-8000-0000000000b1'},
  max: {aliases: ['max'], botUserId: '00000000-0000-4000-8000-0000000000b2'},
};
const text = content => ({type: 'text', text: {content}, plain_text: content});
const userMention = id => ({type: 'mention', mention: {type: 'user', user: {object: 'user', id}}, plain_text: '@Anonymous'});
const visible = value => ({status: 'ok', terminalReply: {disposition: 'visible', text: value}});

// Synthetic Notion API per agent connection and a scripted gateway.
function fixture({comments = {}, gateway = {}, directory = mkdtempSync(join(tmpdir(), 'notion-comments-')), store, clock = {t: 0}} = {}) {
  store ??= new Store(join(directory, 'comments.sqlite3'));
  const calls = [], replies = [], sleeps = [];
  const notion = Object.fromEntries(Object.keys(agents).map(agent => [agent, {
    comment: async id => { const c = comments[id]; if (!c) throw Object.assign(new Error('missing'), {status: 404}); return {id, parent: {type: 'page_id', page_id: 'page-1'}, ...c}; },
    page: async () => ({url: 'https://www.notion.so/page-1', properties: {Name: {type: 'title', title: [text('Plan\nQ4')]}}}),
    reply: async value => { if (gateway.replyError) throw gateway.replyError; replies.push({agent, ...value}); return {id: `reply-${replies.length}`}; },
  }]));
  const call = async (method, params) => {
    calls.push({method, params});
    if (method === 'agent') return gateway.admit ? gateway.admit(params) : {runId: `run-${params.agentId}-${calls.filter(c => c.method === 'agent').length}`, status: 'accepted'};
    if (method === 'agent.wait') return gateway.wait ? gateway.wait(params) : visible(`answer for ${params.runId}`);
    if (method === 'chat.history') return gateway.history ? gateway.history(params) : {messages: []};
    throw new Error(`unexpected ${method}`);
  };
  const channel = new Channel({store, notion, agents, config, requestsDir: join(directory, 'requests'), call, now: () => clock.t,
    sleep: async ms => { sleeps.push(ms); clock.t += ms; if (gateway.sleep) await gateway.sleep(); }});
  const deliver = (id, to = Object.keys(agents)) => to.map(agent => channel.receive(agent, {id: `event-${id}-${agent}`, type: 'comment.created', entity: {id, type: 'comment'}, data: {page_id: 'page-1'}}));
  const run = async () => { await channel.drain(); await channel.idle(); };
  const admitted = () => calls.filter(c => c.method === 'agent');
  return {store, channel, calls, replies, sleeps, deliver, run, admitted, directory, clock,
    cleanup: () => { store.close(); rmSync(directory, {recursive: true, force: true}); }};
}

test('routes the first mention by agent bot user or start-of-word alias', () => {
  assert.equal(routeMention([text('hey @LIV, look')], agents), 'liv');
  assert.equal(routeMention([text('(@max) and @liv')], agents), 'max');
  assert.equal(routeMention([userMention(agents.max.botUserId), text(' @liv')], agents), 'max');
  assert.equal(routeMention([userMention(OTHER), text('mail me@liv.example or @olivia or @livy')], agents), null);
  assert.equal(routeMention([text('@liv.')], agents), 'liv');
});

test('only the addressed connection answers, once, as its own bot, with the comment kept out of argv', async () => {
  const f = fixture({comments: {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv summarize this secret plan')]}}});
  try {
    assert.deepEqual(f.deliver('c1'), [true, true]);
    assert.deepEqual(f.deliver('c1'), [false, false]); // webhook replay
    await f.run(); await f.run();
    assert.equal(f.admitted().length, 1);
    const {params} = f.admitted()[0];
    assert.equal(params.agentId, 'liv');
    assert.equal(params.sessionKey, 'agent:liv:notion:discussion:d1');
    assert.equal(params.sessionKey, sessionKeyFor('liv', 'D1'));
    assert.equal(params.deliver, false);
    assert.equal(params.idempotencyKey, 'notion-comment:c1:liv');
    assert.equal(JSON.stringify(f.calls).includes('secret plan'), false);
    const requestPath = /request record at (\S+)\./.exec(params.message)[1];
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    assert.equal(request.ownerAuthoredText, '@liv summarize this secret plan');
    assert.equal(request.context.pageTitle, 'Plan Q4');
    assert.equal(statSync(requestPath).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(requestPath)).mode & 0o777, 0o700);
    assert.deepEqual(f.replies, [{agent: 'liv', discussionId: 'D1', markdown: 'answer for run-liv-1'}]);
    assert.equal(f.store.get('c1', 'liv').state, 'replied');
    assert.equal(f.store.get('c1', 'liv').run_id, 'run-liv-1');
    assert.equal(f.store.get('c1', 'max').reason, 'other_agent');
  } finally { f.cleanup(); }
});

test('ignores agent-authored, non-owner, unmentioned, and unavailable comments without dispatch', async () => {
  const f = fixture({comments: {
    other: {discussion_id: 'D1', created_by: {id: OTHER}, rich_text: [text('@liv do it')]},
    livbot: {discussion_id: 'D1', created_by: {id: agents.liv.botUserId}, rich_text: [text('@max echo')]},
    maxbot: {discussion_id: 'D1', created_by: {id: agents.max.botUserId}, rich_text: [text('@liv echo')]},
    plain: {discussion_id: 'D2', created_by: {id: OWNER}, rich_text: [text('note to self')]},
  }});
  try {
    for (const id of ['other', 'livbot', 'maxbot', 'plain', 'gone']) f.deliver(id, ['liv']);
    await f.run();
    assert.equal(f.admitted().length, 0);
    assert.deepEqual(['other', 'livbot', 'maxbot', 'plain', 'gone'].map(id => f.store.get(id, 'liv').reason), ['not_owner', 'agent_author', 'agent_author', 'no_mention', 'fetch_404']);
  } finally { f.cleanup(); }
});

test('an unmentioned owner follow-up is answered only by the current lead; a new mention switches it', async () => {
  const f = fixture({comments: {
    a: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@max start')]},
    b: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('and then?')]},
    c: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [userMention(agents.liv.botUserId), text(' your view?')]},
    d: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('thanks, continue')]},
  }});
  try {
    for (const id of ['a', 'b', 'c', 'd']) { f.deliver(id, ['liv', 'max']); await f.run(); }
    assert.deepEqual(f.admitted().map(c => c.params.sessionKey), [sessionKeyFor('max', 'D1'), sessionKeyFor('max', 'D1'), sessionKeyFor('liv', 'D1'), sessionKeyFor('liv', 'D1')]);
    assert.equal(f.store.get('b', 'liv').reason, 'not_lead');
    assert.deepEqual(f.replies.map(r => r.agent), ['max', 'max', 'liv', 'liv']);
  } finally { f.cleanup(); }
});

test('a long run is waited on across many slices and then answered', async () => {
  let polls = 0;
  const f = fixture({comments: {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@max big job')]}},
    gateway: {wait: () => ++polls < 400 ? (polls % 2 ? {status: 'pending'} : {runId: 'x', status: 'timeout'}) : visible('done after hours')}});
  try {
    f.deliver('c1', ['max']);
    await f.run();
    assert.equal(polls, 400);
    assert.ok(f.clock.t > 15 * 60_000);
    assert.equal(f.store.get('c1', 'max').state, 'replied');
    assert.equal(f.replies[0].markdown, 'done after hours');
  } finally { f.cleanup(); }
});

test('after a restart a persisted run id resumes waiting without a second admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-restart-'));
  const comments = {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv long task')]}};
  const first = fixture({directory, comments, gateway: {wait: () => ({status: 'pending'}), sleep: async () => { throw new Error('process stopped'); }}});
  first.deliver('c1', ['liv']);
  await first.run();
  assert.equal(first.store.get('c1', 'liv').state, 'waiting');
  first.store.close();

  const store = new Store(join(directory, 'comments.sqlite3'));
  store.holdInterrupted();
  assert.equal(store.get('c1', 'liv').state, 'waiting');
  const second = fixture({directory, store, comments, gateway: {wait: ({runId}) => visible(`resumed ${runId}`)}});
  try {
    await second.run();
    assert.equal(second.admitted().length, 0);
    assert.deepEqual(second.calls.map(c => c.method), ['agent.wait']);
    assert.equal(second.replies[0].markdown, 'resumed run-liv-1');
    assert.equal(store.get('c1', 'liv').state, 'replied');
  } finally { second.cleanup(); }
});

test('a lost wait observation falls back to the run-stamped transcript reply', async () => {
  const history = {messages: [
    {role: 'assistant', content: [{type: 'text', text: 'older run'}], __openclaw: {runId: 'run-liv-0'}},
    {role: 'assistant', content: [{type: 'thinking', thinking: 'x'}, {type: 'text', text: 'from history'}], __openclaw: {runId: 'run-liv-1'}},
    {role: 'user', content: 'later', __openclaw: {runId: 'run-liv-2'}},
  ]};
  assert.equal(historyReply(history.messages, 'run-liv-1'), 'from history');
  assert.equal(historyReply(history.messages, 'run-liv-9'), null);
  const f = fixture({comments: {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv hi')]}},
    gateway: {wait: () => { throw new Error('gateway_call_failed'); }, history: () => history}});
  try {
    f.deliver('c1', ['liv']);
    await f.run();
    assert.equal(f.replies[0].markdown, 'from history');
  } finally { f.cleanup(); }
});

test('only genuinely ambiguous or failed outcomes are held', async () => {
  const comments = {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv hi')]}};
  for (const [gateway, reason] of [
    [{admit: () => { throw new Error('gateway_call_failed'); }}, 'admission_unconfirmed'],
    [{admit: () => ({status: 'accepted'})}, 'admission_unconfirmed'],
    [{wait: () => ({status: 'error', stopReason: 'superseded'})}, 'turn_error'],
    [{wait: () => ({status: 'timeout', endedAt: 5})}, 'turn_timeout'],
    [{wait: () => ({status: 'ok'})}, 'reply_text_unavailable'],
    [{wait: () => ({status: 'pending'})}, 'wait_ceiling'],
    [{replyError: Object.assign(new Error('x'), {status: 502})}, 'reply_502'],
  ]) {
    const f = fixture({comments, gateway});
    try {
      f.deliver('c1', ['liv']);
      await f.run(); await f.run();
      assert.equal(f.store.get('c1', 'liv').state, 'held', reason);
      assert.equal(f.store.get('c1', 'liv').reason, reason);
      assert.ok(f.admitted().length <= 1);
      assert.equal(f.replies.length, 0);
    } finally { f.cleanup(); }
  }
  const f = fixture({comments});
  try {
    f.deliver('c1', ['liv']);
    f.store.update('c1', 'liv', {state: 'dispatching'});
    f.store.holdInterrupted();
    assert.equal(f.store.get('c1', 'liv').reason, 'interrupted_dispatching');
    assert.equal(f.store.health().held, 1);
  } finally { f.cleanup(); }
});

test('silent turns post nothing; long replies are truncated', async () => {
  const comments = {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@max hi')]}};
  for (const wait of [() => ({status: 'ok', terminalReply: {disposition: 'silent'}}), () => visible('NO_REPLY')]) {
    const f = fixture({comments, gateway: {wait}});
    try {
      f.deliver('c1', ['max']);
      await f.run();
      assert.equal(f.store.get('c1', 'max').state, 'no_reply');
      assert.equal(f.replies.length, 0);
    } finally { f.cleanup(); }
  }
  const f = fixture({comments, gateway: {wait: () => visible('x'.repeat(9000))}});
  try {
    f.deliver('c1', ['max']);
    await f.run();
    assert.ok(f.replies[0].markdown.length <= config.maxReplyChars);
    assert.match(f.replies[0].markdown, /Reply truncated/);
  } finally { f.cleanup(); }
});

test('Notion client posts the documented reply shape and retries only rate limits', async () => {
  const requests = [];
  const responses = [new Response('{}', {status: 429, headers: {'retry-after': '1'}}), new Response(JSON.stringify({id: 'r1'}), {status: 200})];
  const client = new NotionClient({token: 'test-token', fetch: async (url, init) => { requests.push({url, init}); return responses.shift(); }, sleep: async () => {}});
  assert.deepEqual(await client.reply({discussionId: 'D1', markdown: 'hi'}), {id: 'r1'});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.notion.com/v1/comments');
  assert.equal(requests[0].init.headers['notion-version'], '2026-03-11');
  assert.deepEqual(JSON.parse(requests[0].init.body), {discussion_id: 'D1', markdown: 'hi'});
  const failing = new NotionClient({token: 't', fetch: async () => new Response('{}', {status: 502}), sleep: async () => {}});
  await assert.rejects(failing.reply({discussionId: 'D1', markdown: 'hi'}), error => error.status === 502);
});

test('gateway adapter calls the CLI with JSON params and maps failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-bin-'));
  const bin = join(directory, 'openclaw');
  writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({argv: process.argv.slice(2)}));\n`);
  chmodSync(bin, 0o700);
  const previous = process.env.OPENCLAW_BIN;
  process.env.OPENCLAW_BIN = bin;
  try {
    const {argv} = await gatewayCall('agent.wait', {runId: 'r1', timeoutMs: 1000}, 5000);
    assert.deepEqual(argv, ['gateway', 'call', 'agent.wait', '--params', '{"runId":"r1","timeoutMs":1000}', '--json', '--timeout', '5000']);
    process.env.OPENCLAW_BIN = join(directory, 'missing');
    await assert.rejects(gatewayCall('health', {}, 1000), /gateway_call_failed/);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_BIN; else process.env.OPENCLAW_BIN = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});
