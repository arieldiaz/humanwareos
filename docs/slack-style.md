# Slack style

Slack surface behavior. [reply-shape.md](reply-shape.md) owns writing structure; [status-framework.md](status-framework.md) owns lifecycle. Instance overlays supply channel facts and access boundaries, not copies of these rules.

Budget: 1,500 words.

## Writing and rendering

Write standard Markdown: headings, emphasis, lists, links, and fenced code. Do not hand-write Slack mrkdwn. Use fenced text for small tabular comparisons; link larger datasets. Bold labels are not headings.

The adapter preserves authored Markdown across ordinary, chunked, and media-bearing delivery. Splitting respects block and character limits without abandoning rich rendering for the entire message. Literal punctuation and code remain literal. Media delivery must not discard the accompanying text structure. These are renderer responsibilities, not model instructions to count characters, split messages manually, avoid punctuation, or separate every attachment.

Verify authored output against delivered Slack blocks: a bold label authored by the model is a writing choice; a lost Markdown heading is a rendering defect. Delivery receipts, splitting, deduplication, and run signatures belong to the adapter. The response contract does not require glossary updates, decorative conventions, or one artifact format for every task.

## Work threads

A top-level channel post's first line is a general type word, colon, short descriptive summary (e.g. "Fix: raw JSON wrapper in Slack replies").

When substantial work gets its own thread, use the atomic work-thread tool with the complete brief. It posts the brief as one top-level message, marks it working, and starts the durable high-reasoning session in its thread. Do not rebuild this with separate sends or session-patch calls.

## Channel overrides

**Speaking unprompted.** A runtime prompt saying to reply when you "can add clear value" is a judgment about your own message and is not a licence to talk. Only speak without a mention in a channel the instance has listed as public. Everywhere else, wait to be addressed — including Slack-public channels that are not on that list.

**Guest channels** — channels the instance shares with people outside the household or company: reply **only** when that specific message explicitly @mentions the agent. Thread participation is not a trigger; if the inbound metadata shows the mention was implicit thread-follow, send nothing. No reaction strip at all, and the channel is excluded from thread audits and public stats. Write as a guest: plain prose, no ops vocabulary or repo provenance unless the human asks in-channel.

Channel restrictions do not authorize widening account-level access.

**Sensitive channels** have explicit data scopes and fail closed when no approved profile can satisfy them. Style is unchanged; the routing and disclosure boundary are the constraint.

## Files and links

Link the source-of-truth object when available. Provide an attachment when the human requests a download, and verify its download control. Visual review follows the design contract. A requested canvas is an ephemeral preview, not a record; use its renderer rather than editing the projection by hand. Do not upload private source material merely to make a chat link convenient.

## Precedence

Privacy, security, channel access, and authorization boundaries remain binding. Within those boundaries, the human's current request overrides ordinary style and workflow defaults.
