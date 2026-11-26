# Credential posture service

The credential posture service reconciles billable API credentials, their declared consumers, and their provider-side spending controls without making secret values part of the data plane.

Budget: 900 words.

## Ownership

HumanwareOS owns the collector, register schema, provider adapters, findings, generated feed, tests, and Security Dashboard component. The private instance selects Doppler projects and configs, maps runtime checks to secret references, and installs the schedule. Secret values remain in the instance secret manager.

The data plane owns two different records:

- `$HUMANWARE_DATA_ROOT/working/security/api-credential-audit/register.json` is the mutable human-owned declaration of credential purpose, environment, owner, and confirmed spending control.
- `$HUMANWARE_DATA_ROOT/generated/reports/security/credentials-current.json` is a rebuildable observation produced by the collector.

The dashboard is a projection over the generated observation. It never becomes an authority for credentials or budgets.

## Register contract

The register contains metadata only. Every entry has a stable `id`, `provider`, Doppler locator, consumer, environment, owner, status, and budget declaration. Status is `active`, `rotating`, `disabled`, `retired`, or `unknown`; initial discovery uses `unknown` until the workload is confirmed. The locator consists of project, config, and secret name. It is an identifier, not a value.

A budget declaration records:

- `kind`: `hard_cap`, `prepaid`, `alert_only`, `none`, or `unknown`;
- optional USD amount and provider scope;
- prepaid auto-recharge state and its finite monthly maximum, when applicable;
- `confirmedAt`, the date a human or provider API verified the control;
- `source`, such as `provider-console` or `provider-api`.

Historical review evidence is append-only evidence, not accumulated in the live register.

## Collection

Each run performs three bounded reads:

1. Doppler is queried with `--only-names`; secret values are never requested.
2. The register is loaded from the data plane.
3. Configured provider checks use credentials injected into the process environment by the instance secret executor. Checks use non-billable metadata endpoints and never print request headers, URLs containing credentials, or response bodies on error.

Optional `claudeChecks` run an absolute CLI command with `auth status --json` and a 20-second timeout. Only login state and normalized expiry enter the feed; account details and raw command output are discarded. Missing or malformed status is unavailable, not healthy. A seven-day warning precedes login expiry. Local status is not proof of remote model acceptance, and a login with unknown expiry remains attention. No credential store is read, changed, or repaired by the collector.

A `claude-oauth-token` check probes a `claude setup-token` subscription token on the same Anthropic models route with an OAuth bearer. The provider reports no token expiry, so a check may declare `expiresAt`; it becomes `expiring` within `warnDays` (default 30) even while the remote check passes.

The first adapters cover OpenAI, Anthropic, OpenRouter, Gemini, and xAI. OpenRouter exposes key-level usage and limits through its ordinary key endpoint. Other providers require management credentials or a console review for complete budget confirmation; a successful API health check must not be presented as budget verification.

The output is written atomically and contains source freshness, a normalized credential list, provider observations, summary counts, and deterministic findings.

## Findings

High severity:

- a discovered billable-provider secret is absent from the register;
- a registered active credential is absent from Doppler;
- an active credential has no finite hard cap, or uses prepaid credit with unlimited or unconfirmed auto-recharge;
- provider authentication fails;
- an observed provider limit conflicts with the register.

Medium severity:

- a credential has no named consumer or owner;
- provider verification is not configured;
- a budget confirmation is older than 31 days;
- a connector or Doppler scope is unavailable.

The service does not rotate, revoke, create, or test-bill credentials. Those are separate authorized operations.

## Dashboard contract

The existing private `/security/` surface adds one Credentials view. It leads with current, stale, or unavailable state, then shows posture totals, findings, and the normalized inventory. Secret values and unbounded provider response text are forbidden.

The credential feed becomes stale after 26 hours by default. Stale data remains visible with its timestamp because an old audit is useful evidence, but it cannot render as healthy.

## Schedule and failure behavior

The instance should run the collector at least daily and after a key is created, rotated, or revoked. A failed provider must not suppress successful provider or Doppler observations. A total collection failure preserves the previous atomic output and exits nonzero.

No finding automatically changes provider state. The dashboard supports review; explicit human authority remains required for revocation, billing changes, or production cutover.

Optional `authNotifications` sends authentication failures, unavailable checks, impending expiry, and recovery directly to Slack using an injected bot token, without a model call. The instance owns the destination and schedule. Successful delivery records a metadata-only signature under `operations/credential-posture`; unchanged failures repeat at most daily, and failed delivery exits nonzero without advancing dedupe. The atomic posture snapshot is preserved if notification fails. A collector crash before snapshot creation is a supervisor failure, not a successful auth check. `--stdout` is observation-only and never sends alerts.
