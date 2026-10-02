# OpenClaw instance patches

Runtime activation must run `scripts/apply-openclaw-patches.sh` after stopping the gateway and before starting it again. The runner applies every production `patch-*.mjs` file in stable order and stops on the first failure; changing a patch file without running the runner leaves the installed OpenClaw bundles stale even when the immutable Humanware runtime revision advances.

These are narrow, version-scoped compatibility patches for the globally
installed OpenClaw runtime. They exist only until the corresponding upstream
fix ships in a stable release.

Instance-owned declarative configuration lives one level up:

- `agents.patch.json5` — agent identities, defaults, and model selection.
- `models.patch.json5` — model aliases and default fallbacks.
- `runtime.patch.json5` — local media preprocessing and ACP harness policy.

## 2026.9.1 reliability patches

`patch-2026.9.1-slack-channel-thread.mjs` makes the existing durable sender own short-root + thread-body publication for agent-created Slack channel threads. Cron supplies its job name; the gateway carries existing title metadata and honors explicit top-level targeting. The root uses a distinct Slack reconciliation marker inside the same queue intent. Its receipt atomically advances that row to body custody under the producer claim; recovery reconciles an unknown root and resumes the body instead of acknowledging the intent. Existing body chunking, attachment spooling, partial-failure handling and authority checks remain in place. A gateway send bound to process-local agent runtime authority can be reconciled after restart, but further dispatch waits for an authorized live caller; recovery cannot manufacture that authority. Gateway publication identities survive in the existing bounded completion receipt (one day / 2,000 entries); neither title nor body is retained in the terminal receipt. Existing replies, DMs and system messages keep their original path. `../slack-channel-thread.mjs` is copied by the runtime builder and patch runner; there is no new adapter, setting, formatting mode, journal or publication agent run. The patch validates all eight reviewed bundle shapes before writing, verifies every edit on reapplication, and rejects other runtime versions. Test it only on a copied distribution; application and restart require separate cutover authority.

Focused verification: run the adjacent patch test and `../slack-channel-thread.test.mjs` plus `../slack-spin-out.test.mjs`. Set `HUMANWARE_SLACK_THREAD_REHEARSAL` to a separately copied and patched package root to include execution/recovery fault injection and isolated real-SQLite custody tests; without that fixture those runtime-specific checks are explicitly skipped. No test posts to Slack.

`patch-2026.9.1-cli-commentary-projection.mjs` keeps CLI pre-tool narration out of the final channel reply even when the surface has no live-commentary listener. OpenClaw already recognizes text before a tool call as commentary, but stock 2026.9.1 enables that classification only when a listener exists; on Slack it therefore concatenates the commentary and terminal answer, including malformed boundaries such as `context.## TLDR`. The patch makes classification independent of observation: a listener receives commentary when present, otherwise it is discarded, while tool-free answers and the terminal assistant message are unchanged.

`patch-2026.9.1-prompt-annotation-race.mjs` allows the native Codex prompt mirror to preserve compatible `__openclaw` metadata added after the user admission was recorded. It still rejects content changes, non-metadata changes, terminal evidence, and conflicting provenance. This closes the race that made prompt mirroring fail and then left settled-turn finalization without its captured context.

`patch-2026.9.1-codex-runtime-reliability.mjs` gives Codex process inspection the existing ten-second startup budget instead of silently falling back to two seconds, and uses the same bounded budget while registering a newly spawned app-server process. It reduces false process-inspection and orphan-cleanup failures during transient host load without weakening PID identity checks or allowing unbounded waits. `codex-plugin-root.mjs` selects the exact installed 2026.9.1 plugin generation and fails closed if discovery is ambiguous.


`patch-2026.9.1-manual-cancel-notify.mjs` prevents an agent-requested `process kill` from enqueueing a background-exec failure merely because the cancelled process emitted partial output. The initiating turn already observes the cancellation; converting its expected SIGTERM into a later heartbeat event falsely reopens completed work. Unexpected signals and other failed background exits keep their existing notification behavior. The patch is version-scoped, idempotent, fails closed when the bundle shape changes, and requires a gateway restart after application.

`patch-2026.9.1-conversation-lifecycle-fence.mjs` connects the run-signature plugin's durable `open → closing → closed` Slack conversation fence to OpenClaw's subagent completion and requester-settle paths. Completion retries and settle wakes check the fence before model admission and visible delivery; closed targets settle as `intentional_non_delivery` without a follow-up wake. Existing kill reconciliation remains the owner of `suppressCompletionDelivery` for retired children, and yielded multi-child requesters retain one consolidated settle owner. The patch copies the shared fence reader into the pinned OpenClaw dist, verifies every reviewed lifecycle invariant, is idempotent, and fails closed when the bundle shape changes.

`patch-2026.9.1-slack-response-reliability.mjs` makes a terminal event from the session's current writer authoritative when restart bookkeeping still names an older recovery run, preventing a successful Slack turn from remaining falsely `running`. Session-start conflicts remain retryable until the ordinary age floor rather than being dead-lettered after eight quick attempts, and persisted or inspected ingress payloads redact credential-shaped fields. Run `scripts/repair-openclaw-terminal-sessions.mjs` after stopping the gateway to preview existing rows with durable terminal evidence, then rerun it with `--apply --session-key <EXACT_KEY>` before activation. Apply mode refuses an unscoped mutation, and the repair does not close a row unless that exact session's current lifecycle writer has a latest durable event of `session.ended`.

`../slack-spin-out.mjs` delegates one idempotent title/body publication to the durable sender, then owns scaffold cleanup, status and durable session creation with high reasoning set before the initial run. It no longer contains a second root/reply send sequence.

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

`patch-2026.9.1-final-envelope.mjs` routes CLI and harness finals through the shared act/scheduled contract and attaches Codex’s native output schema. It also intercepts authenticated raw Slack messages before mention gating: configured-owner `close this` commands enter FinalRuntime without a model turn. The installed Slack manifest requests message.channels/message.groups as well as app_mention; the provider registers both message and app_mention handlers. Live subscription/inline-output acceptance remains an activation check, not a claim established by source rehearsal. The run-signature config requires ownerUserId for closure and optionally maps threadOwnership.defaultAccounts by exact channel for unowned threads. Existing persisted senders outrank defaults and mentions. The final-decision journal owns reservations/generations; the old fence file is read-only until B reconciles history. Queue recovery may reconcile final-intent receipts but cannot redispatch without the live journal check. Patch rehearsal uses copied bundles only; activation requires the plugin and all four host-boundary anchors.
