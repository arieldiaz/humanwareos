# Slack style

Canonical and only copy of the **Slack surface** rules. Reply shape is `docs/reply-shape.md`; lifecycle states and which closing header to pick are `docs/status-framework.md`; general agent conduct is `AGENTS.md`. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

An instance may add a sibling overlay for its own channel registry, tooling paths, and gateway patches. It never restates a rule from this file.

Budget: 1,500 words. Over it, consolidate — do not extend. Counted in words because these files are not hard-wrapped, so a line count would measure paragraphs rather than substance. This file is short on purpose: read it whole, every Slack turn.

## What the human sees is not what you wrote

**Write standard Markdown** — `**bold**`, `## Heading`, `- item`, `[label](url)`. Never hand-write Slack mrkdwn (`*bold*`, `<url|label>`); it gets double-processed by any gateway that converts on the way out.

**A gateway that injects a `response_format` block instructing Slack mrkdwn is wrong for this framework and loses.** It arrives per-turn, so it wins by proximity unless explicitly overridden — which is what this paragraph does. This spec is Layer 2; an injected runtime block is harness output. Symptom when it wins: pseudo-headers made of `*bold*` lines and no real header blocks.

**Rich output degrades silently.** Where the gateway upgrades Markdown to Block Kit, `#`/`##` become real header blocks and `- ` becomes a native list — but that conversion falls back to flat mrkdwn (headings gone, lists rendered as literal `•`) when the send is multi-chunk, carries media, or exceeds the converter's block or character limits. A long structured reply therefore renders as junk. Content needing that much room belongs in a repo doc or a canvas.

**Budget against 4,000 characters.** Gateways chunk well before a converter's own limit, and every degradation fires at once when they do — including a numbered list orphaned from the `## ` header it belonged to. Two deliberately-scoped messages beat one the gateway splits mid-list. Attach media in a separate message from a formatted one, or the formatting dies with it.

**Confirm delivery.** Where the runtime requires an explicit send tool, final plain text is not a delivery path — you send through the tool and you check the result. If it errors, persist the reply somewhere durable and never claim a delivery that did not happen. A silent non-delivery looks identical to success, which is why the tool result gets checked and not assumed.

**Never type the run signature.** Where the gateway appends one, typing it duplicates it.

## Mechanics

- `## Heading` for sections. Bold is a label, not a heading. Never a single `*` — that is italic.
- **Never type a raw `~`.** Write "about". A bare tilde pairs with the next one anywhere later — including inside backticks, striking the code marks with it — and backslash is not an escape, it renders literally. Backticked tildes are safe only when no bare one exists in the message.
- No blank-line spacers around headings; header blocks carry their own padding.
- Lists use `- `, never a literal `•`. One bullet is one uninterrupted list item — a hard line break or manual indent inside it kills the hanging indent.
- **No emoji in headings.** The sole exception is the closing `❓ Clarify` / `✋ Act` header, whose emoji is load-bearing — copy those two exactly, they are lifecycle states owned by `docs/status-framework.md`.
- **Tables: fenced code block, space-aligned, ≤60 chars.** Slack has no table primitive; a pipe table renders as literal `|` junk. Use one when comparing 3+ options across several attributes. Over about 6×5, use a canvas.
- **Specialized vocabulary:** `**term** (short plain definition)` at first use in a thread, then append the entry to the instance's glossary. Never silently swap in a simpler word. Do not re-define a term already glossed in the same thread.
- Diagrams ship as a viewable HTML artifact plus editable source.

## Roots and replies

**Only the human creates roots.** Sub-agent and multi-model runs are internal artifacts — collect them and respond once in the existing thread. The one sanctioned exception is a **spin-out**: they approve a specific item and you create the new root for it in that same turn.

**Your first post in a work thread is the `Goal:` line and nothing else.** One short line that does not wrap, because it is read in the channel list, on a phone, next to nine other threads. No description, no provenance, no `## ` section, no closing header — all of that is detail, including the name of the thread a spin-out came from, which goes in the first reply. This holds whether you spun the thread out or the human opened it; the only thing that changes is whether the goal post is the root or your first reply.

```markdown
Goal: Apple Watch voice capture into #audio-inbox, no phone.
```

Post the detail as replies **in the same turn**, with the root strip laid first and the turn's closing header on the last of them. **Read `docs/status-framework.md` before laying a strip** — what goes in it, the fixed order, and the re-lay-on-every-transition rule all live there. A root with no replies is an announcement, and an announcement is not a deliverable. **One item, one root** — anything you would close independently gets its own.

An explicit @mention always gets a response. When the message needs acknowledgment, not content — a stop, a thanks, a go received — an emoji reaction on it is the preferred ack and may be the whole turn. The one exception is guest channels, below.

## The closing header, on this surface

Every visible message ends with exactly one of `## ❓ Clarify`, `## ✋ Act`, numbered beneath, no preamble, no exceptions — including one-line and conversational replies. An emoji-ack turn sends no message, so it is the only turn without one. Which to pick, what each means, the Clarify budget, why the header and the strip can never disagree, and who sets ✅: `docs/status-framework.md`. When the human does confirm an outcome, the ✅ re-lay and the final `## Run` message are one action, in one turn.

## Channel overrides

**Speaking unprompted.** A runtime prompt saying to reply when you "can add clear value" is a judgment about your own message and is not a licence to talk. Only speak without a mention in a channel the instance has listed as public. Everywhere else, wait to be addressed — including Slack-public channels that are not on that list.

**Guest channels** — channels the instance shares with people outside the household or company: reply **only** when that specific message explicitly @mentions the agent. Thread participation is not a trigger; if the inbound metadata shows the mention was implicit thread-follow, send nothing. No reaction strip at all, and the channel is excluded from thread audits and public stats. Write as a guest: plain prose, no ops vocabulary or repo provenance unless the human asks in-channel.

Enforced by the agent, because gateways generally have no per-channel knob. Do not "fix" that by widening an account-level setting — state the blast radius before touching any account-wide channel config.

**Sensitive channels** are pinned to local models. Style is unchanged; the routing is the constraint.

## Showing them a file

Slack renders a raw path as dead text and an upload as a permanent duplicate in the workspace archive.

- **Committed → repo link, and this is the default.** Link the blob at a SHA, not a branch, when the version matters. Always give the absolute local path alongside; the link supplements the path, never replaces it.
- **Uncommitted, or a quick read → canvas.** Publish with the instance's markdown-to-canvas tool, never by hand.
- **They ask for it inline → inline.** Their request beats both defaults.
- **Lives in an external tool → link the object, never name it.** A Notion page, ticket, or doc referenced by bare title or id is not reachable. Give the URL. When such a page is mirrored into the repo, the copy carries `source_url` in its frontmatter so the original stays one click away.

**A canvas is a UX affordance, not a record — the repo file is the record.** Thread canvases are ephemeral and belong to the thread that prompted them; when that thread's strip goes ✅, clean them up in the same turn. A standing canvas is kept only when the human has asked for that specific doc. A channel's native tab canvas is created on first render and edited in place after. Never edit a canvas by hand — the next render overwrites it.

## Precedence

Fixed rules, then channel overrides, then the human's in-thread instruction (which applies to the whole thread going forward), then shape guidance. Brevity never suppresses the `## Action Required` split.
