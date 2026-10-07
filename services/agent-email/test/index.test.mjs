import assert from 'node:assert/strict';
import test from 'node:test';
import handler, {buildEvent, buildQueuedEvent, parseMessageIds, parseAddressHeader} from '../src/index.js';
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
test('MIME remains intact for trusted local verification and attachment parsing', async () => {
  const event = await buildQueuedEvent(message({raw: new Response('Content-Type: text/calendar\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR').body}));
  assert.match(Buffer.from(event.rawBase64, "base64").toString(), /BEGIN:VCALENDAR/);
  assert.equal(event.calendarPayload, undefined);
});
test('ingress rejects undeclared recipients and oversize; queue is mandatory', async () => {
  for (const input of [message({to: 'other@example.test'}), message({rawSize: 524289})]) {
    await handler.email(input, {ALLOWED_RECIPIENTS: 'max@bot.example.test'});
    assert.match(input.rejected, /^55/);
  }
  await assert.rejects(handler.email(message(), {ALLOWED_RECIPIENTS: 'max@bot.example.test'}), /queue unavailable/);
});
test('ingress is producer-only; JSON payload and durable send are required', async () => {
  const events = [];
  await handler.email(message(), {ALLOWED_RECIPIENTS: 'max@bot.example.test', EMAIL_EVENTS: {send: async (event, options) => events.push({event, options})}});
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].options, {contentType: 'json'});
  assert.equal(handler.queue, undefined);
  await assert.rejects(handler.email(message(), {ALLOWED_RECIPIENTS: 'max@bot.example.test', EMAIL_EVENTS: {send: async () => {throw Error('unavailable');}}}), /unavailable/);
});
