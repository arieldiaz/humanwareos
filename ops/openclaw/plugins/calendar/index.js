import {randomUUID} from "node:crypto";

const text = (value, isError = false) => ({content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value)}], ...(isError ? {isError: true} : {})});
const string = {type: "string", minLength: 1};
const boundary = {oneOf: [
  {type: "object", additionalProperties: false, required: ["kind", "date"], properties: {kind: {const: "date"}, date: string}},
  {type: "object", additionalProperties: false, required: ["kind", "dateTime"], properties: {kind: {const: "utc"}, dateTime: string}},
  {type: "object", additionalProperties: false, required: ["kind", "dateTime", "timeZone"], properties: {kind: {const: "zoned"}, dateTime: string, timeZone: string}},
]};
const member = {type: "object", additionalProperties: false, required: ["email"], properties: {email: string, name: {type: "string"}}};
const eventFields = {calendarId: string, title: string, description: {type: ["string", "null"]}, location: {type: ["string", "null"]}, category: {type: ["string", "null"]}, color: {type: ["string", "null"]}, status: {enum: ["confirmed", "tentative", "cancelled"]}, start: boundary, end: boundary, recurrence: {type: "array", items: string}, attendees: {type: "array", items: {type: "object", additionalProperties: false, required: ["email"], properties: {email: string, name: {type: "string"}, role: {type: "string"}, response: {type: "string"}}}}, reason: string};

export class CalendarClient {
  constructor(endpoint, actor, fetchImpl = fetch) {
    this.endpoint = endpoint;
    this.actor = actor;
    this.fetchImpl = fetchImpl;
  }
  async call(tool, args, operationId = randomUUID()) {
    const response = await this.fetchImpl(`${this.endpoint}/api/tools/${tool}`, {method: "POST", headers: {"content-type": "application/json", "x-calendar-agent": this.actor}, body: JSON.stringify({operationId, args})});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `calendar service returned HTTP ${response.status}`);
    return body;
  }
}

function definitions(client) {
  const tool = (name, description, parameters) => ({name, description, parameters, async execute(id, args) { try { return text(await client.call(name, args, id)); } catch (error) { return text(error.message, true); } }});
  return [
    tool("calendar_list_calendars", "List calendars this agent can administer.", {type: "object", additionalProperties: false, properties: {ownerAddress: string}}),
    tool("calendar_read_calendar", "Read one calendar and its sharing metadata.", {type: "object", additionalProperties: false, required: ["id"], properties: {id: string}}),
    tool("calendar_create_calendar", "Create a named canonical calendar owned by a bot address. Human members receive read-only access; all writes remain agent-only.", {type: "object", additionalProperties: false, required: ["name", "ownerAddress", "reason"], properties: {name: string, ownerAddress: string, description: {type: "string"}, managerAgents: {type: "array", items: string}, members: {type: "array", items: member}, defaultForInbound: {type: "boolean"}, timeZone: string, color: string, reason: string}}),
    tool("calendar_list_inbox", "List forwarded email and invitation context waiting for an agent under bot-owned calendars.", {type: "object", additionalProperties: false, properties: {recipient: string, status: {enum: ["pending", "applied", "rejected"]}}}),
    tool("calendar_list_events", "List events in a calendar for a time range.", {type: "object", additionalProperties: false, required: ["calendarId", "from", "to"], properties: {calendarId: string, from: string, to: string, includeCancelled: {type: "boolean"}}}),
    tool("calendar_read_event", "Read one canonical calendar event.", {type: "object", additionalProperties: false, required: ["id"], properties: {id: string}}),
    tool("calendar_create_event", "Create an event in a canonical calendar.", {type: "object", additionalProperties: false, required: ["calendarId", "title", "start", "end", "reason"], properties: eventFields}),
    tool("calendar_update_event", "Update an event using its current revision.", {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "reason"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, ...eventFields}}),
    tool("calendar_cancel_event", "Cancel an event while preserving it in feeds and audit history.", {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "reason"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, reason: string}}),
    tool("calendar_delete_event", "Delete an event by creating an auditable tombstone.", {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "reason"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, reason: string}}),
    tool("calendar_create_feed", "Create a revocable read-only subscription URL for one calendar.", {type: "object", additionalProperties: false, required: ["calendarId", "label", "reason"], properties: {calendarId: string, label: string, reason: string}}),
  ];
}

export default {id: "calendar", register(api) {
  for (const name of ["calendar_list_calendars", "calendar_read_calendar", "calendar_create_calendar", "calendar_list_inbox", "calendar_list_events", "calendar_read_event", "calendar_create_event", "calendar_update_event", "calendar_cancel_event", "calendar_delete_event", "calendar_create_feed"]) {
    api.registerTool((context) => definitions(new CalendarClient(api.pluginConfig.endpoint, `agent:${context.agentId ?? "unknown"}`)).find((item) => item.name === name), {name});
  }
}};
