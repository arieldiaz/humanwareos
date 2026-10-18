# Voice channel

The voice channel is a first-party adapter around an ordinary OpenClaw agent session. It does not define another agent, memory store, Slack mirror, or speech provider.

Budget: 500 words.

## First slice

The client performs speech recognition and speech playback. It sends only the recognized text to a loopback service through the instance's private tailnet surface. The service authenticates the request, serializes turns onto one configured agent session, invokes OpenClaw without delivery to another channel, and returns only the visible reply plus bounded run metadata.

For an iPhone Shortcut, Apple Dictation supplies text and Speak Text renders the response. Raw audio does not reach Humanware OS. A later streaming client may replace those edges without changing conversation ownership.

## Identity and authority

The instance selects the agent and provisions the bearer credential. The reference service is fixed to Liv and accepts only an authenticated owner request. The selected agent retains its normal profile, context, tools, and permission boundaries.

Voice may ask the agent to read or mutate Slack through a session-scoped workspace tool backed by the instance's configured Slack account. The ordinary message tool intentionally fences reads to the current channel conversation and cannot supply cross-channel voice access. The workspace tool exists only for the exact configured voice session, offers channel discovery, thread listing and reading, replies, and top-level thread creation, and never exposes its Slack credential. Successful model output is not proof of a Slack mutation: the agent reports only the tool's confirmed result. The voice conversation remains on the voice surface and is not mirrored into Slack.

Slack root workflow status remains human-controlled under `status-framework.md`. The voice adapter must not add, remove, or replace root status reactions. A future authenticated human-status control requires a separately reviewed contract.

## Security and privacy

The service binds to loopback and the instance exposes it only through its private network boundary. Every turn requires a bearer credential stored in the instance secret manager and on the owner's device. Request and response headers disable caching and referrer propagation. Prompts use mode-`0600` temporary files outside source and are deleted after invocation. Access logs must not record authorization headers or request bodies.

The service stores no audio and creates no separate transcript. OpenClaw's canonical session and activity evidence remain authoritative.
