# OpenClaw instance patches

Runtime activation must run `scripts/apply-openclaw-patches.sh` after stopping the gateway and before starting it again. The runner accepts only OpenClaw 2026.9.8, applies every production `patch-2026.9.8-*.mjs` file in stable order, and stops on the first failure. Changing a patch file without running the runner leaves the installed OpenClaw bundles stale even when the immutable Humanware runtime revision advances.

These are narrow, version-scoped patches for the globally installed OpenClaw runtime and its Slack plugin. Each is idempotent, fails closed when an anchor or version does not match, and requires a gateway restart. Each exists only until upstream fixes the behavior; on every upgrade, re-check each patch against stock and delete what upstream fixed.

Instance-owned declarative configuration lives one level up:

- `agents.patch.json5` — agent identities, defaults, and model selection.
- `models.patch.json5` — model aliases and default fallbacks.
- `runtime.patch.json5` — local media preprocessing and ACP harness policy.

## Upgrade and activation

Patches are applied by `scripts/openclaw-cutover.sh activate`, after the staged package is installed and before the gateway starts. Changing the pinned OpenClaw version means staging that version, re-checking every patch anchor against its stock text, and deleting what upstream fixed. There is no manual recipe; Doctor is not part of activation.

`slack-plugin-root.mjs` selects the single installed 2026.9.8 Slack plugin generation and fails closed if discovery is ambiguous; set `OPENCLAW_SLACK_PLUGIN_ROOT` to choose one explicitly.

## Core reliability

`patch-2026.9.8-cli-commentary-projection.mjs` keeps CLI pre-tool narration out of the final channel reply when the surface has no live-commentary listener. Stock classifies text before a tool call as commentary only when a listener exists; on Slack it therefore concatenates commentary and the terminal answer, including malformed boundaries such as `context.## TLDR`. The patch makes classification independent of observation: a listener receives commentary when present, otherwise it is discarded.

`patch-2026.9.8-prompt-annotation-race.mjs` allows the native prompt mirror to preserve compatible `__openclaw` metadata added after the user admission was recorded. It still rejects content changes, non-metadata changes, terminal evidence, and conflicting provenance.

`patch-2026.9.8-slack-response-reliability.mjs` makes a terminal event from the session's current writer authoritative when restart bookkeeping still names an older recovery run, preventing a successful Slack turn from remaining falsely `running`. Session-start conflicts remain retryable until the ordinary age floor rather than being dead-lettered after eight quick attempts, and persisted or inspected ingress payloads redact credential-shaped fields.

`patch-2026.9.8-current-thread-root-edit.mjs` lets a delegated Slack agent edit the root message of its current thread when the caller omitted the canonical target. It infers only the trusted current channel when the requested message ID exactly matches the trusted thread root and the provider and account match; the stock conversation gate and Slack message ownership check still run afterward.

`patch-2026.9.8-slack-session-status-keepalive.mjs` refreshes Slack's working status throughout a long turn instead of setting it only once and letting it expire. The ordinary typing-reaction fallback remains single-shot.

`../slack-spin-out.mjs` posts the brief as one ordinary top-level message through stock send, then owns scaffold cleanup, status and durable session creation with high reasoning set before the initial run; the session replies in that message's thread.

## Prompt boilerplate

`patch-2026.9.8-prompt-boilerplate.mjs` rewrites two per-turn prompt injections that contradict the instance's layer-2 specs and win by proximity:

- the core group-chat context in `buildGroupChatContext`: "mostly lurk … add clear value" becomes an explicit rule (unprompted speech is governed by the operator's channel rules; an explicit mention always gets a response), and "not document-style spacing" is removed because reply structure is owned by `docs/reply-shape.md`;
- the Slack plugin's `response_format` hint, which says Markdown is converted to Slack mrkdwn and requires presentation table blocks, while this instance renders Markdown as rich_text blocks and `docs/slack-style.md` uses fenced text for small tables.

Plugin hooks cannot do this: `before_prompt_build` never sees the assembled text, so surgical removal is impossible.

## Slack rich_text rendering

`patch-2026.9.8-slack-rich-text.mjs` gives Slack replies real Block Kit structure. Stock 2026.9.8 converts Markdown to mrkdwn sections; Slack's `text` field has no list primitive, so wrapped lines lose hanging indents and nested items get no real depth. Hanging indents, true ordered lists, quote and code primitives, and heading blocks exist only in `rich_text`/`header` blocks.

The converter lives in `slack-rich-text/markdown-to-rich-text.mjs` (unit tests alongside it). It is copied into the Slack plugin dist as `openclaw-instance-rich-text.js` and wired into the chunk post in `send-*.mjs`, which both agent replies and the message tool reach. Explicit caller-supplied blocks always win, and text flagged as Slack plain text or mrkdwn is left alone. The mrkdwn string stays as Slack's notification/fallback `text`. The converter returns `null`, leaving stock behavior, for plain prose with no list/heading/quote/code structure, multi-chunk or media sends, input over 10k characters, and anything over 45 blocks. Streaming is off in this instance; if enabled, streamed replies would use stock mrkdwn.

Slack has one heading size (`header`), so `#`/`##` become `header` blocks and `###`+ become bold rich_text lines. `rich_text` text is raw, not mrkdwn, so HTML entities are unescaped, `:emoji:` shortcodes become `emoji` elements, and user/channel mentions become `user`/`channel` elements.
