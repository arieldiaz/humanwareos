# Agent email Worker

Cloudflare Email Routing Worker that accepts the addresses in `ALLOWED_RECIPIENTS`, capped at `MAX_RAW_BYTES` (default 64 KiB) raw MIME including attachments. It queues original MIME as base64 with bounded envelope metadata and a stable content-derived delivery ID on the `EMAIL_EVENTS` queue binding. MIME parsing, cryptographic sender authentication, attachments, calendar authorization and agent dispatch belong to the local trusted [email intake](../email-intake/README.md). Visible or forged authentication headers confer no authority. The Worker never sends automatic replies. `SERVICE_NAME` sets the name reported by `fetch` (default `agent-email`).

The Worker only produces queue messages; the local intake pulls ingress and dead-letter messages over authenticated outbound HTTPS (Cloudflare Queues HTTP pull). Queue payloads exceeding 128 KiB are rejected before enqueue.

The instance owns `wrangler.jsonc` (worker name, addresses, queue names) with `main` pointing at this `src/index.js`. Test with `npm ci --ignore-scripts && npm test`.
