import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import handler, {buildEvent, parseMessageIds, parseAddressHeader} from '../src/index.js';
function message(overrides = {}) {
  return {from: 'sender@example.test', to: 'max@bot.example.test', rawSize: 100,
    headers: new Headers({'from': 'Sender <sender@example.test>', 'subject': 'Hello', 'message-id': '<one@example.test>', 'references': '<ancestor@example.test> <parent@example.test>', 'in-reply-to': '<parent@example.test>'}),
    setReject(value) {this.rejected = value;}, ...overrides};
}
test('provider normalization retains ancestry without MIME', () => {
  const event = buildEvent(message());
  assert.equal(event.inReplyTo, '<parent@example.test>');
  assert.deepEqual(event.references, ['<ancestor@example.test>', '<parent@example.test>']);
  assert.equal(event.raw, undefined);
  assert.equal(parseAddressHeader('Person <PERSON@example.test>'), 'person@example.test');
  assert.deepEqual(parseMessageIds('malformed'), []);
});
const env = (objects = new Map(), events = []) => ({ALLOWED_RECIPIENTS: 'max@bot.example.test', MAX_RAW_BYTES: '1048576',
  EMAIL_RAW: {put: async (key, value) => {objects.set(key, Buffer.from(value));}}, EMAIL_EVENTS: {send: async (event, options) => events.push({event, options})}});
test('MIME is stored intact in R2 before a content-addressed pointer is queued', async () => {
  const raw = 'Content-Type: text/calendar\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR', objects = new Map(), events = [];
  await handler.email(message({raw: new Response(raw).body}), env(objects, events));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  assert.equal(objects.get(sha256).toString(), raw);
  assert.deepEqual(events[0].options, {contentType: 'json'});
  const {event} = events[0];
  assert.deepEqual([event.deliveryId, event.rawSha256, event.rawSize], [sha256, sha256, raw.length]);
  assert.equal(event.rawBase64, undefined); assert.equal(event.calendarPayload, undefined);
  assert.equal(handler.queue, undefined);
});
test('ingress rejects undeclared recipients and MAX_RAW_BYTES oversize without storing', async () => {
  const objects = new Map(), big = 'x'.repeat(1048577);
  for (const input of [message({to: 'other@example.test'}), message({rawSize: 1048577}), message({rawSize: 10, raw: new Response(big).body})]) {
    await handler.email(input, env(objects));
    assert.match(input.rejected, /^55/);
  }
  assert.equal(objects.size, 0);
});
test('cap, bucket and queue are mandatory; a failed store or send is not accepted', async () => {
  for (const patch of [{MAX_RAW_BYTES: undefined}, {EMAIL_RAW: undefined}, {EMAIL_EVENTS: undefined}]) await assert.rejects(handler.email(message(), {...env(), ...patch}), /unconfigured|unavailable/);
  const events = [];
  await assert.rejects(handler.email(message(), {...env(new Map(), events), EMAIL_RAW: {put: async () => {throw Error('unavailable');}}}), /unavailable/);
  assert.equal(events.length, 0);
  await assert.rejects(handler.email(message(), {...env(), EMAIL_EVENTS: {send: async () => {throw Error('unavailable');}}}), /unavailable/);
});
