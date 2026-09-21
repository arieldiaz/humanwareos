import {createHash} from "node:crypto";

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function property(line) {
  const separator = line.indexOf(":");
  if (separator < 1) return null;
  const [name, ...parameters] = line.slice(0, separator).split(";");
  return {name: name.toUpperCase(), parameters: Object.fromEntries(parameters.map((part) => { const index = part.indexOf("="); return [part.slice(0, index).toUpperCase(), part.slice(index + 1)]; })), value: line.slice(separator + 1)};
}

function text(value = "") {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function boundary(item) {
  if (!item) throw new Error("invitation requires DTSTART and DTEND");
  if (item.parameters.VALUE === "DATE" || /^\d{8}$/.test(item.value)) return {kind: "date", date: `${item.value.slice(0, 4)}-${item.value.slice(4, 6)}-${item.value.slice(6, 8)}`};
  const basic = item.value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/, "$1-$2-$3T$4:$5:$6");
  if (item.value.endsWith("Z")) return {kind: "utc", dateTime: `${basic}Z`};
  if (item.parameters.TZID) return {kind: "zoned", dateTime: basic, timeZone: item.parameters.TZID};
  throw new Error("floating invitation times are not supported");
}

export function normalizeInvitation(ics, envelope) {
  const lines = unfold(ics).map(property).filter(Boolean);
  if (lines.filter((item) => item.name === "BEGIN" && item.value.toUpperCase() === "VEVENT").length !== 1) throw new Error("invitation must contain exactly one VEVENT");
  const first = (name) => lines.find((item) => item.name === name);
  const method = first("METHOD")?.value?.toUpperCase();
  if (!["REQUEST", "CANCEL"].includes(method)) throw new Error("only REQUEST and CANCEL invitations are supported");
  const uid = first("UID")?.value;
  const organizer = first("ORGANIZER")?.value?.replace(/^mailto:/i, "").toLowerCase();
  if (!uid || !organizer) throw new Error("invitation requires UID and ORGANIZER");
  const sequence = Number(first("SEQUENCE")?.value ?? 0);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("invitation SEQUENCE must be a non-negative integer");
  const recurrenceId = first("RECURRENCE-ID");
  const recipient = envelope.recipient?.toLowerCase();
  const messageId = envelope.messageId;
  if (!recipient || !messageId) throw new Error("invitation envelope requires recipient and messageId");
  const operationId = `invite:${createHash("sha256").update([recipient, messageId, uid, recurrenceId?.value ?? "", sequence, method].join("\0")).digest("hex")}`;
  return {
    action: method === "CANCEL" ? "cancel" : "import", operationId, sourceRevision: sequence,
    event: {
      uid, status: method === "CANCEL" ? "cancelled" : (first("STATUS")?.value?.toLowerCase() ?? "confirmed"),
      title: text(first("SUMMARY")?.value ?? "Untitled invitation"), description: first("DESCRIPTION") ? text(first("DESCRIPTION").value) : null,
      location: first("LOCATION") ? text(first("LOCATION").value) : null, start: boundary(first("DTSTART")), end: boundary(first("DTEND")),
      recurrence: lines.filter((item) => ["RRULE", "RDATE", "EXDATE"].includes(item.name)).map((item) => `${item.name}:${item.value}`),
      recurrenceId: recurrenceId ? boundary(recurrenceId) : null,
      attendees: lines.filter((item) => item.name === "ATTENDEE").map((item) => ({email: item.value.replace(/^mailto:/i, ""), name: item.parameters.CN ?? null, role: item.parameters.ROLE, response: item.parameters.PARTSTAT})),
      provenance: {kind: "inbound_invitation", organizer, messageId, recipient, sourceRevision: sequence},
    },
    policy: {origin: "inbound_invitation", recipient, operationId, reason: `Import ${method} invitation from ${organizer}`},
  };
}
