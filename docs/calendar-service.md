# Calendar service

Budget: 1,400 words.

## Authority and ownership

Humanware OS defines one provider-independent calendar service. Its canonical calendar and event store is authoritative. Google Calendar, Apple Calendar, and other calendar providers are not foundations or write peers. Humanware OS owns the normalized model, agent operation contract, mutation policy, invitation normalization, iCalendar feed contract, reusable service code, schemas, and tests. A private instance owns service enablement, data-root paths, trusted bot addresses, mail ingress, feed routes and access policy, host configuration, and secrets. The data plane owns every calendar, event, mutation record, inbound message, idempotency record, feed grant, feed revision, and derived feed. None belong in framework source or the generated runtime.

The service receives a store implementation from the instance. The store is the only durable writer and must atomically persist an event revision with its audit record and operation-id claim. Framework test stores are disposable and never production authority.

## Canonical event and revision semantics

Each calendar has a stable internal ID, name, immutable owner bot address, managing agent identities, read-only human members, default time zone, display color, and an optional `defaultForInbound` role. The bot address is the administrative principal, not the calendar itself: one bot may own several named calendars, while exactly one active calendar per bot address may be the automatic destination for inbound invitations. Creating a bot address and creating a calendar are separate operations. Instances decide which bot addresses exist and which agents may administer them.

Every event belongs to exactly one canonical calendar and has a stable internal `id`, globally stable iCalendar `uid`, positive integer `revision`, `status`, title, optional description, location, category and color, start and exclusive end, recurrence lines, attendees, provenance, and audit metadata. Timed boundaries are either UTC instants or local wall times paired with an IANA time zone. All-day boundaries are ISO dates and retain RFC 5545's exclusive end. A recurring instance may carry `recurrenceId`; the series and exceptions share a UID.

Create starts at revision 1. Each accepted update, cancellation, or tombstone increments revision exactly once. `expectedRevision` makes mutation conditional and stale writes fail. Cancellation preserves the record with `STATUS:CANCELLED`; delete creates an auditable tombstone and removes the event from ordinary reads. UIDs never change or get reused. Operation IDs are unique across all mutation routes and make retries return the original result without another revision.

## Mutation contract

Agents use `calendar_list_calendars`, `calendar_read_calendar`, `calendar_create_calendar`, `calendar_list_events`, `calendar_read_event`, `calendar_create_event`, `calendar_update_event`, `calendar_cancel_event`, and `calendar_delete_event`. Feed grants are also created and revoked only by agents. Reads can be exposed to authorized consumers. Every mutation requires an authenticated agent actor, operation ID, reason, and explicit approval. Cancel and delete are distinct: cancel remains visible to feed consumers, while delete is a retained store tombstone.

No human-facing app receives a calendar mutation endpoint. `/cal` is a read-only projection for visualization and customization of its own view preferences; it cannot create, edit, cancel, delete, accept, or decline events. Calendar applications subscribe to read-only feeds. CalDAV, bidirectional provider sync, conflict resolution, provider CRUD, and UI writes are explicitly outside v1.

The sole non-agent origin is trusted mail delivered to an instance-declared bot address. Ordinary forwarded mail is retained as bounded, untrusted inbox context for an agent to interpret; it never mutates the calendar directly. An attached invitation enters **invitation ingestion**, which is not calendar creation. Mail ingress passes the raw calendar part plus envelope metadata to `normalizeInvitation`. The instance resolves the recipient to that bot's active `defaultForInbound` calendar, then the parser validates the method, UID, sequence, organizer, times, and supported recurrence fields before producing a proposed mutation. That proposal enters the same policy, operation-id, revision, audit, and store path as an agent mutation. `REQUEST` creates or updates an imported event; `CANCEL` cancels it. Duplicate delivery is idempotent by message identity plus calendar, UID, recurrence ID, sequence, and method. Untrusted recipients, missing or ambiguous default calendars, stale sequence numbers, malformed payloads, and unsupported methods fail closed. An invitation is input to policy, never direct store authority.

## Read-only iCalendar feeds

The feed renderer emits RFC 5545 `VCALENDAR` data with CRLF endings, folded content lines, escaped text, stable UID, integer `SEQUENCE` from revision, UTC `DTSTAMP`, all-day `VALUE=DATE` boundaries, UTC instants with `Z`, named-zone local values with `TZID`, recurrence and exception identifiers, attendees, category, optional RFC 7986 color, and cancellation status. Named-zone feeds require matching `VTIMEZONE` components supplied by the instance's time-zone adapter; generation fails rather than emit an unresolved TZID. Per-event colors are not consistently honored by calendar applications; the read-only `/cal` projection must render them, while subscribers may show only one application-selected color for the feed.

Feed ordering is deterministic. The feed revision and ETag are derived from the selected calendar identity and sorted event IDs, revisions, and tombstone/cancellation state, so unchanged content retains its validator. Feed routes support conditional GET, set a read-only calendar content type, and must not expose bearer credentials in URLs or logs. Access, cache, and publication policy belong to the private instance.

## Deliberate omissions

V1 does not implement private instance storage, mail routing, live feed hosting, provider OAuth, Google Calendar, CalDAV, contact records, invitation replies, free/busy federation, or a calendar editor. Contacts are a later domain. Provider-specific import or export may be added only as an adapter around the canonical store and may never become authority by accident.
