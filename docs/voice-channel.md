# Voice channel

The voice channel is a first-party adapter around ordinary OpenClaw agent sessions. It has two modes: conversational turns, where the client speaks and listens, and capture intake, where a recording becomes owner work in the Slack intake channel. Neither mode adds an agent, memory store, Slack mirror, or cloud speech provider.

Budget: 1,000 words.

## Conversational turns

The client performs speech recognition and playback and sends only the recognized text to a loopback service through the instance's private tailnet surface. The service authenticates the request, serializes turns onto one configured agent session, invokes OpenClaw without delivery elsewhere, and returns the visible reply plus bounded run metadata.

For an iPhone Shortcut, Apple Dictation supplies text and Speak Text renders the response. Raw audio does not reach Humanware OS in this mode. A streaming client may later replace those edges without changing ownership.

The instance selects the agent and provisions the bearer credential. The reference service is fixed to Liv and accepts only an authenticated owner request. The selected agent keeps its normal profile, context, tools, and permissions.

Voice may ask the agent to read or mutate Slack through a session-scoped workspace tool backed by the instance's configured Slack account. The ordinary message tool fences reads to the current conversation and cannot supply cross-channel voice access. The workspace tool exists only for the configured voice session, offers channel discovery, thread reading, replies, and thread creation, and never exposes its credential. Model output is not proof of a Slack mutation; the agent reports only the tool's confirmed result. The voice conversation stays on the voice surface, never mirrored into Slack.

The service binds to loopback behind the instance's private network boundary. Every turn requires a bearer credential held in the instance secret manager and on the owner's device. Headers disable caching and referrer propagation. Prompts use mode-`0600` temporary files outside source, deleted after invocation. Access logs never record authorization headers or request bodies. This mode stores no audio and creates no separate transcript; OpenClaw's canonical session and activity evidence remain authoritative.

## Capture intake

[services/voice-intake](services/voice-intake) receives one recording per run of a generated owner Shortcut and turns it into an owner request, exactly as if the owner had typed the transcript in a Slack thread.

**Ingress and authority.** The Shortcut records immediately and, when the owner taps stop, reads the device location without blocking on it, then posts the audio file, device name and model, capture timestamp, its generator version, and any coordinates and place details. The service stores the version and tells an outdated device a newer build exists, never refusing it. Only an edge tunnel reaches the capture listener. The edge requires an access service credential, validated before forwarding, so no inbound port opens. That credential on an owner device is the authority for the turn, as aligned DKIM is for owner mail in [email-intake.md](email-intake.md). The Shortcut asks for the credential at import and never embeds it. A device that cannot record audio uses the dictation variant, which posts text to the same endpoint.

**Evidence.** The service reads the audio container type from the bytes, rejects anything else, and refuses near-silent or sub-half-second clips measured with ffmpeg before storing anything. The original audio is Tier 0 evidence, written create-only, mode `0600`, under the instance evidence root with a metadata record before the capture row exists, and never uploaded. The capture id digests kind, device, capture time, and content, so a retried upload is the same capture, never a second turn.

**Mechanics.** A serial worker advances each capture row: local whisper.cpp transcription; the root post, titled with the transcript's first words; the transcript reply; then admission of one agent turn. An optional loopback summarizer later edits the root title in place, so the thread never waits for a language model. Transcription and posts are idempotent and retry a bounded number of times, then hold. Each post carries Slack metadata naming its capture and part, so a lost response is found, not reposted; if Slack refuses metadata, posts match by author and text. The root and transcript post as the owner when the instance supplies an owner user token with only `chat:write`, else as the agent's bot; the bot token always reads and verifies, and the title edit uses the posting token. The root never mentions the agent, because admission already starts the turn.

**Slack shape.** The root is the device emoji, local date and time, place label when known, and the title. Coordinates stay in the ledger and evidence record and never reach Slack. The first reply is the full transcript with a link to the audio on the private domain, never the audio itself. The agent's final reply, delivered by the gateway into the same thread, lists the actions taken with links.

**Dispatch.** The confirmed root determines the canonical Slack thread session key, so the owner's later replies continue the conversation. The turn is admitted through the gateway's `agent` method with protected credential resolution, explicit Slack account, channel, and thread, `deliver: true`, and a stable idempotency key, reusing the email-intake path without a hook token or gateway restart. The message carries only the path of a private request record, never the transcript. The agent keeps its normal tools and approval boundaries. An unknown admission outcome is reconciled from `agent.wait` on the stable run id, or held for the operator, never blindly re-executed.

**Audio access.** A second loopback listener serves stored audio by capture id, with byte ranges, only behind the instance's private-domain boundary. Neither listener does the other's job. Held rows make health fail.

The instance supplies the ingress hostname and tunnel, the private origin and audio route, the agent, the Slack channel registry name, the agent's bot token, the optional owner user token, the time zone, the whisper.cpp model file, and the optional summarizer model.

## Root status

Slack root workflow status remains human-controlled under `status-framework.md`; neither mode adds, removes, or replaces root status reactions. A future authenticated human-status control requires a separately reviewed contract.
