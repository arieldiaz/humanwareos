import {randomUUID} from "node:crypto";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function validateBoundary(boundary, name) {
  if (boundary?.kind === "date" && DATE.test(boundary.date)) return {...boundary};
  if (boundary?.kind === "utc" && typeof boundary.dateTime === "string" && !Number.isNaN(Date.parse(boundary.dateTime)) && boundary.dateTime.endsWith("Z")) return {...boundary};
  if (boundary?.kind === "zoned" && LOCAL_DATE_TIME.test(boundary.dateTime) && typeof boundary.timeZone === "string" && boundary.timeZone.includes("/")) return {...boundary};
  throw new Error(`${name} must be an all-day date, UTC instant, or local date-time with an IANA time zone`);
}

export function normalizeEvent(input, {id = randomUUID(), uid = `${randomUUID()}@humanware.local`, revision = 1, now = new Date().toISOString()} = {}) {
  const start = validateBoundary(input.start, "start");
  const end = validateBoundary(input.end, "end");
  if (start.kind !== end.kind) throw new Error("start and end must use the same boundary kind");
  if ((start.kind === "zoned" && start.timeZone !== end.timeZone) || boundaryValue(end) <= boundaryValue(start)) throw new Error("end must be after start in the same time zone");
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision must be a positive integer");
  return {
    id: required(id, "id"), calendarId: required(input.calendarId, "calendarId"), uid: required(input.uid ?? uid, "uid"), revision,
    status: input.status ?? "confirmed", title: required(input.title, "title"),
    description: input.description ?? null, location: input.location ?? null, start, end,
    category: input.category ?? null, color: input.color ?? null,
    recurrence: [...(input.recurrence ?? [])], recurrenceId: input.recurrenceId ? validateBoundary(input.recurrenceId, "recurrenceId") : null,
    attendees: (input.attendees ?? []).map((attendee) => ({email: required(attendee.email, "attendee email").toLowerCase(), name: attendee.name ?? null, role: attendee.role ?? "REQ-PARTICIPANT", response: attendee.response ?? "NEEDS-ACTION"})),
    provenance: input.provenance ?? {kind: "agent"}, createdAt: input.createdAt ?? now, updatedAt: now,
  };
}

export function boundaryValue(boundary) {
  return boundary.kind === "date" ? boundary.date : boundary.dateTime;
}

export function reviseEvent(current, patch, now = new Date().toISOString()) {
  if (patch.uid && patch.uid !== current.uid) throw new Error("event UID is immutable");
  if (patch.calendarId && patch.calendarId !== current.calendarId) throw new Error("event calendarId is immutable");
  return normalizeEvent({...current, ...patch, uid: current.uid, createdAt: current.createdAt}, {id: current.id, uid: current.uid, revision: current.revision + 1, now});
}
