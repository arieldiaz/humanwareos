# OpenClaw instance patches

These are narrow, version-scoped compatibility patches for the globally
installed OpenClaw runtime. They exist only until the corresponding upstream
fix ships in a stable release.

Instance-owned declarative configuration lives one level up:

- `agents.patch.json5` — agent identities, defaults, and model selection.
- `models.patch.json5` — model aliases and default fallbacks.
- `runtime.patch.json5` — local media preprocessing and ACP harness policy.

## 2026.7.1 Slack current-conversation ACP binding

`patch-2026.7.1-slack-current-conversation-binding.mjs` enables the generic OpenClaw current-conversation binding service for the external Slack plugin. Slack already provides an exact thread conversation id and thread-aware reply routing, but `@openclaw/slack` 2026.7.1 omits `supportsCurrentConversationBinding`; `/acp spawn cursor --bind here` and equivalent agent-driven ACP profile switches therefore fail before the binding service runs. The patch also gives typed Slack ACP bindings one narrow account-default form: `match.peer.id="*"` materializes the owning agent's configured ACP runtime for each concrete Slack thread or conversation. Exact configured bindings retain higher precedence, while an explicit `channels.modelByChannel.slack` entry retains the native privacy route. Finally, an explicit mention containing no letters or numbers becomes a deterministic nudge to resume the thread's outstanding request instead of an empty zero-reply dispatch. This makes execution-profile routing and thread wake behavior truthful without collapsing every thread into one harness session or bypassing local-only channel policy. The patch is idempotent and fails closed when the plugin version or bundle shape changes.

## 2026.7.1 thinking provenance on model hooks

`patch-2026.7.1-model-call-thinking.mjs` makes the run's resolved thinking
level reach plugin hooks, so a provenance consumer (the run-strip adapter)
can lay a thinking tile it can prove instead of logging `thinking_unknown`
on every reply. Two halves:

- embedded runtime: `model_call_started`/`model_call_ended` events carry
  `thinkLevel` (event base + the streamFn wrapper that feeds it);
- CLI harnesses (claude-cli, codex app-server): the shared
  `buildAgentHookContext` whitelist plus both harness hook-context builders
  pass `thinkLevel` through, so `llm_input`/`llm_output` ctx carries it.
  The value was already in scope at both sites — cli-runner sends it to the
  CLI as `thinking:`, run-attempt derives the codex `effort` from it — it
  just never reached the hook layer.

When the run has no resolved level the field stays absent and consumers keep
their fail-closed behavior. Chunk names can exist twice in dist (real bundle
plus a re-export shim), so targets are selected by content, not name. Same
rules: idempotent, fails closed, restart the gateway after applying.

## 2026.7.1-2 recovered exec warnings

`patch-2026.7.1-2-exec-warning.mjs` ports the upstream warning policy that
treats a successful user-facing reply as recovery proof for shell/exec
failures. It does not suppress failed message sends, writes, deletes, or a
terminal exec failure with no user-facing reply.

Run it after installing or updating OpenClaw 2026.7.1-2 and before restarting
the gateway. The script is idempotent and fails closed if the expected bundle
shape is absent.

## 2026.7.1-2 message_tool_only fallback

`patch-2026.7.1-2-message-tool-only-fallback.mjs` stops the gateway from
silently discarding a turn's final text in `message_tool_only` delivery mode
when the agent never delivered via the message tool. Upstream forces that mode
for restart-recovered sessions (and some session-stable resolutions), has a
no-visible-reply fallback wired only for the Feishu channel, and explicitly
disables it for `message_tool_only` — so on Slack the reply is dropped with a
single WARN (2026-07-24: Liv's #marriage reply existed in her transcript,
never posted; see `memory/lessons/delivered-means-tool-confirmed.md`).

The patched drop branch delivers the final reply IFF: mode is
`message_tool_only`, send policy allows, no message-tool delivery was
observed this turn (`observedReplyDelivery`, set by the agent runner on a
committed message-tool send — so healthy tool-using turns never double-post),
the turn is a real user turn (not heartbeat/cron-event/exec-event/room_event),
and the text is non-empty. Same run/apply rules as above: idempotent, fails
closed, restart the gateway after applying. Upstream report:
`upstream-report-message-tool-only-drop.md`.

## 2026.7.1-2 observed delivery in all modes

`patch-2026.7.1-2-observed-delivery-all-modes.mjs` makes the agent runner
report a committed message-tool send to the dispatch layer
(`onObservedReplyDelivery`) in every delivery mode, not only
`message_tool_only`. Without it, a healthy automatic-mode turn that replies
via the message tool and ends with empty final text (the mandated behavior
in this instance) registers as "no visible dispatch" — the gateway logs the
zero-payload WARN and the heartbeat raises a false dropped-reply alert
(2026-07-25: three false alerts for Max #heirlooming turns whose replies had
all landed). The delivery-evidence flag it forwards is already computed
mode-independently; the patch removes only the mode gate on the
notification. Same rules: idempotent, fails closed, restart after applying.

## 2026.7.1-2 ACP bound source delivery

`patch-2026.7.1-2-acp-bound-source-delivery.mjs` restores visible replies for configured ACP channel bindings when the source conversation resolves to `message_tool_only`. External ACP harnesses do not receive OpenClaw's core `message` tool, so stock 2026.7.1-2 records the completed assistant text in the ACP transcript, suppresses its projected output, and dispatches zero Slack reply payloads. The user sees typing and then nothing.

The patch changes only real user requests whose ACP session is already bound to the source conversation. Static `bindings` entries are recognized from their canonical `agent:<id>:acp:binding:<channel>:<account>:...` session key; the runtime conversation-binding table can legitimately be empty for those routes. Dynamic conversation bindings remain supported through the table lookup. Those turns use automatic ACP projection; other ACP sessions keep their existing source-delivery policy. The script is idempotent, upgrades its first database-only patch shape, fails closed when the installed bundle shape changes, and requires a gateway restart after application.

## 2026.7.1 prompt boilerplate override

`patch-2026.7.1-prompt-boilerplate.mjs` rewrites the two per-turn prompt
injections that contradict the instance's layer-2 specs and win by proximity:

- the Slack plugin's `response_format` block, which instructed Slack mrkdwn
  (`*single asterisks*`, "no markdown headings") while this instance writes
  standard Markdown rendered by the rich-text patch — it now states the house
  render chain, so `docs/slack-style.md` no longer has to spend words
  overriding it every turn;
- the core group-chat context in `buildGroupChatContext`: "mostly lurk / add
  clear value" (replaced — unprompted speech is governed by the instance's
  channel registry, and an explicit mention always gets a response, twice as
  "Be extremely selective"), and "not document-style spacing" (replaced —
  reply structure is owned by `docs/reply-shape.md`).

Plugin hooks were evaluated first and cannot do this: `before_prompt_build`
can append or blindly replace the whole system prompt but never sees the
assembled text, so surgical removal is impossible (verified 2026-08-07 on
2026.7.1-1). Same rules: idempotent, fails closed, restart after applying.

## 2026.7.1 Slack rich_text rendering

`patch-2026.7.1-slack-rich-text.mjs` gives Slack replies real Block Kit
structure instead of flattened mrkdwn text. Slack's `text` field has no list
primitive, so upstream renders markdown lists as literal `• ` lines: wrapped
lines snap back to column 0 (no hanging indent) and nested items get two
leading spaces instead of a real depth level. Hanging indents, true ordered
lists, quote and code primitives, and heading blocks exist only in
`rich_text`/`header` blocks on the `blocks` field.

The converter lives in `slack-rich-text/markdown-to-rich-text.mjs` (unit tests
alongside it: `cd slack-rich-text && node --test`). It is copied into the Slack
plugin dist as `openclaw-instance-rich-text.js` and wired into the two visible
text paths:

- `readSlackReplyBlocks` in `replies-*.js` — agent reply payloads. Explicit
  caller-supplied blocks always win; auto blocks only fill the gap.
- the chunk post in `send-*.js` — the message tool, which is how every visible
  reply in this instance is actually delivered.

Both keep the mrkdwn string as Slack's notification/fallback `text`. The
converter returns `null` — leaving upstream behavior untouched — for plain
prose with no list/heading/quote/code structure, multi-chunk or media sends,
input over 10k characters, and anything over 45 blocks.

Mapping notes worth remembering: Slack has exactly ONE heading size
(`header`), so markdown `#`/`##` become `header` blocks (which carry their own
vertical padding, i.e. the section spacing) and `###`+ become bold rich_text
lines. `rich_text` text is raw, not mrkdwn, so HTML entities are unescaped and
`:emoji:` shortcodes must be emitted as `emoji` elements; user/channel
mentions become `user`/`channel` elements.

Same rules: idempotent, fails closed, restart the gateway after applying.
