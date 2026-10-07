import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import http from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

const temporary = mkdtempSync(join(tmpdir(), "calendar-test-"));
process.env.CALENDAR_DATABASE = join(temporary, "calendar.sqlite3");
process.env.CALENDAR_SERVICE_ROOT = join(import.meta.dirname);
process.env.CALENDAR_INGEST_SECRET = "test-ingest-secret";
process.env.CALENDAR_PUBLIC_FEED_BASE = "https://cal.example.test/feed";
process.env.CALENDAR_BOT_DOMAIN = "bot.example.test";
process.env.CALENDAR_AGENT_ALLOWLIST = "agent:alpha,agent:beta";
const {handler} = await import("./server.mjs");
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function tool(name, args, actor = "agent:beta", operationId = `${name}-${crypto.randomUUID()}`) {
  const response = await fetch(`${origin}/api/tools/${name}`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-agent": actor}, body: JSON.stringify({operationId, args})});
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}

test("agent creates a bot-owned calendar, event, and read-only feed", async () => {
  const calendar = await tool("calendar_create_calendar", {name: "Kids activities", ownerAddress: "kids@bot.example.test", members: [{email: "nadine@example.test"}], defaultForInbound: true, timeZone: "America/New_York", color: "#1a73e8", reason: "Start product testing"});
  assert.equal(calendar.managerAgents[0], "agent:beta");
  assert.equal(calendar.members[0].email, "nadine@example.test");
  const event = await tool("calendar_create_event", {calendarId: calendar.id, title: "Soccer", category: "Felix", color: "#34a853", start: {kind: "zoned", dateTime: "2026-09-23T17:00:00", timeZone: "America/New_York"}, end: {kind: "zoned", dateTime: "2026-09-23T18:30:00", timeZone: "America/New_York"}, reason: "Add practice"});
  assert.equal(event.revision, 1);
  const grant = await tool("calendar_create_feed", {calendarId: calendar.id, label: "Nadine", reason: "Share read-only feed"});
  const token = grant.url.match(/\/([^/]+)\.ics$/)[1];
  const feed = await fetch(`${origin}/feed/${token}.ics`);
  assert.equal(feed.status, 200);
  const ics = await feed.text();
  assert.match(ics, /X-WR-CALNAME:Kids activities/);
  assert.match(ics, /SUMMARY:Soccer/);
  assert.match(ics, /CATEGORIES:Felix/);
  assert.match(ics, /BEGIN:VTIMEZONE/);
});

test("an emailed invitation enters the default calendar and remains agent-readable", async () => {
  const calendar = (await tool("calendar_list_calendars", {ownerAddress: "kids@bot.example.test"}))[0];
  const calendarPayload = ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:school-1@example.test", "SEQUENCE:0", "ORGANIZER:mailto:school@example.test", "DTSTART:20260924T210000Z", "DTEND:20260924T220000Z", "SUMMARY:Back to school night", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const response = await fetch(`${origin}/inbound/email`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-ingest-secret": "test-ingest-secret"}, body: JSON.stringify({recipient: "kids@bot.example.test", messageId: "message-school-1", receivedAt: "2026-09-21T21:00:00Z", calendarPayload})});
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.calendarId, calendar.id);
  const replay = await fetch(`${origin}/inbound/email`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-ingest-secret": "test-ingest-secret"}, body: JSON.stringify({recipient: "kids@bot.example.test", messageId: "message-school-1-forwarded-again", receivedAt: "2026-09-21T21:01:00Z", calendarPayload})});
  assert.equal(replay.status, 200);
  const events = await tool("calendar_list_events", {calendarId: calendar.id, from: "2026-09-01", to: "2026-10-01", includeCancelled: true});
  assert.equal(events.some((event) => event.title === "Back to school night"), true);
  assert.equal(events.find((event) => event.title === "Back to school night").revision, 1);
});

test("ordinary forwarded mail remains bounded inbox context for an agent", async () => {
  const response = await fetch(`${origin}/inbound/email`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-ingest-secret": "test-ingest-secret"}, body: JSON.stringify({recipient: "kids@bot.example.test", messageId: "message-forward-1", receivedAt: "2026-09-21T21:05:00Z", subject: "Fall recital dates", replyTo: "school@example.test", textBody: "The recital is October 14 at 6pm."})});
  assert.equal(response.status, 200);
  const inbox = await tool("calendar_list_inbox", {recipient: "kids@bot.example.test", status: "pending"});
  assert.equal(inbox[0].subject, "Fall recital dates");
  assert.equal(inbox[0].textBody, "The recital is October 14 at 6pm.");
});

test("non-managing agents cannot read or mutate a calendar", async () => {
  const calendar = (await tool("calendar_list_calendars", {ownerAddress: "kids@bot.example.test"}))[0];
  const response = await fetch(`${origin}/api/tools/calendar_list_events`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-agent": "agent:other"}, body: JSON.stringify({operationId: "denied", args: {calendarId: calendar.id, from: "2026-09-01", to: "2026-10-01"}})});
  assert.equal(response.status, 403);
});
