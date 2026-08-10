# Getting Started

This guide takes Humanware OS from a fresh Mac to one verified conversation
with a durable agent in Slack.

The setup principle is simple: **configure the agent first, then let the agent
drive the setup with you.** The agent should perform safe terminal work, edit
configuration, run checks, and guide or automate UI steps. You handle only
identity, consent, account ownership, and secret entry.

## The finish line

You are done with the core setup when:

1. One agent can work locally in the terminal from your private instance.
2. OpenClaw runs as a background service on the host.
3. A message in your Slack workspace reaches that agent.
4. The reply lands in the same Slack thread.
5. No secret value exists in the repo, shell history, or chat transcript.

Cloudflare, a domain, the capture pipeline, and backups belong to the full
setup, but they do not block this first conversation.

## 1. Prepare the accounts and host

### Required for the core setup

- A Mac. An always-on Apple Silicon Mac mini is the preferred host; a MacBook
  is fine for evaluation but sleeps and travels.
- A model subscription or provider account supported by OpenClaw. Subscription
  login is the easiest starting path when available; an API key is optional.
- A free Slack workspace.
- A free Doppler account with strong multi-factor authentication.
- Git. A GitHub account and authenticated GitHub CLI are recommended so the
  private instance is backed up and can receive framework updates.

### Required for the full reference setup

- A Cloudflare account.
- A domain managed through Cloudflare.

The domain supports stable artifact pages, dashboards, and other public URLs.
Slack itself uses Socket Mode and does not need an inbound public URL.

### Optional later

- A second Mac for capture.
- A NAS and offline or offsite backup.
- Local transcription and local models.
- Additional services such as calendars, email, Notion, or social tools.
- Buzz, once the bundled path is stable enough for daily use.

## 2. Create the private instance

Install Git and the GitHub CLI if needed, authenticate `gh`, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware --repo YOUR-GITHUB-USER/my-humanware
cd my-humanware
```

For a local-only evaluation, omit `--repo`:

```bash
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware
cd my-humanware
```

Verify the repository wiring:

```bash
git remote -v
```

`origin` should be your private repository and `upstream` should be the public
Humanware OS framework. See [Adopting Humanware OS](adopt.md) for the complete
update and contribution model.

## 3. Configure the first agent

Start with one agent. Two is a useful eventual division, not a setup
requirement.

Open the private instance in a coding agent that can read and edit local files.
Use this prompt:

> Help me configure my first Humanware OS agent. Read AGENTS.md, STRATEGY.md,
> memory/index.md, agents/README.md, and this Getting Started guide. Ask me one
> question at a time about the agent's role and voice. Make the safe file and
> terminal changes yourself. Never ask me to paste a secret into chat or write
> one into the repo. Stop only for identity, consent, or credential actions I
> must perform.

The agent should help you:

1. Decide the agent's domain and boundaries.
2. Create or adapt its definition in `agents/`.
3. Fill the first honest version of `STRATEGY.md`.
4. Keep personal facts in `memory/`, not in the reusable agent definition.
5. Confirm that `AGENTS.md`, `STRATEGY.md`, and `memory/index.md` load at the
   start of meaningful work.

Commit this baseline before adding the runtime. It is the first durable version
of the relationship.

## 4. Install and onboard OpenClaw

OpenClaw is the current runtime connecting the agent, model, tools, and Slack.
Install the current stable release with the official installer:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

The installer may start onboarding automatically. If it does, use that flow;
otherwise verify the install, then start onboarding yourself:

```bash
openclaw --version
openclaw onboard --install-daemon
```

Point the agent workspace at your private Humanware OS instance. Choose a model
login supported by OpenClaw. Prefer subscription or device-code login where it
fits your provider; do not create an API key merely because an older guide
assumes one.

Let the agent drive the terminal and explain each choice. You should take over
only when a browser asks you to sign in, authorize a provider, or approve a
security-sensitive permission.

Verify the runtime before adding Slack:

```bash
openclaw models status
openclaw doctor
openclaw status
```

Then start a local terminal conversation:

```bash
openclaw chat
```

Ask the agent to name its role, summarize the current strategy, and identify
the next setup step. If it cannot answer from your files, fix the workspace and
context loading before adding another system.

## 5. Establish the secrets layer

Doppler is the reference secrets manager. Secret values live there and only
there. Read [The secrets layer](../infra/secrets/runbook.md) before creating
projects or service tokens.

The agent may install the Doppler CLI, run login, create project structure, and
verify access. You perform the account login and enter secret values directly
into Doppler's protected prompt or web UI. Never paste a value into the agent
conversation.

At minimum, create a project for the runtime and one trust domain for the
agent. Use scoped, read-only service tokens for background consumers. Keep only
the tiny bootstrap credential outside Doppler in a mode-600 file outside the
repo, as described by the secrets contract.

Verification must prove both sides:

- The intended runtime can read the names it needs.
- One agent or consumer cannot read another trust domain.

## 6. Create the Slack app

Start with one Slack app for the first agent. The agent should walk you through
the current OpenClaw Slack guide and drive browser automation where available.
You remain responsible for creating the app under your Slack identity,
reviewing scopes, installing it to the workspace, and approving permissions.

Use Slack Socket Mode. It creates an outbound connection from the Mac, so this
stage does not require Cloudflare, a domain, a tunnel, or an open inbound port.

Store the Slack credential values directly in Doppler. Refer to them elsewhere
only by their environment-variable names. Do not paste them into chat or save
them in a `.env` file.

After the app is installed, add the Slack channel/account through OpenClaw's
guided channel configuration:

```bash
openclaw channels add
openclaw channels status
openclaw doctor
```

Restart the gateway cleanly after channel configuration:

```bash
openclaw gateway restart
openclaw status
```

## 7. Verify the real handoff

Create a Slack channel for the system, invite the agent app, and send a direct
mention in a new thread.

Ask the agent to:

1. State its role.
2. Read one harmless fact from `STRATEGY.md`.
3. Run a harmless local command such as reporting the current repository path.
4. Reply in the same Slack thread.

Do not call the setup complete because a process is running. Verify the entire
handoff: Slack inbound → OpenClaw → model → workspace/tool → Slack outbound.

If it fails, collect evidence in this order:

```bash
openclaw channels status
openclaw models status
openclaw doctor
openclaw logs
```

Diagnose the layer named by the evidence. A Slack-visible error may originate
in provider auth, agent routing, or gateway delivery rather than Slack itself.

## 8. Add the full system in layers

Once the core loop is reliable, let the agent drive one layer at a time:

1. Cloudflare and the domain for artifact and dashboard URLs.
2. Backup and restore for the private instance and runtime state.
3. Local capture, transcription, and the append-only stream.
4. Additional agents with separate roles and credentials.
5. Calendars, email, publishing, and other tools.
6. Buzz evaluation or migration when its bundled path is reliable.

Each layer gets a verification that cannot lie. Do not add more integrations
to compensate for an unreliable core conversation.

## Agent/human setup boundary

The agent should normally do:

- Inspect the host and repository.
- Install command-line dependencies.
- Edit non-secret configuration and agent files.
- Run setup, health, and verification commands.
- Open the correct account pages and explain requested permissions.
- Drive browser or desktop UI when the host grants that capability.
- Record durable, non-secret setup decisions in the private instance.

The human must normally do:

- Choose the agent's remit and approve consequential tradeoffs.
- Create and own accounts.
- Sign in and complete multi-factor authentication.
- Approve OAuth grants, app installs, and requested scopes.
- Enter or rotate secret values directly in Doppler.
- Approve OS permissions that grant control of the machine.

The goal is not zero human involvement. It is zero unnecessary setup labor and
an explicit boundary around identity, consent, and secrets.
