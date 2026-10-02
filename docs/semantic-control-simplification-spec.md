# Semantic control simplification

Draft implementation spec. Budget: 1,500 words. Implement only after the current lifecycle, delivery-recovery, media, and profile-switch work has resolved; then rebase this proposal on the resulting `main` and remove anything already made obsolete.

## Problem

Humanware OS correctly separates semantic judgment from deterministic mechanics in principle, but several control paths do the opposite in code. Slack closure accepts a short regex grammar and deliberately rejects ordinary wording such as “please close this.” Email promotion and closure require literal command forms. A mention-content heuristic rewrites punctuation-only input into canned prose. Execution profiles declare stable profile IDs and aliases, but the live session control accepts a provider model ID rather than a profile, does not resolve the declared aliases, and cannot apply the profile's reasoning level atomically.

These are one ownership defect: free-form human language is being interpreted by transport and service code, while the model is forced to guess low-level identifiers. Safety checks then become phrase checks, and every failed phrase invites another exception and another test.

The current Max/Astra incident demonstrates the mismatch. Max was allowed to use `codex-astra-high`, but the live tool accepted only a model override. It normalized `astra` to the nonexistent `openai/astra`, never tried the allowed `openai/gpt-6-astra`, could not set high reasoning, and incorrectly reported an allowlist failure. The catalog was correct; the control surface did not expose the catalog's unit of selection.

No identity or skill owns this behavior. It was introduced in framework specifications and implementations. The exact Slack closure path came from the host-closure redesign in [PR #124](https://github.com/arieldiaz/humanwareos/pull/124); the email grammars came from [PR #104](https://github.com/arieldiaz/humanwareos/pull/104). [PR #55](https://github.com/arieldiaz/humanwareos/pull/55) correctly identifies profile switching as a control-plane responsibility, but its proposed shared natural-language parser would preserve the same category error and is superseded by this spec.

## Decision

Human language has one semantic interpreter: the admitted model. Channel adapters authenticate and normalize transport structure. Domain services validate typed operations. Neither layer infers intent from words, phrases, prefixes, punctuation, regexes, or keyword lists.

This is not a request for a universal intent service or another schema shared by every feature. Use the existing narrow typed boundary natural to each behavior:

- lifecycle intent is the final-envelope status;
- execution routing is a profile-selection operation;
- email intake uses its promotion and closure operations;
- generated media uses the artifact service.

The host remains authoritative for actor, provenance, scope, state transitions, permissions, destination validity, idempotency, persistence, delivery, and recovery. Semantic interpretation does not weaken those checks; it removes text matching from them.

## Required simplification

### Conversation closure

Restore `closed` as a model-selected final-envelope status. The model decides whether the current human message explicitly closes the whole conversation. The host accepts that status only from the current admitted human turn in the canonical conversation, then performs the existing durable transition, stale-work fence, completion event, artifact generation, and projection.

Delete the raw Slack pre-admission closure interception, `isCloseCommand`, bot-mention stripping for closure, the canned instruction to reply with `close this`, and the separate host-close decision path. Reuse the ordinary final reservation, delivery, and recovery machinery instead of retaining a second lifecycle transaction.

Quoted text, forwarded messages, bot output, stale turns, and unauthenticated actors remain unable to authorize closure because they are not the current admitted human authority. The host does not inspect their wording.

### Execution-profile switching

Expose one typed operation that selects a canonical profile ID for a canonical conversation. The model receives the identity's allowed profile catalog, interprets requests such as “switch Max to Astra high,” and calls the operation with `codex-astra-high`. The control plane validates the profile against instance policy and applies its complete tuple—runtime, harness, model, reasoning, fast mode, permissions, workspace, data scope, tools, and delivery—as one transition.

If the harness changes, the transition creates one structured handoff from canonical conversation state. If validation or startup fails, the prior profile remains effective and the requested work does not silently continue under the wrong profile. The delivered response signature verifies the first content response used the requested tuple.

Retire agent-facing model-only mutation once profile selection is live. Remove alias guessing, provider-ID guessing, and the version-locked session-thinking patch. Administrative model overrides may remain as diagnostics, but they are not the conversational product interface.

### Email intake

Remove Slack text from the domain authorization decision. The admitted agent invokes typed promotion with destination and coding-session choice, or typed intake closure. The service validates the authenticated actor, persisted intake thread, resolvable destination, current state, and operation identity. Email content, quoted material, attachments, and caller-supplied identity remain unable to invoke trusted ports.

Delete the promotion regex, the literal `close intake` comparison, and the accepted-command-form documentation. Missing or ambiguous semantic information produces one ordinary clarification from the model, not a parser-specific error branch.

### Mentions and delivery

Delete the letters-and-numbers mention heuristic and its canned replacement prompt. Pass the canonical mention event and conversation context to the admitted model. If the upstream transport cannot represent an empty mention, normalize it structurally as a nudge event without examining punctuation or manufacturing human prose.

Retain the current text-first response contract: generated media is promoted through the artifact service and linked from the response. Media failure never suppresses useful text. Do not reintroduce attachment-dependent final delivery while simplifying adjacent paths.

## Deletion and tests

Implementation is expected to be materially net-negative. Delete the 249-line `host-close.test.mjs` suite with the host-only subsystem. Delete phrase acceptance/rejection matrices, email tests whose purpose is rejecting natural variants, raw pre-admission interception tests, root magic-phrase tests, duplicate close-report measurement tests, and exhaustive recovery matrices for state machinery that no longer exists. Delete mention-character tests and version-specific thinking-patch tests with their implementations.

Keep only tests for durable invariants:

1. an authenticated current human turn can produce a typed close, while stale, forged, or wrong-conversation input cannot;
2. closure remains idempotent across one representative interrupted-delivery recovery and fences stale work until a new human turn reopens the conversation;
3. profile selection applies one allowed profile atomically, preserves the prior profile on failure, and proves the effective tuple before content dispatch;
4. email promotion validates actor, thread, destination, and replay identity without receiving prose;
5. failed artifact promotion still delivers the text response.

Do not add a phrase corpus, parser unit tests, an intent-classifier service, a keyword lint rule, compatibility aliases for rejected magic phrases, or a second state store. Behavioral acceptance uses ordinary language through the real channel, but wording examples are not permanent grammar fixtures.

## Sequence and acceptance

After the in-flight branches land or close, inventory the resulting source before editing. Apply this decision by consolidating the owning specifications in place, then remove the obsolete code and tests in the same implementation PR. Do not stack a compatibility layer on the current parser.

The release is accepted when:

- an ordinary phrase such as “great, close this thread” closes the conversation without a magic command;
- “switch Max to Astra high” selects `codex-astra-high`, and the first continued content response proves Astra with high reasoning;
- naturally worded email-intake promotion and closure reach typed operations while quoted or unauthenticated material cannot;
- a failed media artifact does not block the useful response;
- authored runtime code contains no human-intent authorization based on raw-message phrase equality, regex grammar, prefix matching, or keyword lists;
- the implementation reports production, test, and specification lines removed and added, deleted files, and any new permanent surface; the expected result is fewer code paths, fewer tests, and no new parser.

One supervised cutover verifies Liv and Max symmetrically. Rollback returns to the prior immutable runtime; a failed acceptance records the specific boundary failure for the follow-up rather than expanding a phrase list.
