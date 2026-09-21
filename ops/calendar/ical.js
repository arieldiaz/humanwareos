import {createHash} from "node:crypto";

export function escapeText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

export function foldLine(line) {
  const chunks = [];
  let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > 75) { chunks.push(current); current = ` ${character}`; } else current += character;
  }
  chunks.push(current);
  return chunks.join("\r\n");
}

function basic(value) { return value.replace(/[-:]/g, ""); }
function temporal(name, boundary) {
  if (boundary.kind === "date") return `${name};VALUE=DATE:${basic(boundary.date)}`;
  if (boundary.kind === "utc") return `${name}:${basic(boundary.dateTime).replace(".000", "")}`;
  return `${name};TZID=${boundary.timeZone}:${basic(boundary.dateTime)}`;
}

export function feedRevision(calendarId, events) {
  const state = events.map((event) => `${event.id}:${event.revision}:${event.status}`).sort().join("\n");
  return createHash("sha256").update(`${calendarId}\n${state}`).digest("hex");
}

export function renderICalendar(events, {calendarId, name = "Calendar", prodId = "-//Humanware OS//Calendar//EN", timeZones = {}, generatedAt = new Date().toISOString()} = {}) {
  if (!calendarId) throw new Error("calendarId is required for a stable feed revision");
  const zones = new Set(events.flatMap((event) => [event.start, event.end, event.recurrenceId].filter((item) => item?.kind === "zoned").map((item) => item.timeZone)));
  for (const zone of zones) if (!timeZones[zone]) throw new Error(`missing VTIMEZONE component for ${zone}`);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeText(name)}`];
  for (const zone of [...zones].sort()) lines.push(...unfoldComponent(timeZones[zone]));
  const stamp = basic(new Date(generatedAt).toISOString().replace(/\.\d{3}/, ""));
  for (const event of [...events].sort((a, b) => a.uid.localeCompare(b.uid) || a.revision - b.revision)) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `SEQUENCE:${event.revision}`, `DTSTAMP:${stamp}`, temporal("DTSTART", event.start), temporal("DTEND", event.end), `SUMMARY:${escapeText(event.title)}`);
    if (event.recurrenceId) lines.push(temporal("RECURRENCE-ID", event.recurrenceId));
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.category) lines.push(`CATEGORIES:${escapeText(event.category)}`);
    if (event.color) lines.push(`COLOR:${event.color}`);
    for (const rule of event.recurrence ?? []) lines.push(rule);
    for (const attendee of event.attendees ?? []) lines.push(`ATTENDEE;ROLE=${attendee.role};PARTSTAT=${attendee.response}${attendee.name ? `;CN=${escapeText(attendee.name)}` : ""}:mailto:${attendee.email}`);
    if (event.status === "cancelled") lines.push("STATUS:CANCELLED");
    else if (event.status === "tentative") lines.push("STATUS:TENTATIVE");
    else lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const body = `${lines.map(foldLine).join("\r\n")}\r\n`;
  const revision = feedRevision(calendarId, events);
  return {body, revision, etag: `"${revision}"`, contentType: "text/calendar; charset=utf-8"};
}

function unfoldComponent(component) {
  const lines = component.trim().split(/\r?\n/);
  if (lines[0] !== "BEGIN:VTIMEZONE" || lines.at(-1) !== "END:VTIMEZONE") throw new Error("time zone adapter must supply a complete VTIMEZONE component");
  return lines;
}
