# Campfire channel adapter

The Campfire bridge accepts native Campfire bot webhooks, acknowledges them immediately, runs the selected Humanware OS identity through OpenClaw, and posts the completed response to the bot-scoped room API supplied by Campfire.

Run one private bridge for an installation. Point each Campfire bot at `/campfire/<agent-id>`. Bind the listener to loopback or another private interface: Campfire webhooks are not signed. Do not publish the bridge through the Campfire ingress hostname.

The adapter preserves one OpenClaw session per agent and Campfire room, serializes turns inside that session, treats webhook text as untrusted input, validates reply paths, and never stores bot keys. Campfire includes the bot-scoped reply path in each webhook payload.

Required environment:

- `CAMPFIRE_BASE_URL`: the canonical HTTPS origin.
- `CAMPFIRE_BRIDGE_HOST`: private bind address; defaults to `127.0.0.1`.
- `CAMPFIRE_BRIDGE_PORT`: listener port; defaults to `3304`.
- `CAMPFIRE_AGENTS`: comma-separated OpenClaw agent IDs; defaults to `liv,max`.
- `OPENCLAW_BIN`: OpenClaw executable; defaults to `/opt/homebrew/bin/openclaw`.
