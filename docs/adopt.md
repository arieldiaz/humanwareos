# Adopting Humanware OS

Humanware OS is a framework you run, not a library you import. The framework
stays public and generic; your context goes in a **private instance** where
`STRATEGY.md` gets filled in, `memory/` accumulates, and your machines' real
config lives. The installer keeps the two repositories connected so framework
updates stay a clean merge and contributions back stay deliberate.

## Why clone → push, not the template button

GitHub's "Use this template" button copies the files but **severs the history**:
your new repo starts with no ancestor in common with Humanware OS. Without a
shared merge-base, routine framework updates become conflict storms.

A GitHub *fork* keeps the history but can't be made private while the source is public, so it can't hold your life either.

The pattern that works is a **private mirror with a shared merge-base**: clone
Humanware OS, push it to a fresh private repo, and keep the framework wired as
the `upstream` remote.

## Create your instance

The installer can create the private GitHub repo, wire both remotes, and push
the first branch:

```
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware --repo YOUR-GITHUB-USER/my-humanware
```

This requires Git and the authenticated
[GitHub CLI](https://cli.github.com/). For a local-only instance, omit
`--repo`:

```
curl -fsSL https://raw.githubusercontent.com/arieldiaz/Humanware-OS/main/install.sh | sh -s -- my-humanware
```

You can also do the same wiring manually. Clone the framework, rename its
remote to `upstream`, then add your empty private repo as `origin`:

```
git clone https://github.com/arieldiaz/Humanware-OS.git my-humanware
cd my-humanware
git remote rename origin upstream
git remote add origin https://github.com/YOUR-GITHUB-USER/my-humanware.git
git push -u origin main
```

Verify the wiring—`origin` should point at your private repo, `upstream` at
Humanware OS:

```
git remote -v
```

That's the whole setup. Day-to-day work happens on your instance's `main` and pushes to `origin`; `upstream` exists only for the two flows below.

## Pull framework improvements down

Whenever Humanware OS improves:

```
git fetch upstream
git merge upstream/main
```

Because the histories are shared, these are small, clean merges. Conflicts appear only in files you deliberately forked from the framework's version — a skill you rewrote, your AGENTS.md instance block — and those conflicts are informative: they're the framework and your fork of it disagreeing, which is worth the minute of attention.

## Send improvements back up

The flow is one-way by default: framework → instance by merge, instance → framework **only by deliberate extraction**. The test for what goes up: *would a stranger running their own instance want this?* A sharper skill, a better ground rule, a pipeline fix — yes, genericized. Anything with your name, your machines, or your life in it — never.

Cut the contribution branch **from `upstream/main`, not from your instance's `main`** — otherwise the PR drags your entire private history behind it:

```
git fetch upstream
git switch -c my-improvement upstream/main
```

Port the change onto the branch by hand, or `git cherry-pick` the instance commit and then scrub it. Genericizing means placeholder paths (`/Users/you`), placeholder hosts (`mini.local`, `your-domain.com`), no names, no real config values. Before pushing, read the full diff hunting for your username, email, hostnames, and real absolute paths:

```
git diff upstream/main...HEAD
```

Your private instance cannot be a PR source, so contributions travel through a
public fork of Humanware OS:

```
gh repo fork arieldiaz/Humanware-OS --remote --remote-name fork
git push fork my-improvement
gh pr create --repo arieldiaz/Humanware-OS --head <YOUR-GITHUB-USER>:my-improvement
```

## `.example` files: the config seam

The seam between framework and instance runs straight through configuration, and one convention keeps it clean: **every config file that holds machine-local paths or secrets exists twice — a tracked `.example` with placeholders, and a gitignored real copy.** The framework ships `ops/stream-paths.env.example` and `infra/secrets/.env.example`; your instance copies each to its real name and fills it in. The `.gitignore` already excludes the real copies. That's not tidiness — it's the tripwire that keeps your values out of a repo whose commits you'll someday cut public PRs from.

The hygiene rules:

- **The `.example` is the manual.** Its comments carry the documentation: what each value is, where it comes from, how to generate it, which machine it lives on. If a knob needs explaining, explain it there — not in a separate doc that will drift.
- **Placeholders are loudly fake.** `you`, `/Users/you`, `mini.local`, `your-domain.com` — values nobody could mistake for real. Secret-shaped keys stay *empty* (`AUTH_SECRET=`) so a filled value screams in any diff.
- **Never a real value "temporarily."** Git history is append-only in practice; a secret that touches a commit is a secret you rotate. This holds inside your private instance too — mistakes travel, and rotating is always more work than not leaking.
- **Change the shape, change the `.example`.** When your instance adds or renames a config knob, update the `.example` in the same commit. If the knob is framework-shaped rather than personal, that `.example` edit is exactly the kind of thing to extract and PR upstream.
- **New `.example` ⇒ new `.gitignore` line.** If you add a config file the existing ignore patterns don't cover, the ignore rule lands in the same commit as the `.example`. An `.example` whose real counterpart is trackable is a leak waiting for a `git add -A`.

## What lives where

Framework (this repo, PR-able): skills, commands, agent *definitions*, AGENTS.md rules, the STREAM.md spec, `ops/` scripts with placeholders, `.example` files.

Instance (private, never upstream): a filled `STRATEGY.md`, `memory/` contents, `derived/`, the real config copies, and everything your agents know about you.

When in doubt, the stranger test decides.
