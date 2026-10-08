import {createHash, timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import http from "node:http";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {SqliteCalendarStore} from "./store.mjs";
import {isMainModule} from "./main-module.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`calendar: ${name} is required`);
  return value;
}

// Located at <runtime>/framework/services/calendar/server.mjs; framework root is two levels up.
const FRAMEWORK_ROOT = process.env.HUMANWARE_FRAMEWORK_ROOT ?? resolve(import.meta.dirname, "../..");
const SERVICE_ROOT = process.env.CALENDAR_SERVICE_ROOT ?? import.meta.dirname;
const DATABASE = process.env.CALENDAR_DATABASE ?? join(required("HUMANWARE_DATA_ROOT"), "working/projects/calendar/calendar.sqlite3");
const PUBLIC_FEED_BASE = required("CALENDAR_PUBLIC_FEED_BASE");
const BOT_DOMAIN = required("CALENDAR_BOT_DOMAIN");
const AGENT_ALLOWLIST = new Set(required("CALENDAR_AGENT_ALLOWLIST").split(",").map((value) => value.trim()).filter(Boolean));
const BRAND_NAME = process.env.CALENDAR_BRAND_NAME || "Humanware OS";
const FOOTER_TEXT = process.env.CALENDAR_FOOTER_TEXT || "Read-only projection. Ask an agent to create or change events.";
const PORT = Number(process.env.CALENDAR_PORT ?? 8794);

const [{CalendarService}, {normalizeCalendar}, {normalizeInvitation}, {renderICalendar}] = await Promise.all([
  import(pathToFileURL(join(FRAMEWORK_ROOT, "ops/calendar/service.js"))),
  import(pathToFileURL(join(FRAMEWORK_ROOT, "ops/calendar/calendar-model.js"))),
  import(pathToFileURL(join(FRAMEWORK_ROOT, "ops/calendar/invitation.js"))),
  import(pathToFileURL(join(FRAMEWORK_ROOT, "ops/calendar/ical.js"))),
]);

const EASTERN = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "END:DAYLIGHT", "BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");
const timeZones = {"America/New_York": EASTERN};
const store = new SqliteCalendarStore(DATABASE);
const eventService = new CalendarService({store});

function policy(actor, operationId, reason) { return {origin: "agent", actor, approved: true, operationId, reason}; }
function canManage(calendar, actor) { return calendar?.managerAgents?.includes(actor); }
function requireManager(calendarId, actor) {
  const calendar = store.readCalendar(calendarId);
  if (!calendar) throw Object.assign(new Error("calendar not found"), {status: 404});
  if (!canManage(calendar, actor)) throw Object.assign(new Error("agent is not a calendar manager"), {status: 403});
  return calendar;
}
function clean(object, keys) { return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]])); }
function safeSecretEqual(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function body(request, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error("request body too large"), {status: 413}); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function send(response, status, value, headers = {}) {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, {"content-type": typeof value === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "cache-control": "no-store", ...headers});
  response.end(payload);
}

async function runTool(name, args, actor, operationId) {
  if (!AGENT_ALLOWLIST.has(actor)) throw Object.assign(new Error("trusted agent identity is required"), {status: 403});
  if (name === "calendar_list_calendars") return store.listCalendars(args).filter((calendar) => canManage(calendar, actor));
  if (name === "calendar_read_calendar") { const calendar = store.readCalendar(args.id); if (!canManage(calendar, actor)) throw Object.assign(new Error("calendar not found"), {status: 404}); return calendar; }
  if (name === "calendar_create_calendar") {
    if (!String(args.ownerAddress ?? "").toLowerCase().endsWith(`@${BOT_DOMAIN}`)) throw new Error(`calendar owner must be a ${BOT_DOMAIN} bot address`);
    const managers = [...new Set([actor, ...(args.managerAgents ?? [])])];
    if (managers.some((value) => !AGENT_ALLOWLIST.has(value))) throw new Error("calendar managers must be configured agent identities");
    const calendar = normalizeCalendar({...clean(args, ["name", "description", "ownerAddress", "members", "defaultForInbound", "timeZone", "color"]), managerAgents: managers});
    return store.createCalendar(calendar, policy(actor, operationId, args.reason));
  }
  if (name === "calendar_list_inbox") {
    const recipients = [...new Set(store.listCalendars().filter((calendar) => canManage(calendar, actor)).map((calendar) => calendar.ownerAddress))];
    if (args.recipient && !recipients.includes(args.recipient.toLowerCase())) throw Object.assign(new Error("agent is not a manager for this bot inbox"), {status: 403});
    return store.listInbound({recipients, recipient: args.recipient, status: args.status});
  }
  if (name === "calendar_list_events") { requireManager(args.calendarId, actor); return store.list(args); }
  if (name === "calendar_read_event") { const event = await store.read(args.id); if (!event) throw Object.assign(new Error("event not found"), {status: 404}); requireManager(event.calendarId, actor); return event; }
  if (name === "calendar_create_event") {
    requireManager(args.calendarId, actor);
    const event = clean(args, ["calendarId", "title", "description", "location", "category", "color", "status", "start", "end", "recurrence", "attendees"]);
    return eventService.create({event, policy: policy(actor, operationId, args.reason)});
  }
  if (["calendar_update_event", "calendar_cancel_event", "calendar_delete_event"].includes(name)) {
    const current = await store.read(args.id); if (!current) throw Object.assign(new Error("event not found"), {status: 404}); requireManager(current.calendarId, actor);
    const input = {id: args.id, expectedRevision: args.expectedRevision, policy: policy(actor, operationId, args.reason)};
    if (name === "calendar_update_event") input.event = clean(args, ["title", "description", "location", "category", "color", "status", "start", "end", "recurrence", "attendees"]);
    return eventService[name === "calendar_update_event" ? "update" : name === "calendar_cancel_event" ? "cancel" : "delete"](input);
  }
  if (name === "calendar_create_feed") {
    requireManager(args.calendarId, actor);
    const grant = store.createFeed(args.calendarId, args.label, policy(actor, operationId, args.reason));
    return {...grant, token: undefined, url: `${PUBLIC_FEED_BASE}/${grant.token}.ics`};
  }
  throw Object.assign(new Error("unknown calendar tool"), {status: 404});
}

async function ingestEmail(payload) {
  const recipient = String(payload.recipient ?? "").toLowerCase();
  const messageId = String(payload.messageId ?? payload.eventId ?? "");
  if (!recipient || !messageId) throw new Error("calendar ingress requires recipient and messageId");
  const calendar = store.defaultCalendar(recipient);
  if (!payload.calendarPayload) {
    store.recordInbound({messageId, recipient, status: "pending", payload: {subject: payload.subject ?? "", replyTo: payload.replyTo ?? "", textBody: payload.textBody ?? ""}, receivedAt: payload.receivedAt});
    return {ok: true, status: "pending_agent_review"};
  }
  if (!calendar) throw new Error("recipient has no default inbound calendar");
  try {
    const proposal = normalizeInvitation(payload.calendarPayload, {recipient, messageId});
    const invitationService = new CalendarService({store, trustedInvitationRecipients: [recipient]});
    const result = await invitationService.applyInvitation(calendar.id, proposal);
    store.recordInbound({messageId, recipient, status: "applied", eventId: result.id, receivedAt: payload.receivedAt});
    const committed = await store.read(result.id);
    if (!committed || committed.revision !== result.revision) throw new Error("calendar receipt verification failed");
    const operationId = createHash("sha256").update(JSON.stringify([calendar.id, committed.id, committed.revision])).digest("hex");
    return {ok: true, calendarId: calendar.id, eventId: committed.id, action: proposal.action,
      receipt: {verified: true, domain: "calendar", operationId, resourceId: committed.id,
        outcome: result.idempotentReplay ? "duplicate" : committed.status === "cancelled" ? "cancelled" : "recorded", verifiedAt: new Date().toISOString()},
      display: {title: committed.title, when: `${committed.start.dateTime ?? committed.start.date} – ${committed.end.dateTime ?? committed.end.date}`}};
  } catch (error) {
    store.recordInbound({messageId, recipient, status: "rejected", diagnostic: error.message, receivedAt: payload.receivedAt});
    throw error;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

export async function handler(request, response) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") return send(response, 200, {ok: true, service: "calendar"});
    if (request.method === "GET" && url.pathname === "/api/dashboard") return send(response, 200, store.dashboard());
    if (request.method === "POST" && url.pathname.startsWith("/api/tools/")) {
      const input = await body(request); const actor = request.headers["x-calendar-agent"];
      return send(response, 200, await runTool(url.pathname.slice("/api/tools/".length), input.args ?? {}, actor, input.operationId));
    }
    if (request.method === "POST" && url.pathname === "/inbound/email") {
      if (!safeSecretEqual(request.headers["x-calendar-ingest-secret"], process.env.CALENDAR_INGEST_SECRET)) throw Object.assign(new Error("unauthorized"), {status: 401});
      return send(response, 200, await ingestEmail(await body(request)));
    }
    const feed = url.pathname.match(/^\/feed\/([A-Za-z0-9_-]+)\.ics$/);
    if (request.method === "GET" && feed) {
      const calendarId = store.resolveFeed(feed[1]); if (!calendarId) throw Object.assign(new Error("feed not found"), {status: 404});
      const calendar = store.readCalendar(calendarId); const events = await store.list({calendarId, includeCancelled: true});
      const rendered = renderICalendar(events, {calendarId, name: calendar.name, timeZones});
      if (request.headers["if-none-match"] === rendered.etag) { response.writeHead(304, {etag: rendered.etag}); return response.end(); }
      response.writeHead(200, {"content-type": rendered.contentType, "cache-control": "private, max-age=300", etag: rendered.etag, "content-disposition": `inline; filename="${calendarId}.ics"`});
      return response.end(rendered.body);
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (["index.html", "app.js", "styles.css"].includes(asset)) {
      let content = await readFile(join(SERVICE_ROOT, "public", asset));
      if (asset === "index.html") content = content.toString("utf8").replaceAll("{{BRAND_NAME}}", escapeHtml(BRAND_NAME)).replaceAll("{{FOOTER_TEXT}}", escapeHtml(FOOTER_TEXT));
      const type = asset.endsWith(".html") ? "text/html; charset=utf-8" : asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
      response.writeHead(200, {"content-type": type, "cache-control": "no-store"}); return response.end(content);
    }
    throw Object.assign(new Error("not found"), {status: 404});
  } catch (error) { return send(response, error.status ?? 400, {error: error.message}); }
}

if (isMainModule(import.meta.url, process.argv[1])) http.createServer(handler).listen(PORT, "127.0.0.1", () => console.log(JSON.stringify({event: "calendar_started", port: PORT})));
