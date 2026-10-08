import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import http from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import worker from '../agent-email/src/index.js';
import {Store} from './store.mjs';
import {Intake, calendarClient} from './intake.mjs';
import {deliverQueued} from './pull-fixture.mjs';

const dir = mkdtempSync(join(tmpdir(), 'intake-e2e-'));
process.env.CALENDAR_DATABASE = join(dir, 'calendar.sqlite3');
process.env.CALENDAR_SERVICE_ROOT = join(import.meta.dirname, '../calendar');
process.env.CALENDAR_INGEST_SECRET = 'calendar-fixture';
process.env.CALENDAR_PUBLIC_FEED_BASE ??= 'https://cal.example.test/feed';
process.env.CALENDAR_BOT_DOMAIN ??= 'bot.example.test';
process.env.CALENDAR_AGENT_ALLOWLIST ??= 'agent:liv';
const {handler: calendarHandler} = await import('../calendar/server.mjs');
const calendarServer = http.createServer(calendarHandler);
await new Promise(resolve => calendarServer.listen(0, '127.0.0.1', resolve));
const calendarOrigin = `http://127.0.0.1:${calendarServer.address().port}`;
const calendarCall = async (path, body, headers = {}) => {
  const response = await fetch(calendarOrigin+path, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  assert.equal(response.status, 200); return response.json();
};
const tool = (name, args) => calendarCall('/api/tools/'+name, {operationId: crypto.randomUUID(), args}, {'x-calendar-agent': 'agent:liv'});
const calendar = await tool('calendar_create_calendar', {name: 'Fixture calendar', ownerAddress: 'kids@bot.example.test', defaultForInbound: true, timeZone: 'America/New_York', reason: 'Test'});
const store = new Store(join(dir, 'intake.sqlite3')), sent = [], statuses = [];
const intake = new Intake({store, config: JSON.parse(readFileSync(new URL('./config.example.json', import.meta.url))), channel: {channelId: 'CINBOX'},
  calendar: calendarClient({url: calendarOrigin+'/inbound/email', secret: 'calendar-fixture'}),
  slack: {verify: async () => {}, send: async (effect, conversation, text) => { sent.push({effect, conversation, text}); return {channelId: 'CINBOX', threadTs: String(sent.length)}; }, status: async c => statuses.push(c.lifecycle)}});
test.after(() => {calendarServer.close(); store.close(); rmSync(dir, {recursive: true, force: true});});
let sequence = 0;
async function deliver({recipient = 'max@bot.example.test', subject = 'Hello', text = 'Please start coding in #project', calendarPayload, references} = {}) {
  const id = `<fixture-${++sequence}@example.test>`;
  const headers = new Headers({from: 'Sender <sender@example.test>', subject, 'message-id': id, ...(references ? {references} : {})});
  const raw = `From: Sender <sender@example.test>\r\nTo: ${recipient}\r\nMessage-ID: ${id}\r\nSubject: ${subject}\r\n${references ? `References: ${references}\r\n` : ''}Content-Type: ${calendarPayload ? 'text/calendar' : 'text/plain'}\r\n\r\n${calendarPayload ?? text}`;
  let queued;
  await worker.email({from: 'sender@example.test', to: recipient, headers, rawSize: Buffer.byteLength(raw), raw: new Response(raw).body, setReject: () => assert.fail('unexpected ingress rejection')}, {ALLOWED_RECIPIENTS: 'max@bot.example.test,kids@bot.example.test', EMAIL_EVENTS: {send: async event => {queued = event;}}});
  assert.deepEqual(await deliverQueued(intake, dir, queued), {ack: 1, retry: 0});
  assert.deepEqual(await deliverQueued(intake, dir, queued), {ack: 1, retry: 0});
  return id;
}
const ics = (method = 'REQUEST', seq = 0) => ['BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:fixture@example.test', `SEQUENCE:${seq}`, 'ORGANIZER:mailto:sender@example.test', 'DTSTART:20261014T220000Z', 'DTEND:20261014T230000Z', 'SUMMARY:Recital', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
test('Worker → outbound pull → SQLite → ordinary root and correlated reply', async () => {
  const id = await deliver(); assert.equal(sent.length, 1);
  assert.equal(sent[0].conversation.owner, 'max'); assert.equal(sent[0].conversation.promotion, null);
  await deliver({references: id, subject: 'Re: Hello'});
  assert.equal(sent.length, 2); assert.equal(sent[1].effect.kind, 'intake_append');
  assert.equal(sent[1].conversation.intakeThread.threadTs, '1');
});
test('Worker calendar REQUEST, new Message-ID duplicate, CANCEL, and invalid invitation', async () => {
  const before = sent.length;
  await deliver({recipient: 'kids@bot.example.test', calendarPayload: ics(), subject: 'Recital'});
  assert.equal(sent.length, before+1); assert.equal(statuses.length, 0);
  await deliver({recipient: 'kids@bot.example.test', calendarPayload: ics(), subject: 'Forwarded Recital'});
  assert.equal(sent.length, before+1);
  let events = await tool('calendar_list_events', {calendarId: calendar.id, from: '2026-01-01', to: '2027-01-01', includeCancelled: true});
  assert.equal(events.length, 1); assert.equal(events[0].revision, 1);
  await deliver({recipient: 'kids@bot.example.test', calendarPayload: ics('CANCEL', 1), subject: 'Cancelled recital'});
  assert.equal(statuses.length, 0);
  events = await tool('calendar_list_events', {calendarId: calendar.id, from: '2026-01-01', to: '2027-01-01', includeCancelled: true});
  assert.equal(events.length, 1); assert.equal(events[0].status, 'cancelled'); assert.equal(events[0].revision, 2);
  await deliver({recipient: 'kids@bot.example.test', calendarPayload: 'BEGIN:VCALENDAR\r\ninvalid', subject: 'Bad invitation'});
  assert.match(sent.at(-1).text, /could not be recorded/); assert.equal(statuses.length, 0);
});
test('ordinary calendar request is retained for review without creating an event', async () => {
  await deliver({recipient: 'kids@bot.example.test', subject: 'Please add soccer', text: 'Create soccer tomorrow at 4pm'});
  const events = await tool('calendar_list_events', {calendarId: calendar.id, from: '2026-01-01', to: '2027-01-01', includeCancelled: true});
  assert.equal(events.length, 1);
  const inbox = await tool('calendar_list_inbox', {recipient: 'kids@bot.example.test', status: 'pending'});
  assert.equal(inbox[0].textBody.trim(), 'Create soccer tomorrow at 4pm');
});
