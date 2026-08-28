# Session Console

The Session Console is the operational home for agent work. Slack and future apps are notification/input surfaces; the console owns the live session view.

`build-session-console.py` adapts OpenClaw's local trajectories into two layers
using Humanware OS's `schemas/session-event.schema.json` contract:

- `evidence/sessions/events/YYYY-MM-DD.jsonl`: append-only, sanitized normalized events.
- `generated/sessions/current.json`: bounded read model polled by the private UI.

The ledger retains actions, timestamps, tools, bounded redacted results, models,
usage, errors, and provider-visible reasoning checkpoints. It never copies raw
system prompts, compiled context, full messages, credentials, or hidden model
chain-of-thought. Each normalized event keeps a source filename and sequence so
an operator can inspect Tier-0 evidence locally when necessary.

The schema is harness-neutral. Additional adapters should emit the same event
shape and use stable event IDs; the UI must not depend on OpenClaw internals.
