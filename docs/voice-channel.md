# Voice channel

The voice channel is a first-party adapter around ordinary OpenClaw agent sessions. It has two modes: conversational turns, where the client speaks and listens, and capture intake, where a recording becomes owner work in the instance's Slack intake channel. Neither mode defines another agent, memory store, Slack mirror, or cloud speech provider.

Budget: 1,000 words.

## Conversational turns

The client performs speech recognition and speech playback. It sends only the recognized text to a loopback service through the instance's private tailnet surface. The service authenticates the request, serializes turns onto one configured agent session, invokes OpenClaw without delivery to another channel, and returns only the visible reply plus bounded run metadata.

For an iPhone Shortcut, Apple Dictation supplies text and Speak Text renders the response. Raw audio does not reach Humanware OS in this mode. A later streaming client may replace those edges without changing conversation ownership.

The instance selects the agent and provisions the bearer credential. The reference service is fixed to Liv and accepts only an authenticated owner request. The selected agent retains its normal profile, context, tools, and permission boundaries.

Voice may ask the agent to read or mutate Slack through a session-scoped workspace tool backed by the instance's configured Slack account. The ordinary message tool intentionally fences reads to the current channel conversation and cannot supply cross-channel voice access. The workspace tool exists only for the exact configured voice session, offers channel discovery, thread listing and reading, replies, and top-level thread creation, and never exposes its Slack credential. Successful model output is not proof of a Slack mutation: the agent reports only the tool's confirmed result. The voice conversation remains on the voice surface and is not mirrored into Slack.

The service binds to loopback and the instance exposes it only through its private network boundary. Every turn requires a bearer credential stored in the instance secret manager and on the owner's device. Request and response headers disable caching and referrer propagation. Prompts use mode-`0600` temporary files outside source and are deleted after invocation. Access logs must not record authorization headers or request bodies. This mode stores no audio and creates no separate transcript; OpenClaw's canonical session and activity evidence remain authoritative.

## Capture intake

[services/voice-intake](services/voice-intake) receives one recording per run of a generated owner Shortcut and turns it into an owner request, exactly as if the owner had typed the transcript in a Slack thread.

**Ingress and authority.** The Shortcut records immediately and, when the owner taps stop, posts a form with the audio file, device name and model, and the capture timestamp. Only an edge tunnel reaches the capture listener, which binds to loopback. The edge requires an access service credential and the tunnel connector validates the edge token before forwarding, so no inbound port opens and the gateway stays loopback. Possession of that credential on an owner device is the authority for the turn, as aligned DKIM is for owner mail in [email-intake.md](email-intake.md). The Shortcut asks for the credential at import and never embeds it. A device whose Shortcuts runtime cannot record audio uses the generated dictation variant, which posts on-device dictated text to the same endpoint.

**Evidence.** The service reads the audio container type from the bytes and rejects anything else, then measures the clip with ffmpeg and rejects near-silent or sub-half-second audio before storing it. The original audio is Tier 0 evidence: it is written create-only, mode `0600`, under the instance evidence root with a metadata record, before the capture row exists. It is never uploaded to Slack or any external service. The capture id is a digest of kind, device, capture time, and content, so a retried upload is the same capture and never a second turn.

**Mechanics.** A serial worker advances each capture row: local Whisper transcription; a short title from an optional loopback summarizer, else the transcript's first words; the root post; the transcript reply; then admission of one agent turn. Transcription and posts are safe to repeat and retry a bounded number of times before holding. Each post carries Slack metadata naming its capture and part, so a lost response is found again rather than reposted. Posts use the agent's own Slack bot.

**Slack shape.** The root is the device emoji, device name, local date and time, and the title. The first reply is the full transcript with a link to the audio on the private domain; the audio itself is never attached. The agent's own final reply, delivered by the gateway into the same thread, lists the actions taken with links to the pages, files, and tasks touched.

**Dispatch.** The confirmed root determines the canonical Slack thread session key, so the owner's later replies continue the same conversation. The turn is admitted through the gateway's `agent` method with the instance's protected credential resolution, explicit Slack account, channel, and thread, `deliver: true`, and a stable idempotency key. This reuses the email-intake path rather than an HTTP hook, so it needs no hook token, hook configuration, or gateway restart. The message carries only the path of a private request record, never the transcript. The agent keeps its normal tools and approval boundaries. An admission whose outcome is unknown is reconciled from `agent.wait` on the stable run id, or held for the operator, never blindly re-executed.

**Audio access.** A second loopback listener serves stored audio by capture id, with byte ranges for media players, only behind the instance's existing private-domain access boundary. The capture listener never serves audio, and the audio listener never accepts captures. Held rows make health fail.

The instance supplies the ingress hostname and tunnel, the private origin and audio route, the agent, the Slack channel registry name, the agent's bot token, the time zone, the Whisper model, and the optional summarizer model.

## Root status

Slack root workflow status remains human-controlled under `status-framework.md`. Neither mode adds, removes, or replaces root status reactions. A future authenticated human-status control requires a separately reviewed contract.
