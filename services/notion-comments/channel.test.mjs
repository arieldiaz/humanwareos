import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Channel, finalText, gatewayAgent, routeMention, sessionKeyFor} from './channel.mjs';
import {NotionClient} from './notion.mjs';
import {Store} from './store.mjs';

const config = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url)));
const OWNER = config.ownerUserId;
const BOT = '00000000-0000-4000-8000-0000000000ff';
const OTHER = '00000000-0000-4000-8000-000000000002';
const text = content => ({type: 'text', text: {content}, plain_text: content});
const userMention = id => ({type: 'mention', mention: {type: 'user', user: {object: 'user', id}}, plain_text: '@Anonymous'});

function fixture({comments, call, replyError} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-'));
  const store = new Store(join(directory, 'comments.sqlite3'));
  const calls = [], replies = [];
  const notion = {
    comment: async id => { const c = comments[id]; if (!c) throw Object.assign(new Error('missing'), {status: 404}); return {id, parent: {type: 'page_id', page_id: 'page-1'}, ...c}; },
    page: async () => ({url: 'https://www.notion.so/page-1', properties: {Name: {type: 'title', title: [text('Plan\nQ4')]}}}),
    reply: async value => { if (replyError) throw replyError; replies.push(value); return {id: `reply-${replies.length}`}; },
  };
  const channel = new Channel({store, notion, config, botUserId: BOT, call: call ?? (async params => { calls.push(params); return {runId: params.idempotencyKey, status: 'ok', result: {payloads: [{text: `answer ${calls.length}`}]}}; })});
  const event = id => ({id: `event-${id}`, type: 'comment.created', entity: {id, type: 'comment'}, data: {page_id: 'page-1'}});
  return {store, channel, calls, replies, event, cleanup: () => { store.close(); rmSync(directory, {recursive: true, force: true}); }};
}

test('routes the first mention by configured user or start-of-word plain text', () => {
  assert.equal(routeMention([text('hey @LIV, look')], config), 'liv');
  assert.equal(routeMention([text('(@max) and @liv')], config), 'max');
  assert.equal(routeMention([userMention(Object.keys(config.mentionUsers)[0]), text(' @max')], config), 'liv');
  assert.equal(routeMention([userMention(OTHER), text('mail me@liv.example or @olivia or @livy')], config), null);
  assert.equal(routeMention([text('@liv.')], config), 'liv');
});

test('owner mention dispatches one turn per discussion session and replies in the discussion', async () => {
  const f = fixture({comments: {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv summarize this')]}}});
  try {
    assert.equal(f.channel.receive(f.event('c1')), true);
    assert.equal(f.channel.receive(f.event('c1')), false); // webhook replay
    await f.channel.drain(); await f.channel.drain();
    assert.equal(f.calls.length, 1);
    const [params] = f.calls;
    assert.equal(params.agentId, 'liv');
    assert.equal(params.sessionKey, sessionKeyFor('liv', 'D1'));
    assert.equal(params.sessionKey, 'agent:liv:notion:discussion:d1');
    assert.equal(params.deliver, false);
    assert.equal(params.idempotencyKey, 'notion-comment:c1');
    assert.match(params.message, /<<<\n@liv summarize this\n>>>/);
    assert.match(params.message, /page "Plan Q4" https:\/\/www\.notion\.so\/page-1/);
    assert.deepEqual(f.replies, [{discussionId: 'D1', markdown: 'answer 1', displayName: 'Liv'}]);
    assert.equal(f.store.get('c1').state, 'replied');
    assert.equal(f.store.get('c1').reply_comment_id, 'reply-1');
  } finally { f.cleanup(); }
});

test('ignores non-owner, self-authored, unmentioned, and unavailable comments without dispatch', async () => {
  const f = fixture({comments: {
    other: {discussion_id: 'D1', created_by: {id: OTHER}, rich_text: [text('@liv do it')]},
    self: {discussion_id: 'D1', created_by: {id: BOT}, rich_text: [text('@liv echo')]},
    plain: {discussion_id: 'D2', created_by: {id: OWNER}, rich_text: [text('note to self')]},
  }});
  try {
    for (const id of ['other', 'self', 'plain', 'gone']) f.channel.receive(f.event(id));
    await f.channel.drain();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(['other', 'self', 'plain', 'gone'].map(id => f.store.get(id).reason), ['not_owner', 'self', 'no_mention', 'fetch_404']);
  } finally { f.cleanup(); }
});

test('an owner follow-up in the same discussion continues the current lead; a new mention switches it', async () => {
  const f = fixture({comments: {
    a: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@max start')]},
    b: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('and then?')]},
    c: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv your view?')]},
  }});
  try {
    for (const id of ['a', 'b', 'c']) f.channel.receive(f.event(id));
    await f.channel.drain();
    assert.deepEqual(f.calls.map(c => c.sessionKey), [sessionKeyFor('max', 'D1'), sessionKeyFor('max', 'D1'), sessionKeyFor('liv', 'D1')]);
  } finally { f.cleanup(); }
});

test('unknown turn or reply outcomes are held and never retried', async () => {
  const comments = {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv hi')]}};
  let f = fixture({comments, call: async () => { throw new Error('gateway_turn_unconfirmed'); }});
  try {
    f.channel.receive(f.event('c1'));
    await f.channel.drain(); await f.channel.drain();
    assert.equal(f.store.get('c1').state, 'held');
    assert.equal(f.store.get('c1').reason, 'gateway_turn_unconfirmed');
    assert.equal(f.store.health().held, 1);
  } finally { f.cleanup(); }

  f = fixture({comments, replyError: Object.assign(new Error('x'), {status: 502})});
  try {
    f.channel.receive(f.event('c1'));
    await f.channel.drain(); await f.channel.drain();
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.get('c1').state, 'held');
    assert.equal(f.store.get('c1').reason, 'reply_502');
    assert.equal(f.store.get('c1').reply_text, 'answer 1');
  } finally { f.cleanup(); }
});

test('interrupted dispatch is held on restart; silent and failed turns post nothing', async () => {
  const comments = {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@liv hi')]}};
  let f = fixture({comments});
  try {
    f.channel.receive(f.event('c1'));
    f.store.update('c1', {state: 'dispatching'});
    f.store.holdInterrupted();
    assert.equal(f.store.get('c1').reason, 'interrupted_dispatching');
  } finally { f.cleanup(); }

  for (const [response, state, reason] of [
    [{status: 'ok', result: {payloads: [{text: 'NO_REPLY'}]}}, 'no_reply', null],
    [{status: 'error', result: {payloads: [{text: 'boom', isError: true}]}}, 'held', 'turn_error'],
  ]) {
    f = fixture({comments, call: async () => response});
    try {
      f.channel.receive(f.event('c1'));
      await f.channel.drain();
      assert.equal(f.store.get('c1').state, state);
      assert.equal(f.store.get('c1').reason, reason);
      assert.equal(f.replies.length, 0);
    } finally { f.cleanup(); }
  }
});

test('final text excludes reasoning, errors, and status notices; long replies are truncated', async () => {
  assert.equal(finalText({result: {payloads: [{text: 'think', isReasoning: true}, {text: ' one '}, {text: 'two'}, {text: 'reset', isStatusNotice: true}]}}), 'one\n\ntwo');
  const f = fixture({comments: {c1: {discussion_id: 'D1', created_by: {id: OWNER}, rich_text: [text('@max hi')]}},
    call: async () => ({status: 'ok', result: {payloads: [{text: 'x'.repeat(9000)}]}})});
  try {
    f.channel.receive(f.event('c1'));
    await f.channel.drain();
    assert.equal(f.replies[0].markdown.length <= config.maxReplyChars, true);
    assert.match(f.replies[0].markdown, /Reply truncated/);
  } finally { f.cleanup(); }
});

test('Notion client sends the documented reply shape and retries only rate limits', async () => {
  const requests = [];
  const responses = [new Response('{}', {status: 429, headers: {'retry-after': '1'}}), new Response(JSON.stringify({id: 'r1'}), {status: 200})];
  const client = new NotionClient({token: 'test-token', fetch: async (url, init) => { requests.push({url, init}); return responses.shift(); }, sleep: async () => {}});
  assert.deepEqual(await client.reply({discussionId: 'D1', markdown: 'hi', displayName: 'Liv'}), {id: 'r1'});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.notion.com/v1/comments');
  assert.equal(requests[0].init.headers['notion-version'], '2026-03-11');
  assert.deepEqual(JSON.parse(requests[0].init.body), {discussion_id: 'D1', markdown: 'hi', display_name: {type: 'custom', custom: {name: 'Liv'}}});
  const failing = new NotionClient({token: 't', fetch: async () => new Response('{}', {status: 502}), sleep: async () => {}});
  await assert.rejects(failing.reply({discussionId: 'D1', markdown: 'hi'}), error => error.status === 502);
});

test('gateway adapter waits for the final agent response without Slack delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-bin-'));
  const bin = join(directory, 'openclaw');
  writeFileSync(bin, `#!${process.execPath}\nconst a = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({status: 'ok', runId: JSON.parse(a[a.indexOf('--params') + 1]).idempotencyKey, argv: a}));\n`);
  chmodSync(bin, 0o700);
  const previous = process.env.OPENCLAW_BIN;
  process.env.OPENCLAW_BIN = bin;
  try {
    const response = await gatewayAgent({agentId: 'liv', sessionKey: 'agent:liv:notion:discussion:d1', deliver: false, idempotencyKey: 'notion-comment:c1', message: 'hi'}, {timeoutMs: 5000});
    assert.equal(response.runId, 'notion-comment:c1');
    assert.deepEqual(response.argv.filter(a => a.startsWith('--')), ['--params', '--expect-final', '--json', '--timeout']);
    assert.deepEqual(response.argv.slice(0, 3), ['gateway', 'call', 'agent']);
    process.env.OPENCLAW_BIN = join(directory, 'missing');
    await assert.rejects(gatewayAgent({}, {timeoutMs: 1000}), /gateway_turn_unconfirmed/);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_BIN; else process.env.OPENCLAW_BIN = previous;
    rmSync(directory, {recursive: true, force: true});
  }
});
