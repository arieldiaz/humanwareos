# Domain surface

A complete Humanware OS installation has a first-class domain surface with public and private halves. It is an interface to the system, not the source of agent identity, memory, or orchestration.

Budget: 1,000 words. Over it, consolidate.

## Ownership

Humanware OS owns:

- the reusable shell and navigation contract;
- public/private route classes;
- public discovery, canonicalization, and machine-readable representation contracts;
- dashboard and artifact component contracts;
- deployment adapters for local Caddy and cloud origins;
- authentication and network-policy hooks;
- route, health, and publication schemas;
- responsive, accessible frontend primitives.

The private instance owns:

- domain names and DNS zones;
- branding and enabled modules;
- local or cloud origins;
- route visibility and authorization policy;
- instance-specific dashboards and integrations;
- publication decisions and artifact contents.

The data plane owns dashboard samples, usage history, sessions, artifacts, media, reports, and other displayed content. Framework components read typed data or manifests; generated data never becomes frontend source code.

An immutable runtime starts with the framework shell and overlays optional instance files from `surfaces/static/`. This permits private branding or a mature local dashboard without forking the route and security contract. Mutable data files, review artifacts, and media remain in the data plane and are mounted by route; they are never copied into the runtime build.

## Public and private halves

The public half explains the installation or project and serves intentionally published artifacts. It may run independently on static hosting or a cloud edge.

### Public discovery contract

A public surface serves people and research agents from the same editorial source. Humanware OS defines the reusable contract; the instance chooses the identity facts, editorial priorities, and published documents.

Every canonical editorial page provides:

- a stable canonical URL, unique title, plain-language summary, author or publisher identity, and published or updated date when applicable;
- semantic HTML whose primary text remains useful under Readability-style extraction;
- structured data appropriate to the page type and stable identity links such as `sameAs` where the instance publishes them;
- a generated Markdown alternate when the page has one durable editorial source, advertised with `rel="alternate"` and an explicit content type.

The public origin provides a curated `/llms.txt`, a `robots.txt` that declares the sitemap, and a primary sitemap containing canonical public documents with `lastmod` when known. These discovery files are generated from route and publication manifests, not maintained as an independent editorial copy.

Human-facing utility routes such as revision diffs, previews, filters, and galleries are not independent index documents unless the instance explicitly publishes them as such. A subordinate revision route remains navigable, emits `noindex,follow`, canonicalizes to its primary document, and stays out of the primary sitemap. Canonicalization alone is insufficient because crawlers may treat it only as a hint.

Markdown alternates are omitted when no single durable source can generate them without drift. They never replace accessible HTML or create a second editable truth.

The private half exposes operational surfaces such as:

- system status and service health;
- model, harness, token, usage, and cost history;
- session and worktree status;
- security posture and permission grants;
- artifact review and publication;
- curated framework, instance, governance, and current-context documents with agent-handled change proposals;
- capture, stream, and derivation health;
- agent and runtime profile configuration.

Private does not mean merely unlinked. The deployment uses explicit network and identity authorization. A local reference deployment can combine Tailscale routing, source-IP policy, and TLS DNS-01. A cloud deployment implements the same route policy through an identity-aware edge.

## Route manifest

The instance declares routes as data:

```json
{
  "id": "stats",
  "visibility": "private",
  "mount": "/stats",
  "source": "framework:stats",
  "data": "data:generated/stats/current.json",
  "health": "/health/stats"
}
```

The runtime builder renders that manifest into the selected local or cloud server configuration. A new internal page is a route entry and component, not a hand-edited DNS record plus an unrelated server block.

Service control planes and independent public products remain separate hostnames when their trust or branding boundary differs. The instance records that decision explicitly.

## Reference instance

Ariel OS uses `os.arieldiaz.com` as its private Humanware OS frontend. It consolidates stats, usage, tokens, sessions, security, design review, and artifacts beneath one authenticated origin. Legacy `stats.arieldiaz.com` and `design.arieldiaz.com` redirect into it during migration. Product and service-control hostnames remain separate where their trust boundary requires it.

The current Mini/Caddy deployment is one adapter. The same instance route manifest must be renderable for a cloud-hosted private origin later without changing frontend components or data contracts.

## Verification

A surface release proves:

- generated route configuration matches the instance manifest;
- private routes reject an unauthorized network and identity;
- public routes contain no private data references;
- canonical public pages expose their required discovery metadata and machine-readable representations;
- subordinate utility routes carry their index policy, canonical target, and sitemap exclusion;
- extraction tests recover the title, summary, identity, dates, and primary text from representative page types;
- every dashboard distinguishes current data, stale data, and unavailable data;
- artifact revisions and provenance resolve;
- route health works from both the origin and an authorized client;
- local and cloud adapters pass the same contract tests.
