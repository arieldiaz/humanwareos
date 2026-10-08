# Calendar service

Durable SQLite store, loopback agent API, public capability iCalendar feeds, authenticated email ingress, and the read-only `/` dashboard projection for the Humanware calendar contract. Calendar libraries live in `ops/calendar/`. Source and runtime builds contain no events, feed tokens, inbound mail, or audit records; state lives under the data root.

The process binds only to `127.0.0.1`. Feed paths are capabilities: disable access logging on any public host that proxies `/feed/*`. `/inbound/email` requires the `x-calendar-ingest-secret` header to match `CALENDAR_INGEST_SECRET`, which instance wiring resolves from protected storage; it must never appear in source, arguments, URLs, or logs.

Configuration (environment):

| Variable | Required | Meaning |
| --- | --- | --- |
| `CALENDAR_INGEST_SECRET` | yes (for ingress) | Shared secret for `/inbound/email` |
| `CALENDAR_PUBLIC_FEED_BASE` | yes | Public base URL for `.ics` feeds |
| `CALENDAR_BOT_DOMAIN` | yes | Calendar owner addresses must be `@<domain>` |
| `CALENDAR_AGENT_ALLOWLIST` | yes | Comma-separated `x-calendar-agent` actors allowed to manage calendars |
| `HUMANWARE_DATA_ROOT` | unless `CALENDAR_DATABASE` | Database at `<data>/working/projects/calendar/calendar.sqlite3` |
| `CALENDAR_DATABASE` | no | Explicit database path |
| `CALENDAR_PORT` | no (8794) | Loopback port |
| `CALENDAR_BRAND_NAME` | no ("Humanware OS") | Dashboard title/eyebrow |
| `CALENDAR_FOOTER_TEXT` | no | Dashboard footer |
| `HUMANWARE_FRAMEWORK_ROOT` | no | Defaults to two directories above this file |
| `CALENDAR_SERVICE_ROOT` | no | Directory containing `public/`; defaults to this directory |

Tests: `node --test services/calendar/*.test.mjs` from the framework root.
