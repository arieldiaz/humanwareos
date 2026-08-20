# The secrets layer

Every credential in a Humanware OS instance—model API keys, Slack tokens,
Notion tokens, DNS tokens — lives in one secrets manager and nowhere else.
Not in `.env` files, not in launchd plists, not in agent instruction files,
and never in git. This doc is the contract any manager must satisfy, and a
worked default (Doppler) that satisfies it with near-zero operational
burden.

## The contract

Whatever manager you choose, the layer must give you:

1. **One source of truth outside git.** Adding, changing, or rotating a
   secret happens in the manager; nothing else is authoritative.
2. **Read-only credentials per consumer, scoped tight.** The app gets a
   token that reads only the app's secrets; each agent gets a token that
   reads only its own. An agent's credential must *fail* to read another
   agent's project — and you verify that failure, you don't assume it
   (`verify-agents.sh`).
3. **Hydrate at launch, run on plain env vars.** Daemons fetch secrets once
   at startup and exec the real process; dev commands run under a wrapper
   (`doppler run -- <cmd>`). Nothing fetches the manager per request.
4. **A tiny bootstrap tier as mode-600 files outside git.** Something has
   to unlock the manager itself. Those few credentials live in files like
   `~/.config/humanwareos/doppler.env`, permissions 600, never in the repo.
   Full-disk encryption covers them at rest.
5. **Names only, everywhere else.** Key *names* may appear in code, docs,
   logs, and agent replies; *values* never. A value that leaks into a
   commit, log, or transcript is a rotation, not a cleanup.
6. **Rotation is deliberate.** Migrations and re-homing are rotation
   moments; keep a checklist of which keys exist and who consumes each.

## The default: Doppler (managed)

The recommended manager is [Doppler](https://doppler.com) — managed SaaS,
free tier to start.

This is a deliberate reversal, and you should adopt it with the tradeoff in
view. This framework's reference instance first ran a **self-hosted**
secrets server (Infisical on its home server: compose stack, reverse proxy,
nightly encrypted backups, restore tests). It worked — and after twelve
days of living with it, it was retired. A secrets server you own is
key-management toil of its own (upgrades, backups, uptime, TLS), and a
LAN/tailnet-only instance can never serve the places deploys actually
happen (Vercel, CI). The whole point of the layer was *less* toil.

The cost: a third party holds your keys, and a compromised Doppler account
exposes all of them. In exchange: zero server ops, scoped service tokens,
native deploy-time sync (Vercel marketplace integration, a GitHub Actions
fetch action). Strong auth on the Doppler account is therefore part of this
layer, not an afterthought. If your threat model can't accept a SaaS
holding secrets, self-host something that satisfies the contract above —
the self-hosted Infisical stack this replaced is in git history if you want
a starting point.

## Layout

One project per trust domain, configs `dev` and `prd`:

| Project | Holds | Read by |
|---------|-------|---------|
| `humanwareos-core` | Shared infra: model API keys, DNS tokens, PATs | The app/runtime |
| `humanwareos-agents` | Shared agent-facing services (single-app era) | The app/runtime |
| `humanwareos-liv`, `humanwareos-max` | Per-agent credentials (per-agent Slack/Notion) | That agent only |

If your Doppler workplace is shared with other projects, prefix these
(`<you>os-core`, …) — set the prefix at the top of the scripts here.

Key naming: `SCREAMING_SNAKE`, prefixed by service (`SLACK_BOT_TOKEN`,
`NOTION_TOKEN`). The secret name always matches what the code reads.

## How each surface gets secrets

- **Local dev:** `doppler run -- <cmd>` under a personal `doppler login`.
- **Daemons (launchd):** a hydration wrapper reads the per-project
  read-only service tokens from `~/.config/humanwareos/doppler.env`, exports
  the secrets, and execs the service.
- **Agents:** each agent's runtime resolves keys with that agent's own
  token. Cross-agent reads must fail.
- **Cloud deploys / CI:** Doppler's native integrations (Vercel sync,
  `DopplerHQ/secrets-fetch-action`), one config per environment.

## Tooling in this directory

- `setup-doppler.sh` — idempotent: creates the projects and issues one
  read-only `prd` service token per consumer into
  `~/.config/humanwareos/doppler.env` (mode 600). Needs `doppler login`.
- `verify-agents.sh` — the isolation smoke test: each token must read its
  own project and fail to read the others; optional per-agent Slack/Notion
  liveness checks. Run it after any token or project change. It must
  always pass.

## Governance

- Humans write and rotate; runtime tokens are read-only.
- A secret printed or committed by accident = stop, rotate, scrub, then
  continue.
- Agents reference keys by name only — this rule is enforced by
  `AGENTS.md` and applies to every model, cloud or local.
