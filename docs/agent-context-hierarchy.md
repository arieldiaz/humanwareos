# Agent context hierarchy

Why an agent's instructions are split the way they are, and which file wins when two disagree. `AGENTS.md` states the rule in two paragraphs; this is the reasoning behind it and the shape it implies on disk.

Budget: 1,500 words. Over it, consolidate — do not extend.

## The problem, stated plainly

An agent's behavior is assembled from dozens of files across several locations, and typically **nothing declares which one wins.** `AGENTS.md` says one thing, a persona file restates it slightly differently, and a memory file written unilaterally by an agent last Tuesday says a third thing. All three arrive in the context window as flat prose with no ranking, so whichever the model weights more that turn is what happens. That is why the conflicts feel arbitrary — they are arbitrary.

Tidying the files into nicer folders does not fix this. The fix is to give every file exactly one job and one authority level, and to write the precedence order down where the agent reads it.

## The hierarchy

Four layers. Each one may only *narrow* the layer above it, never contradict it. When two layers disagree, **the higher layer wins and the lower one is a defect to be deleted** — not a tiebreaker, not context, a defect.

### Layer 1 — Global rules · `AGENTS.md`

How every agent behaves everywhere, on every harness, in every repo. Never fake a result; command blocks contain no comments; no pop-up questions. This is the constitution.

- **Author: the human only.** An agent never writes here. When it learns a rule it proposes a diff and waits.
- Symlinked into each harness's global-config slot so it loads automatically without being owned by the harness. Claude Code only auto-loads a file literally named `CLAUDE.md`, so that name becomes a symlink to this one — a harness shim, never edited by hand.
- Small on purpose. If it grows past roughly a screen and a half, the overflow belongs in a Layer 2 spec.

### Layer 2 — Domain specs · `docs/*.md`

One subject, stated once, in depth. `docs/slack-style.md` is the model: everything about how a Slack reply is shaped lives there and nowhere else. `docs/status-framework.md` owns lifecycle states; `docs/reply-shape.md` owns the structure of a reply on any surface.

- **Author: the human, with agent-proposed diffs.**
- Layer 1 *points* at these; it does not summarize them. A summary is a second copy, and second copies drift.
- A spec may be long. Nobody loads all of them every turn — they are read on demand, which is the whole reason to move depth out of Layer 1.

### Layer 3 — Identity · `agents/<name>.md`

What makes one agent different from another: role, scope, tone, what it owns and what it hands off. Only the *differences*. Anything true of both agents is a Layer 1 or Layer 2 rule that has leaked downward.

- **Author: the human.**
- Runtime workspace files that a gateway loads by name become thin pointers to this layer rather than parallel copies of it. They exist because the runtime loads them by name; that is a harness requirement, not a place to keep rules.

### Layer 4 — Memory · `<repo>/memory/`

What was learned. Non-normative facts only: project state, why a decision was made, what is parked, where a dashboard lives.

- **Author: the agent, continuously.**
- Lives in the repo it describes; symlinked into the harness's memory slot so the agent's ordinary writes land in git with no sync step.
- **A memory file may never contain a rule.** If what was learned is a rule about the agent's own behavior, it does not get a memory file — it gets a proposed diff to Layer 1 or Layer 2. This single restriction is what removes the conflict class, because contradictions live almost entirely in memory files that are quietly asserting rules.

## Why this fixes conflicts rather than relocating them

Three mechanisms, in order of how much work they are:

1. **Precedence is declared.** One paragraph in Layer 1 states the order and states that a lower layer contradicting a higher one is a defect. Costs nothing, and it is the piece usually missing.
2. **The write path gets a scope gate.** The instruction changes from "save the fact" to "save only what is repo-local and non-normative; if it is a rule, propose a diff instead." Conflicts stop being generated at the source.
3. **Writes become reviewable.** Once memory is in the repo, every agent memory write shows up in `git status` and gets read at commit time. In a harness-owned memory folder they accumulate invisibly and nobody reviews them.

(1) and (3) are nearly free, and (2) is one paragraph of prose. There is no tooling to build.

## Harness independence

Every layer lives in a git repo and is *linked into* whatever harness is running. No harness owns any of it.

- A harness typically auto-loads exactly two things: a global instruction file and a memory index. Everything else is pulled in because a Layer 1 instruction tells the agent to read it. That means the whole hierarchy is governed by prose, with no harness setting to configure and nothing that breaks on a CLI update.
- A *symlinked memory directory* auto-loads. Point the harness's per-project memory folder at `<repo>/memory/` and keep the index and its fact files together, so the relative links between them survive. Symlinking the index file alone also works but splits it from the facts it links to — link the directory.
- Any harness after the current one gets the same treatment: point its global-config slot at `AGENTS.md`, point its memory slot at the repo. Any harness-native memory store is a disposable cache, never a source of record.

## On disk

```
life-os/                      the framework — generic, opinionated, owns every rule
  AGENTS.md                   Layer 1 — the constitution
  docs/*.md                   Layer 2 — one subject each
  agents/liv.md, max.md       Layer 3 — identity, differences only
  memory/                     Layer 4

<instance>/                   a person's own life-os
  docs/<spec>.md              symlink to the framework file — never a copy
  docs/<spec>-instance.md     the overlay: paths, registries, channel ids
  memory/                     Layer 4 — this instance's memory

~/.claude/CLAUDE.md                    -> AGENTS.md
~/.claude/projects/<slug>/memory       -> <repo>/memory
```

**An instance never forks a framework file.** It symlinks it and adds a sibling overlay for what is genuinely local — absolute paths, channel ids, gateway patches, tool names. Duplicate-and-reconcile is how the two copies silently diverge; the symlink makes drift structurally impossible instead of something an agent has to notice. The cost is real and accepted: changing a generic rule is a two-repo operation.

## Rigid rules vs soft principles

Guidance for frontier models is to replace absolute constraints with principles the model applies with judgment — "match the surrounding code's comment density" rather than "DO NOT add comments." That is right for most instructions and wrong for a few, and the line between them is what this section is for.

**Keep it rigid when the rule encodes something the model cannot infer.** Environment facts, past incidents, and preferences that are genuinely arbitrary. A smarter model does not help; it will confidently get these wrong because the correct answer is not derivable from the text in front of it. Comments inside a terminal block breaking an interactive shell; final plain text not reaching the chat surface; where secrets live; absolute paths; a renderer's silent fallback threshold; channel silence rules; never faking a result.

**Make it a principle when the model would mostly get it right and the cases vary.** Stated as an absolute, these produce worse output than trusting judgment, because the rule fires in situations it was never meant for. Reply length and structure — "most replies are short prose; structure is earned" beats a template per response type. Tone and register. Verification depth, proportional to stakes. Bug and postmortem brevity: the shape matters, the exact section count does not.

**The test:** if you can imagine a situation where following the rule literally produces a worse result, it should be a principle. If violating it produces a broken paste, a leaked secret, an undelivered message, or a false claim, it stays rigid.

Two corollaries. A rigid rule earns its place by naming the failure it prevents — a rule with no failure attached is a preference that hardened by accident. And a long *spec* is not the same as a long *system prompt*: Layer 2 files are read on demand, so the constraint that matters is keeping Layer 1 thin.
