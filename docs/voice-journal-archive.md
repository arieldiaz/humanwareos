# Pattern: Voice-journal archive + rolling summary

**Problem.** A chat surface (Slack, etc.) is a great low-friction capture point
for journaling — especially voice notes — but it is *not* a system of record.
Third-party retention, ephemeral attachment staging, and account/plan changes
all put the raw material at risk. You want capture to stay frictionless while the
data lives in a durable structure you own and control.

**Shape.**

- **Capture surface ≠ system of record.** The chat channel is the front door.
  The external data plane is the home. Never let the archive depend on
  the chat provider's retention.
- **Copy out of ephemeral staging immediately.** OpenClaw stages inbound
  attachments into `media/inbound/openclaw-staged-*` — a per-turn working
  buffer, not durable. The agent copies each entry into the owned store in the
  same turn it arrives, and confirms the durable path back in the thread.
- **Verbatim original + searchable transcript.** Keep the raw audio unmodified;
  add a transcript (local Whisper) as the searchable/greppable layer. Same
  basename, paired files.
- **Month-per-folder layout.** `journal/YYYY-MM/YYYY-MM-DD-<slug>.{m4a,txt}`,
  with `journal/summaries/YYYY-MM.md` for digests.
- **Fixed demarcation for summaries.** Run the summary on the **1st of the
  month**, covering the *previous* month — the 1st is always the clean boundary.
  Scope the summary broadly: not just journal themes but mood/energy arc,
  notable events, and progress/threads across all of life+work.

**Two standing routines (agent-owned):**
1. Auto-archive every inbound voice note (transcribe + copy + confirm path).
2. Month-end rollup on the 1st.

An instance maps this pattern into its data root, normally under `stream/` and
`memory/`; provider IDs and local paths stay in private instance configuration.
