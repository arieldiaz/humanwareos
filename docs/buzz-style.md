# Buzz style

Canonical and only copy of the **Buzz surface** rules. Reply shape is `docs/reply-shape.md`; lifecycle states and which closing header to pick are `docs/status-framework.md`; general agent conduct is `AGENTS.md`. Layer 2 spec — see `docs/agent-context-hierarchy.md`. An instance adds a sibling overlay for its relay, identities, channel registry, and tile URLs; it never restates a rule from this file.

Budget: 700 words. Over it, consolidate — do not extend.

## What the human sees

**Write standard GitHub-flavored Markdown and nothing else.** Buzz renders it natively: real headings, hanging-indent lists, pipe tables, fenced code with syntax highlighting. Every Slack mechanic built around mrkdwn conversion — hand-written `*bold*`, the no-pipe-tables rule, the 4,000-character chunk budget, blank-line rules around headings — does not exist here and must not be ported by reflex.

**Delivery is the harness's job.** The final assistant message of a turn is published automatically. The message CLI is for side effects only — an extra top-level post, a broadcast the human explicitly asked for — never a duplicate of the ordinary reply.

**Mentions use the exact full display name** after `@`. Partial names fail silently, and formatting wrapped around a mention (bold, backticks) breaks its notification.

## Reactions and the run strip

The strip's content, order, and lifecycle semantics are owned by `docs/status-framework.md` and are unchanged on this surface. What Buzz changes is the mechanics:

- **Buzz orders reactions by first-added time** (verified 2026-08-10), so the re-lay-on-every-transition rule applies exactly as on Slack: the whole strip comes off and goes back on in canonical order.
- **Buzz has no strip adapter yet, so this is the one surface where the agent still lays the strip by hand** — the standing exception to the adapter-only ownership in `docs/status-framework.md`. It ends when the relay gains a send hook.
- **Adding** a custom-emoji reaction takes the bare shortcode plus `--emoji-url`. **Removing** one requires the `:colon:` form; a bare shortcode remove fails silently at the CLI level, which corrupts strip order on the next lay — check remove results.
- **Duplicate adds are rejected cleanly** by the relay, so a blind re-lay is safe and doubles as presence detection.
- Reactions are signed events: the strip is attributable, so the identity laying it must be the agent the strip claims. A strip laid under the wrong key is provenance corruption, not cosmetics.

## Custom emoji

Emoji are **per-member sets whose union is the workspace palette** — one agent registering a tile makes it available to everyone, and there is no workspace-admin upload step or user-session workaround. Pipeline: upload the image to the relay's media store, then register shortcode → URL in the agent's set.

- The relay rejects images carrying ancillary metadata chunks (HTTP 422). Strip to critical chunks (`IHDR`/`PLTE`/`IDAT`/`IEND`/`tRNS`) before upload; keep the canonical art untouched in the external artifact store.
- A shortcode resolves its image at render time, exactly like Slack: tiles are family markers, never version records.

## Canvases

`buzz canvas get`/`set` manages one canvas document per channel, and channel templates can carry one. The canvas-is-a-view, repo-file-is-the-record rule from the general specs carries over; publish through the instance's markdown-to-canvas tooling, never by hand.

## Identity and credentials

Every agent is a first-class Nostr identity: its own keypair, its own auth tag, its own audit trail. Two consequences:

- **A key and its auth tag are one credential.** The relay verifies the tag against the signing pubkey, so a mismatched pair fails every authenticated call — an agent wired with another agent's tag is not degraded, it is mute. When an agent is silent on Buzz, check the key/tag pairing before anything else.
- **Private keys are secrets under the never-write-a-secret rule.** They must not appear in argv (visible in `ps`), logs, or transcripts. Inject via environment from the secret store, reference by name only, rotate on any exposure.

## Threading

The harness supplies the reply destination per turn; use it rather than a remembered thread id. Human-facing threads stay flat; agent-only coordination may nest deeper when it preserves task structure. Roots, goal posts, and spin-out rules are general conversation shape and live in the general specs, not here.
