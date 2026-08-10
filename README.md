# Humanware OS

**The open operating system for the human side of AI.**

Software runs computers. Firmware runs hardware. Humanware helps a person
remember, decide, create, and act—with AI agents that build context instead of
starting over.

Humanware OS is a small, opinionated framework for giving durable agents shared
memory, a clear operating loop, and access to the interfaces you already use.
It is not another chatbot, productivity template, or second-brain filing
system. It is the layer that helps the human stay oriented and in command.

This README has two halves:

- **Theory** explains why the system is designed this way.
- **Practice** shows what running it looks like and how to begin.

## Theory

### Human in command

Agents bring context, judgment, and execution forward. The human remains the
author, owner, and final decision-maker. Humanware OS makes every handoff
explicit instead of hiding responsibility inside an endless chat.

Every active thread starts 🔄 with the agent. When the agent stops, only two
questions matter:

- ❓ **Clarify** — the human owes an answer, judgment call, or go.
- ✋ **Act** — the human owes work only they can do with their identity, access,
  or hands.

Everything else is either 🗓️ scheduled to resurface at a real time or ✅ done
after the human confirms the outcome. The same state appears in the thread's
emoji strip and in the final heading of the agent's reply.

### Few durable agents, many skills

Most agent systems create a new worker for every task. Humanware OS keeps a
small roster of durable agents that learn how you work over time, then lets
them wear skills as hats.

The reference roster includes [Liv](agents/liv.md), a personal Chief of Staff,
and [Max](agents/max.md), a CEO-minded work partner. Rename them, rewrite them,
or start with one agent. Continuity is the point; the names are not.

Agents use a small operating loop:

```
observe → orient → decide → act → review → compound
```

`compound` writes the useful lesson back into the system so the next cycle
starts smarter. Skills are editable prose, not fixed product behavior.

### Memory that compounds

Humanware OS separates three kinds of context:

- The **stream** is the append-only record of what happened.
- **Derived artifacts** are replaceable interpretations: transcripts,
  summaries, and reports.
- **Memory and strategy** are the small curated layer agents load every day.

Raw data stays local. Better models can re-derive better interpretations later,
without rewriting history. The system remembers without turning every capture
into permanent prompt clutter.

### Your interfaces, not another inbox

Humanware OS starts where conversation already happens. The current reference
path uses Slack because it is reliable, familiar, and free to begin. OpenClaw
connects Slack, models, tools, and the files in your private instance.

The interface is replaceable. Buzz is the intended bundled, open path when its
runtime is mature enough; Slack is the pragmatic starting point today.

## Practice

### Start with the agent

The first setup step is not building integrations. It is configuring one agent
and starting a local terminal conversation.

Once the agent can work, give it this repository and let it drive as much of
the remaining setup as possible: inspect the machine, install tools, edit safe
configuration, run verification commands, explain account screens, and use
browser or desktop automation where available. A dedicated always-on Mac gives
the agent the widest useful operating surface.

The human should do only the actions that genuinely require their identity or
consent: create accounts, sign in, approve permissions, choose a domain, and
enter secrets directly into the secrets manager. Secret values never belong in
chat, files, logs, or git.

### What you need

For the first working Slack agent:

- A Mac that can run the agent; an always-on Mac mini is preferred.
- A model subscription or provider account supported by OpenClaw.
- A free Slack workspace.
- A free Doppler account for credentials.
- Git and a GitHub account; a private GitHub instance is recommended.

For the complete reference setup, add a Cloudflare account and a domain for
hosted artifacts, dashboards, and stable public URLs. They are not required for
the first Slack conversation because Slack Socket Mode needs no public URL.

### The shortest path

Create a private, upstream-connected instance:

```bash
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware --repo YOUR-GITHUB-USER/my-humanware
```

Then open that directory in your preferred coding agent and say:

> Help me configure my first Humanware OS agent, then walk me through the
> Getting Started guide. Drive every safe terminal or UI step you can. Stop
> only when an action requires my identity, consent, or a secret value.

The installer creates the instance; it does not install the runtime. Follow
[Getting Started](docs/getting-started.md) from the first local agent session
through a verified Slack conversation.

### What is in the system

```
humanware-os/
├── AGENTS.md       operating rules every agent loads
├── STRATEGY.md     who you are and what matters now
├── agents/         durable agent definitions
├── skills/         editable operating-loop skills
├── memory/         curated lessons and patterns
├── derived/        disposable transcripts and reports
├── ops/            local capture, transcription, and backup
└── docs/           setup, architecture, and system contracts
```

Read [Architecture](docs/architecture.md) for the components, data flow, and
trust boundaries. Read [Adopting Humanware OS](docs/adopt.md) for the public
framework/private instance Git model.

### Day to day

Capture constantly and process on your schedule. Ask the agent what matters,
run the loop for real work, and compound what should survive the session.

- **Daily:** capture freely; orient only what pulls.
- **Per piece of work:** orient → decide → act → review.
- **Weekly:** review against `STRATEGY.md`, then compound.
- **Quarterly:** rewrite strategy honestly and re-derive anything worth seeing
  through better models.

Humanware OS is also an Obsidian vault. Open the private instance folder in
Obsidian for a human reading and writing surface over the same Markdown files.
The stream itself remains outside the repo.

## Status

Humanware OS is early. The framework and reference instance are real; the
general installation path is being hardened through new-user walkthroughs.
Slack + OpenClaw is the supported starting path. Buzz integration remains an
active experiment, not a dependency.

Issues, setup reports, and structural improvements are welcome.

## Sources and inspirations

- [Every's compound engineering](https://github.com/EveryInc/compound-engineering-plugin)
  supplied the compounding principle: each unit of work should make the next
  one easier.
- [Addy Osmani's agent skills](https://github.com/addyosmani/agent-skills)
  demonstrated prose workflows that agents can follow and improve.
- [Machina's event-stream idea](https://x.com/EXM7777/status/2073045719020343705)
  inspired the append-only source and rerunnable interpretation model.

## License

[MIT](LICENSE).
