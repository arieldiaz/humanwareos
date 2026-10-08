import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QueueConsumer, decodeMessage} from './queue.mjs';
import {handler} from './server.mjs';
const config = {accountId: 'a'.repeat(32), ingressId: 'b'.repeat(32), deadLetterId: 'c'.repeat(32)};
const event = {eventId: 'one', recipient: 'max@bot.example.test', rawBase64: 'bWFpbA=='};
function message(value = event) { return {id: 'one', lease_id: 'private-lease', metadata: {'CF-Content-Type': 'json'}, body: Buffer.from(JSON.stringify(value)).toString('base64')}; }
function fixture(t, receive = async () => ({ok: true}), messages = [message()]) {
  const directory = mkdtempSync(join(tmpdir(), 'email-pull-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const requests = [], faults = [];
  const intake = {receive, store: {fault: (...args) => faults.push(args)}};
  const consumer = new QueueConsumer({config, token: 'fixture-not-a-secret', intake, directory, fetcher: async (url, options) => {
    requests.push({url, options, body: JSON.parse(options.body)});
    assert.equal(new URL(url).hostname, 'api.cloudflare.com');
    assert.equal(options.redirect, 'error');
    return Response.json({success: true, result: url.endsWith('/pull') ? {messages: url.includes(config.deadLetterId) ? [] : messages} : {}});
  }});
  return {consumer, requests, faults, directory};
}
test('decodes Cloudflare JSON base64, rejects V8/malformed/oversized bodies', () => {
  assert.deepEqual(decodeMessage(message()), event);
  assert.deepEqual(decodeMessage({...message(), body: JSON.stringify(event)}), event);
  for (const invalid of [{...message(), metadata: {'CF-Content-Type': 'v8'}}, {...message(), body: '!'}, {...message(), body: 'a'.repeat(180001)}, message(null)]) assert.throws(() => decodeMessage(invalid));
});
test('outbound pull acknowledges only confirmed local processing', async t => {
  let received;
  const f = fixture(t, async e => {received = e; return {ok: true};});
  assert.equal(f.consumer.healthy(), false);
  await f.consumer.tick();
  assert.deepEqual(received, event);
  assert.equal(f.consumer.healthy(), true);
  const ack = f.requests.find(r => r.url.endsWith('/ack'));
  assert.deepEqual(ack.body, {acks: [{lease_id: 'private-lease'}], retries: []});
  assert.deepEqual(f.requests[0].body, {batch_size: 1, visibility_timeout_ms: 300000});
});
test('failure, malformed MIME envelope, and unconfirmed result retry rather than ACK', async t => {
  for (const receive of [async () => {throw Error('private data');}, async () => ({ok: false})]) {
    const f = fixture(t, receive);
    await f.consumer.tick();
    assert.deepEqual(f.requests.find(r => r.url.endsWith('/ack')).body, {acks: [], retries: [{lease_id: 'private-lease', delay_seconds: 60}]});
  }
  const f = fixture(t, () => assert.fail('malformed body cannot dispatch'), [{...message(), body: '!'}]);
  await f.consumer.tick();
  assert.equal(f.requests.find(r => r.url.endsWith('/ack')).body.acks.length, 0);
});
test('lost acknowledgement is replayed through intake with the identical durable identity', async t => {
  const identities = new Set(); let effects = 0, ackCalls = 0;
  const f = fixture(t, async e => {if (!identities.has(e.eventId)) {identities.add(e.eventId); effects++;} return {ok: true};});
  const fetcher = f.consumer.fetcher;
  f.consumer.fetcher = async (url, options) => {
    if (url.endsWith('/ack') && ackCalls++ === 0) throw Error('lost response');
    return fetcher(url, options);
  };
  await assert.rejects(f.consumer.tick(), /queue_transport_unavailable/);
  assert.equal(f.consumer.healthy(), false);
  await f.consumer.tick();
  assert.equal(effects, 1); assert.equal(f.consumer.healthy(), true);
});
test('DLQ saves original even malformed body, excludes lease, retains durable fault before ACK', async t => {
  const f = fixture(t);
  const malformed = {...message(), body: '!not-json!'};
  f.consumer.fetcher = async (url, options) => {
    if (url.endsWith('/pull')) return Response.json({success: true, result: {messages: [malformed]}});
    const files = readdirSync(f.directory);
    assert.equal(files.length, 1); assert.equal(f.faults[0][1], 'queue_exhausted');
    const saved = readFileSync(join(f.directory, files[0]), 'utf8');
    assert.equal(saved.includes('private-lease'), false);
    assert.equal(JSON.parse(saved).body, malformed.body);
    assert.equal(JSON.parse(options.body).acks.length, 1);
    return Response.json({success: true, result: {}});
  };
  await f.consumer.poll(config.deadLetterId, true);
  await f.consumer.poll(config.deadLetterId, true);
  assert.equal(readdirSync(f.directory).length, 1);
});
test('DLQ disk failure cannot acknowledge and ingress outage does not skip DLQ', async t => {
  const f = fixture(t); let dlqCalls = 0, ack;
  f.consumer.directory = '/dev/null/impossible';
  f.consumer.fetcher = async (url, options) => {
    if (url.includes(config.ingressId)) throw Error('outage');
    if (url.endsWith('/pull')) {dlqCalls++; return Response.json({success: true, result: {messages: [message()]}});}
    ack = JSON.parse(options.body);
    return Response.json({success: true, result: {}});
  };
  await assert.rejects(f.consumer.tick());
  assert.equal(dlqCalls, 1); assert.deepEqual(ack.acks, []);
});
test('health fails until queue ready and when last queue success is stale', async t => {
  const f = fixture(t, undefined, []); let now = 1000;
  f.consumer.now = () => now;
  const check = async () => {
    let status, body;
    await handler({health: () => ({ok: true})}, 'fixture', f.consumer)({method: 'GET', url: '/health'}, {writeHead: s => {status = s;}, end: v => {body = JSON.parse(v);}});
    return {status, body};
  };
  assert.equal((await check()).status, 503);
  await f.consumer.tick();
  assert.equal((await check()).status, 200);
  now += 120001;
  assert.equal((await check()).status, 503);
});
test('API failure does not leak upstream response details', async t => {
  const f = fixture(t);
  f.consumer.fetcher = async () => Response.json({success: false, errors: [{message: 'sensitive upstream'}]});
  await assert.rejects(f.consumer.poll(config.ingressId), {message: 'queue_api_unavailable'});
});

test('an interrupted temporary DLQ write cannot masquerade as a retained record', async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'interrupted.tmp'), '{');
  f.consumer.fetcher = async (url, options) => {
    if (url.endsWith('/pull')) return Response.json({success: true, result: {messages: [message()]}});
    const files = readdirSync(f.directory).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.directory, files[0]))).body, message().body);
    assert.equal(JSON.parse(options.body).acks.length, 1);
    return Response.json({success: true, result: {}});
  };
  await f.consumer.poll(config.deadLetterId, true);
});
