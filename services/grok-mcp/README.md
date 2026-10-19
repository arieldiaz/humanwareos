# Grok MCP bridge

Authenticated, stateless Streamable HTTP MCP bridge from Grok Bot into the Humanware OS data plane. The framework owns the protocol and storage mechanics; an instance supplies the listen address, public HTTPS origin, client-specific mount path, explicit context allowlist, data-root-relative destinations, launchd services, tunnel, and secret references.

The bridge exposes five tools:

- `get_context` reads only configured Tier 2 projections and returns bounded content.
- `record_turn` appends one immutable raw Grok exchange.
- `save_work` creates an idempotent Markdown work item.
- `propose_memory` appends a proposal for later curation and never edits current memory.
- `stage_artifact` creates an inert, escaped-text artifact candidate and never promotes or publishes it.

Every write requires a caller-supplied `operationId`. Retrying the same input is a replay; reusing an operation ID with different input fails. Returned locations are logical `data:` references rather than host paths.

The service binds only to loopback. Put a named HTTPS tunnel in front of it, require a bearer token of at least 32 characters, and expose only the configured single-slug mount path plus the detail-free `/health` probe. The path selects a client policy profile; authentication still comes from the bearer token. Neither request bodies nor credentials are logged.

Run its tests with:

```text
npm ci --ignore-scripts
npm test
```
