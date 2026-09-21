const string = {type: "string", minLength: 1};
const policy = {type: "object", additionalProperties: false, required: ["origin", "actor", "approved", "operationId", "reason"], properties: {origin: {const: "agent"}, actor: {type: "string", pattern: "^agent:"}, approved: {const: true}, operationId: string, reason: string}};
const boundary = {oneOf: [
  {type: "object", additionalProperties: false, required: ["kind", "date"], properties: {kind: {const: "date"}, date: {type: "string", format: "date"}}},
  {type: "object", additionalProperties: false, required: ["kind", "dateTime"], properties: {kind: {const: "utc"}, dateTime: {type: "string", format: "date-time", pattern: "Z$"}}},
  {type: "object", additionalProperties: false, required: ["kind", "dateTime", "timeZone"], properties: {kind: {const: "zoned"}, dateTime: {type: "string"}, timeZone: string}},
]};
const event = {type: "object", additionalProperties: false, required: ["title", "start", "end"], properties: {uid: string, title: string, description: {type: ["string", "null"]}, location: {type: ["string", "null"]}, status: {enum: ["confirmed", "tentative", "cancelled"]}, start: boundary, end: boundary, recurrenceId: boundary, recurrence: {type: "array", items: string}, attendees: {type: "array", items: {type: "object", additionalProperties: false, required: ["email"], properties: {email: {type: "string", format: "email"}, name: {type: "string"}, role: {type: "string"}, response: {type: "string"}}}}}};

export const calendarToolContract = {
  calendar_list_events: {readOnly: true, parameters: {type: "object", additionalProperties: false, required: ["calendarId", "from", "to"], properties: {calendarId: string, from: string, to: string, includeCancelled: {type: "boolean"}}}},
  calendar_read_event: {readOnly: true, parameters: {type: "object", additionalProperties: false, required: ["id"], properties: {id: string}}},
  calendar_create_event: {readOnly: false, parameters: {type: "object", additionalProperties: false, required: ["event", "policy"], properties: {event, policy}}},
  calendar_update_event: {readOnly: false, parameters: {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "event", "policy"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, event, policy}}},
  calendar_cancel_event: {readOnly: false, parameters: {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "policy"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, policy}}},
  calendar_delete_event: {readOnly: false, parameters: {type: "object", additionalProperties: false, required: ["id", "expectedRevision", "policy"], properties: {id: string, expectedRevision: {type: "integer", minimum: 1}, policy}}},
};
