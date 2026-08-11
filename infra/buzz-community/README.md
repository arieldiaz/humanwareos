# HumanwareOS Buzz community alpha

Deploys one Buzz relay container behind a Cloudflare Worker at `community.humanwareos.com`. PostgreSQL and Redis remain managed external services; media and git objects live in two private Cloudflare R2 buckets.

This is an alpha, deliberately capped at one `standard-1` container and 250 WebSocket connections. The Worker keeps one named container instance, proxies WebSockets, exposes separate Worker and relay readiness probes, and passes only an explicit set of runtime settings and secrets into the container.

## Architecture

```text
community.humanwareos.com
  -> Cloudflare Worker (TLS, hostname, edge controls)
  -> one Buzz Cloudflare Container (HTTP + WebSocket)
       -> managed PostgreSQL over TLS
       -> managed Redis over TLS
       -> R2 media bucket
       -> R2 git-object bucket

private runner -> outbound authenticated Buzz connection only
```

The private runner is not an availability dependency. It can run coding sessions and agents, but public human chat remains in the cloud when the runner is offline.

## Required secret names

Supply these through Doppler or another process-level secrets manager. Values never enter this repo.

- Cloudflare: `CF_ACCOUNT_ID`, `CF_HUMANWAREOS_PLATFORM_TOKEN`, `CF_HUMANWAREOS_R2_ACCESS_KEY_ID`, `CF_HUMANWAREOS_R2_SECRET_ACCESS_KEY`
- Managed services: `BUZZ_COMMUNITY_DATABASE_URL`, `BUZZ_COMMUNITY_REDIS_URL`
- Relay identity: `BUZZ_COMMUNITY_RELAY_PRIVATE_KEY`, `BUZZ_COMMUNITY_OWNER_PUBKEY`
- Git hook signing: `BUZZ_COMMUNITY_GIT_HOOK_HMAC_SECRET`

The database URL must be the Supabase direct or session-mode TLS URL, not the transaction pooler. Supabase documents direct connections for long-lived containers and session mode for persistent clients on IPv4-only networks. Redis must expose ordinary Redis protocol with TLS; the recommended alpha provider is Upstash, whose current compatibility matrix includes Pub/Sub and scripting. A REST-only cache product is not compatible with Buzz's long-lived subscription connection.

## Verify without deploying

```sh
cd infra/buzz-community
npm ci
doppler run -- npm run check
```

`npm run check` validates the required secret names and value shapes and performs a Cloudflare container dry-run. It does not create resources or publish a Worker.

After the provider URLs exist, verify the exact capabilities Buzz needs before deployment:

```sh
doppler run -- npm run probe:providers
```

The probe performs `SELECT 1` against PostgreSQL, then verifies Redis TLS, `PING`, Lua `EVAL`, and a real publish/subscribe round trip. It writes no durable application data.

## Deploy

The alpha deploys a relay image built from the maintained
[`arieldiaz/buzz`](https://github.com/arieldiaz/buzz) fork. The fork tracks
`block/buzz`; deployment tags are pinned to a tested commit, while
`r2-alpha` is only a moving convenience tag. Build the pinned image with the
`Buzz community image` GitHub Actions workflow before changing `BUZZ_IMAGE`
in the Dockerfile.

```sh
cd infra/buzz-community
doppler run -- npm run deploy
```

Deployment creates the two R2 buckets if absent, streams the mapped Worker secrets to Wrangler over stdin, builds the Buzz image, deploys the Worker and container, and attaches the custom hostname. It does not provision PostgreSQL or Redis.

## Acceptance checks

1. `GET /_alpha/worker-health` returns Worker JSON without starting the relay.
2. `GET /_alpha/relay-readiness` returns Buzz readiness after cold start.
3. A WebSocket remains usable for 30 minutes and reconnects after a forced container restart.
4. Buzz's startup git conformance probe passes against the git R2 bucket.
5. Upload, authenticated download, delete, and retention cleanup pass against the media R2 bucket.
6. A database backup restores into a clean Supabase project.
7. Disconnecting the private runner does not affect human chat.

## Hard gates

- Deploy only an immutable image tag built from a tested commit in
  `arieldiaz/buzz` that contains the R2-compatible deletion path. Continue
  upstreaming the patch through
  [block/buzz#5522](https://github.com/block/buzz/pull/5522); after merge, drop
  the fork-only patch and resume building from clean upstream commits.
- Start with ten invited people and three public channels.
- Never place Claude, Codex, or other operator subscription credentials in the public container. Each user supplies their own supported provider credential; private subscription-backed coding sessions stay on the operator's runner.
- Keep normal container internet egress enabled for PostgreSQL and Redis TCP. Revisit host allowlisting only after compatible provider endpoints are known.
