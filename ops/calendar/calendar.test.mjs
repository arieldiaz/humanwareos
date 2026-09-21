import assert from "node:assert/strict";
import test from "node:test";
import {normalizeCalendar, reviseCalendar} from "./calendar-model.js";
import {normalizeInvitation} from "./invitation.js";
import {feedRevision, renderICalendar} from "./ical.js";
import {normalizeEvent, reviseEvent} from "./model.js";
import {authorizeMutation} from "./policy.js";
import {CalendarService} from "./service.js";
import {calendarToolContract} from "./tool-contract.js";

const agentPolicy = {origin: "agent", actor: "agent:max", approved: true, operationId: "op-1", reason: "Requested calendar change"};

class TestStore {
  constructor() { this.events = new Map(); this.operations = new Map(); this.deleted = new Map(); }
  async list() { return [...this.events.values()]; }
  async read(id, options = {}) { return this.events.get(id) ?? (options.includeDeleted ? this.deleted.get(id) : null); }
  async readByUid(calendarId, uid) { return [...this.events.values()].find((event) => event.calendarId === calendarId && event.uid === uid) ?? null; }
  async claimOperation(operationId) { return this.operations.get(operationId) ?? null; }
  async commit(event, context) { const result = {...event, audit: {operationId: context.policy.operationId, actor: context.policy.actor, reason: context.policy.reason, action: context.action}}; this.events.set(event.id, result); this.operations.set(context.policy.operationId, result); return result; }
  async tombstone(event, context) { const result = {...event, revision: event.revision + 1, deleted: true, updatedAt: context.now, audit: {operationId: context.policy.operationId, actor: context.policy.actor, reason: context.policy.reason, action: "delete"}}; this.events.delete(event.id); this.deleted.set(event.id, result); this.operations.set(context.policy.operationId, result); return result; }
}

test("canonical model preserves stable UID and increments revision", () => {
  const event = normalizeEvent({calendarId: "family", uid: "family-1@example.test", title: "Practice", start: {kind: "date", date: "2026-09-21"}, end: {kind: "date", date: "2026-09-22"}}, {id: "event-1", revision: 3, now: "2026-09-20T12:00:00.000Z"});
  const updated = reviseEvent(event, {title: "Practice moved"}, "2026-09-20T13:00:00.000Z");
  assert.equal(updated.uid, event.uid);
  assert.equal(updated.revision, 4);
  assert.throws(() => reviseEvent(event, {uid: "replacement"}), /immutable/);
});

test("model rejects mixed all-day and timed boundaries", () => {
  assert.throws(() => normalizeEvent({calendarId: "family", title: "Broken", start: {kind: "date", date: "2026-09-21"}, end: {kind: "utc", dateTime: "2026-09-22T00:00:00Z"}}), /same boundary kind/);
});

test("calendar model separates the bot principal from named calendars", () => {
  const calendar = normalizeCalendar({name: "Kids activities", ownerAddress: "kids@bot.example", managerAgents: ["agent:max", "agent:liv"], members: [{email: "nadine@example.test"}], defaultForInbound: true, timeZone: "America/New_York", color: "#1A73E8"}, {id: "calendar-1", now: "2026-09-21T12:00:00.000Z"});
  assert.equal(calendar.ownerAddress, "kids@bot.example");
  assert.equal(calendar.name, "Kids activities");
  assert.equal(calendar.color, "#1a73e8");
  assert.equal(reviseCalendar(calendar, {name: "Kids + travel"}).revision, 2);
  assert.throws(() => reviseCalendar(calendar, {ownerAddress: "max@bot.example"}), /immutable/);
});

test("policy permits agents and trusted invitation recipients only", () => {
  assert.equal(authorizeMutation(agentPolicy).actor, "agent:max");
  assert.equal(authorizeMutation({origin: "inbound_invitation", recipient: "kids@bot.example", operationId: "invite-1", reason: "Inbound invitation"}, {allowInbound: true, trustedRecipients: ["kids@bot.example"]}).actor, "inbound:kids@bot.example");
  assert.throws(() => authorizeMutation({origin: "ui", operationId: "ui-1", reason: "Edit"}), /agent-only/);
  assert.throws(() => authorizeMutation({origin: "inbound_invitation", recipient: "other@example", operationId: "invite-2", reason: "Inbound"}, {allowInbound: true, trustedRecipients: ["kids@bot.example"]}), /not trusted/);
});

test("service enforces revision checks, idempotency, cancellation, and tombstones", async () => {
  const store = new TestStore();
  const service = new CalendarService({store, now: () => "2026-09-21T12:00:00.000Z"});
  const created = await service.create({event: {calendarId: "family", uid: "uid-1", title: "Dinner", start: {kind: "utc", dateTime: "2026-09-21T22:00:00Z"}, end: {kind: "utc", dateTime: "2026-09-21T23:00:00Z"}}, policy: agentPolicy});
  assert.equal(created.revision, 1);
  assert.equal((await service.create({event: {}, policy: agentPolicy})).idempotentReplay, true);
  await assert.rejects(service.update({id: created.id, expectedRevision: 9, event: {title: "Late dinner"}, policy: {...agentPolicy, operationId: "op-2"}}), /revision conflict/);
  const cancelled = await service.cancel({id: created.id, expectedRevision: 1, policy: {...agentPolicy, operationId: "op-3"}});
  assert.equal(cancelled.status, "cancelled");
  const deleted = await service.delete({id: created.id, expectedRevision: 2, policy: {...agentPolicy, operationId: "op-4"}});
  assert.equal(deleted.deleted, true);
  assert.equal(await service.read(created.id), null);
});

const requestIcs = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:invite-1@example.test", "SEQUENCE:2", "ORGANIZER:mailto:coach@example.test", "DTSTART;TZID=America/New_York:20260922T170000", "DTEND;TZID=America/New_York:20260922T180000", "RRULE:FREQ=WEEKLY;COUNT=4", "SUMMARY:Practice\\, field 2", "ATTENDEE;CN=Kid;PARTSTAT=NEEDS-ACTION:mailto:kid@example.test", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

test("invitation parser normalizes request fields and stable delivery identity", () => {
  const envelope = {recipient: "kids@bot.example", messageId: "message-1"};
  const first = normalizeInvitation(requestIcs, envelope);
  const second = normalizeInvitation(requestIcs, envelope);
  assert.equal(first.action, "import");
  assert.equal(first.event.start.timeZone, "America/New_York");
  assert.equal(first.event.title, "Practice, field 2");
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.sourceRevision, 2);
});

test("invitation parser maps METHOD:CANCEL to cancellation and rejects floating time", () => {
  const cancel = normalizeInvitation(requestIcs.replace("METHOD:REQUEST", "METHOD:CANCEL"), {recipient: "kids@bot.example", messageId: "message-2"});
  assert.equal(cancel.action, "cancel");
  assert.throws(() => normalizeInvitation(requestIcs.replace("DTSTART;TZID=America/New_York:", "DTSTART:").replace("DTEND;TZID=America/New_York:", "DTEND:"), {recipient: "kids@bot.example", messageId: "message-3"}), /floating/);
});

test("iCalendar rendering escapes, folds, preserves all-day and UTC values, and emits cancellations", () => {
  const events = [
    normalizeEvent({calendarId: "family", uid: "all-day@example.test", title: "Family, holiday; long title that must be folded across a standards-compliant content line because it exceeds seventy-five octets", category: "Travel", color: "#fb8c00", start: {kind: "date", date: "2026-12-24"}, end: {kind: "date", date: "2026-12-26"}}, {id: "a", revision: 2}),
    normalizeEvent({calendarId: "family", uid: "cancelled@example.test", title: "Cancelled", status: "cancelled", start: {kind: "utc", dateTime: "2026-09-21T20:00:00Z"}, end: {kind: "utc", dateTime: "2026-09-21T21:00:00Z"}, recurrence: ["RRULE:FREQ=WEEKLY"]}, {id: "b", revision: 4}),
  ];
  const feed = renderICalendar(events, {calendarId: "family", generatedAt: "2026-09-21T12:00:00.000Z"});
  assert.match(feed.body, /DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226/);
  assert.match(feed.body, /DTSTART:20260921T200000Z/);
  assert.match(feed.body, /SUMMARY:Family\\, holiday\\;/);
  assert.match(feed.body, /CATEGORIES:Travel/);
  assert.match(feed.body, /COLOR:#fb8c00/);
  assert.match(feed.body, /\r\n /);
  assert.match(feed.body, /SEQUENCE:4[\s\S]*STATUS:CANCELLED/);
  assert.equal(feed.etag, `"${feedRevision("family", events)}"`);
  assert.equal(renderICalendar(events, {calendarId: "family", generatedAt: "2026-09-22T12:00:00.000Z"}).etag, feed.etag);
});

test("named time zones require a complete VTIMEZONE component", () => {
  const event = normalizeEvent({calendarId: "family", uid: "zoned@example.test", title: "School", start: {kind: "zoned", dateTime: "2026-09-22T08:00:00", timeZone: "America/New_York"}, end: {kind: "zoned", dateTime: "2026-09-22T09:00:00", timeZone: "America/New_York"}}, {id: "z"});
  assert.throws(() => renderICalendar([event], {calendarId: "family"}), /missing VTIMEZONE/);
  const feed = renderICalendar([event], {calendarId: "family", timeZones: {"America/New_York": "BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nEND:VTIMEZONE"}});
  assert.match(feed.body, /DTSTART;TZID=America\/New_York:20260922T080000/);
});

test("agent tool contract exposes reads and auditable mutations without invitation or UI mutation tools", () => {
  assert.equal(calendarToolContract.calendar_list_calendars.readOnly, true);
  assert.equal(calendarToolContract.calendar_create_calendar.readOnly, false);
  assert.equal(calendarToolContract.calendar_list_events.readOnly, true);
  assert.equal(calendarToolContract.calendar_create_event.readOnly, false);
  assert.deepEqual(calendarToolContract.calendar_update_event.parameters.required, ["id", "expectedRevision", "event", "policy"]);
  assert.equal(Object.keys(calendarToolContract).some((name) => /google|caldav|invitation|ui/.test(name)), false);
});
