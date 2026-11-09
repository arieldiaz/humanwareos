import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './store.mjs';
import {Outbound, cloudflareSender, parseThread} from './outbound.mjs';
import {normalizeMessage} from './framework.mjs';
import {run} from './send.mjs';

const config = JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url)));
const thread = 'CWORK:1700000000.000100';

function setup(t, outcome = () => ({outcome: 'sent', messageId: '<sent@cf.example>', delivered: ['friend@example.org'], queued: [], permanentBounces: [], suppressed: []})) {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-test-'));
  const store = new Store(join(dir, 'intake.db'));
  const posts = [], replies = [], sent = [];
  const call = async (method, token, args) => {
    if (method === 'chat.postMessage') { const ts = `1700000001.00000${posts.length}`; posts.push({token, args, ts}); return {ok: true, ts, channel: args.channel}; }
    if (method === 'conversations.replies') return {messages: replies.filter((m) => Number(m.ts) >= Number(args.oldest))};
    throw new Error(`unexpected ${method}`);
  };
  const outbound = new Outbound({store, config, tokens: {liv: 'xoxb-liv', max: 'xoxb-max'}, call, send: async (body) => { sent.push(body); return outcome(body); }});
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  return {dir, store, outbound, posts, replies, sent};
}

test('mail only to the owner is sent without a Slack approval and recorded', async (t) => {
  const {outbound, posts, sent, store} = setup(t);
  const draft = await outbound.draft({from: 'liv@bot.example.test', to: ['OWNER@example.test'], subject: 'Note', text: 'Hi'});
  assert.equal(draft.status, 'approved');
  assert.equal(posts.length, 0);
  const result = await outbound.send(draft.id);
  assert.equal(result.status, 'sent');
  assert.equal(result.result.messageId, '<sent@cf.example>');
  assert.deepEqual(sent[0], {from: {address: 'liv@bot.example.test', name: 'Liv'}, to: ['owner@example.test'], subject: 'Note', text: 'Hi'});
  assert.equal(store.outbound(draft.id).approval.method, 'owner_recipient');
});

test('third-party mail waits for the declared human to approve the exact previewed draft', async (t) => {
  const {outbound, posts, replies, sent, store} = setup(t);
  await assert.rejects(outbound.draft({from: 'max@bot.example.test', to: ['friend@example.org'], subject: 'Hello', text: 'Body'}), /approval_thread_required/);
  const draft = await outbound.draft({from: 'max@bot.example.test', to: ['friend@example.org'], cc: ['owner@example.test'], subject: 'Hello', text: 'Body', thread});
  assert.equal(draft.status, 'awaiting_approval');
  assert.match(draft.approvalPhrase, /^approve email [0-9a-f]{8}$/);
  assert.equal(posts[0].token, 'xoxb-max');
  assert.deepEqual([posts[0].args.channel, posts[0].args.thread_ts], ['CWORK', '1700000000.000100']);
  assert.match(posts[0].args.text, /To: friend@example\.org\nCc: owner@example\.test\nSubject: Hello\n\nBody\n/);
  assert.ok(posts[0].args.text.includes(draft.approvalPhrase));

  assert.equal((await outbound.send(draft.id)).status, 'awaiting_approval');
  // Not the approver, a bot, the wrong code, or a message from before the preview.
  replies.push({user: 'USOMEONE', ts: '1700000002.0', text: draft.approvalPhrase},
    {user: 'UOWNER', bot_id: 'B1', ts: '1700000002.1', text: draft.approvalPhrase},
    {user: 'UOWNER', ts: '1700000002.2', text: 'approve email 00000000'},
    {user: 'UOWNER', ts: '1700000000.5', text: draft.approvalPhrase});
  assert.equal((await outbound.send(draft.id)).status, 'awaiting_approval');
  assert.equal(sent.length, 0);

  replies.push({user: 'UOWNER', ts: '1700000003.0', text: `  ${draft.approvalPhrase.toUpperCase()} `});
  const result = await outbound.send(draft.id);
  assert.equal(result.status, 'sent');
  assert.equal(store.outbound(draft.id).approval.approvalTs, '1700000003.0');
  assert.equal((await outbound.send(draft.id)).status, 'sent');
  assert.equal(sent.length, 1, 'a sent record is never resent');
});

test('replies thread to the latest intake message and default to its mailbox and subject', async (t) => {
  const {outbound, store, sent, replies} = setup(t);
  const repository = store.repository;
  const message = (id, refs, at) => normalizeMessage({source: 'test', deliveryId: id, recipient: 'liv@bot.example.test', sender: 'friend@example.org',
    messageId: `${id}@example.org`, references: refs, subject: 'Dinner', receivedAt: at, sizeBytes: 10, evidenceRef: `ref:${id}`});
  repository.atomic('seed', 'seed', () => {
    repository.save({intakeId: 'intake-1', revision: 1, recipient: 'liv@bot.example.test', sender: 'friend@example.org', subjectKey: 'dinner',
      lastReceivedAt: '2026-11-09T12:00:00.000Z', intakeThread: {channelId: 'CINBOX', threadTs: '1700000000.000200'}}, 0);
    repository.addMessage(message('m1', [], '2026-11-09T10:00:00Z'), 'intake-1');
    repository.addMessage(message('m2', ['m1@example.org'], '2026-11-09T12:00:00Z'), 'intake-1');
    return {};
  });
  await assert.rejects(outbound.draft({to: ['friend@example.org'], text: 'Yes', thread, reply: true}), /unknown_intake_thread/);
  const draft = await outbound.draft({to: ['friend@example.org'], text: 'Yes', thread: 'CINBOX:1700000000.000200', reply: true});
  assert.equal(draft.from, 'liv@bot.example.test');
  assert.equal(draft.subject, 'Re: Dinner');
  replies.push({user: 'UOWNER', ts: '1700000009.0', text: draft.approvalPhrase});
  await outbound.send(draft.id);
  assert.deepEqual(sent[0].headers, {'In-Reply-To': '<m2@example.org>', References: '<m1@example.org> <m2@example.org>'});
  assert.equal(store.outbound(draft.id).draft.intakeId, 'intake-1');
});

test('only declared senders, bounded recipients, and no self-addressed loops', async (t) => {
  const {outbound} = setup(t);
  const ok = {from: 'liv@bot.example.test', to: ['owner@example.test'], subject: 'S', text: 'T'};
  await assert.rejects(outbound.draft({...ok, from: 'kids@bot.example.test'}), /undeclared_sender/);
  await assert.rejects(outbound.draft({...ok, from: 'ariel@example.test'}), /undeclared_sender/);
  await assert.rejects(outbound.draft({...ok, to: ['max@bot.example.test']}), /own_domain_recipient/);
  await assert.rejects(outbound.draft({...ok, to: Array.from({length: 11}, (_, i) => `p${i}@example.org`), thread}), /invalid_recipients/);
  await assert.rejects(outbound.draft({...ok, subject: 'a\r\nBcc: x@example.org'}), /invalid_subject/);
  await assert.rejects(outbound.draft({...ok, text: ' '}), /invalid_text/);
  assert.throws(() => parseThread('nope'), /invalid_thread/);
});

test('an unknown provider outcome is held as a fault and never retried; refusals are final', async (t) => {
  let outcome = {outcome: 'unknown'};
  const {outbound, store, sent} = setup(t, () => outcome);
  const first = await outbound.draft({from: 'liv@bot.example.test', to: ['owner@example.test'], subject: 'S', text: 'T'});
  await assert.rejects(outbound.send(first.id), /ambiguous_outbound_send/);
  await assert.rejects(outbound.send(first.id), /ambiguous_outbound_send/);
  assert.equal(sent.length, 1);
  assert.equal(store.health().faults, 1);
  outcome = {outcome: 'rejected', status: 403, errors: [{code: 10102, message: 'email.sending.error.authentication.forbidden'}]};
  const second = await outbound.draft({from: 'liv@bot.example.test', to: ['owner@example.test'], subject: 'S', text: 'T'});
  assert.equal((await outbound.send(second.id)).status, 'rejected');
});

test('Cloudflare REST outcomes map to sent, rejected, or unknown', async () => {
  const fetcher = (status, body) => async (url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/email/sending/send');
    assert.equal(init.headers.authorization, 'Bearer token');
    if (status === 0) throw new Error('offline');
    return new Response(JSON.stringify(body), {status});
  };
  const send = (status, body) => cloudflareSender({accountId: '0'.repeat(32), token: 'token', fetcher: fetcher(status, body)})({});
  assert.deepEqual(await send(200, {success: true, result: {message_id: '<x@y>', delivered: ['a@b'], queued: [], permanent_bounces: []}}),
    {outcome: 'sent', messageId: '<x@y>', delivered: ['a@b'], queued: [], permanentBounces: [], suppressed: []});
  assert.equal((await send(403, {success: false, errors: [{code: 10102, message: 'forbidden'}]})).outcome, 'rejected');
  assert.equal((await send(500, {success: false})).outcome, 'unknown');
  assert.equal((await send(0)).outcome, 'unknown');
  assert.throws(() => cloudflareSender({accountId: '0'.repeat(32), token: ''}), /sending_credentials_missing/);
});

test('CLI drafts and sends with environment credentials only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-cli-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'body.txt'), 'From the CLI');
  const env = {HUMANWARE_DATA_ROOT: dir, EMAIL_INTAKE_CONFIG: join(dir, 'config.json'), EMAIL_INTAKE_DATA_DIR: join(dir, 'state'), EMAIL_SENDING_TOKEN: 'token'};
  const bodies = [];
  const makeSender = ({accountId, token}) => async (body) => { bodies.push({accountId, token, body}); return {outcome: 'sent', messageId: '<m@cf>'}; };
  const draft = await run(['draft', '--from', 'max@bot.example.test', '--to', 'owner@example.test', '--subject', 'CLI', '--text-file', join(dir, 'body.txt')], {env, makeSender});
  const sent = await run(['send', '--id', draft.id], {env, makeSender});
  assert.equal(sent.status, 'sent');
  assert.deepEqual(bodies[0], {accountId: config.queue.accountId, token: 'token', body: {from: {address: 'max@bot.example.test', name: 'Max'}, to: ['owner@example.test'], subject: 'CLI', text: 'From the CLI'}});
  await assert.rejects(run(['bogus'], {env, makeSender}), /usage/);
});
