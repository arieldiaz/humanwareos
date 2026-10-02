# Three-repo naming and skill reset — spec

Status: draft for human approval. Nothing moves until this is approved.

## Decision

Humanware has three named parts:

| Name | Slug | Holds | Git |
|---|---|---|---|
| Humanware OS | `humanwareos` | Reusable framework, specs, software, skills | Public upstream |
| My Humanware | `my-humanware` | Personal configuration and overrides (domain, styles, tones, identities, routes, secret references) plus curated working documents | Private repo |
| Humanware Data | `humanware-data` | Evidence, current memory, artifacts, generated output, operations, agent workspaces, sessions | Local data root, not a repo |

"Ariel" leaves every generic name. A fork gets `my-humanware` and `humanware-data` without renaming anything.

## Change from today's rules

Today, mutable working documents live in the data plane, and rule 7 bars them from instance source. This spec moves **curated human working documents** into My Humanware so they get history, review, and backup. Rule 7 and `docs/data-plane.md` change to:

- My Humanware may hold human-authored working documents (plans, notes, house, health, research write-ups).
- Agent workspaces, sessions, Slack scratch, media, operations, caches, and anything large or machine-generated stay in Humanware Data.
- Secrets stay in the secret manager. The privacy tiers are unchanged: Tier 0 raw evidence never enters a repo.

Size check (current `working/`, 17 GB): `ops` 13 GB, `agents` 1.6 GB, `projects` 1.4 GB, `humanware-os` 645 MB, `sessions` 114 MB stay in the data root. Candidates to move are the small human folders: `house`, `health`, `inbox`, `research`, `house-purchase-scenarios`, and `market-map.md`. Large binaries stay in the data root and are referenced by path.

## Renames

| From | To |
|---|---|
| GitHub `ariel-os` | `my-humanware` (GitHub keeps a redirect) |
| `/Users/admin/github/ariel-os` | `/Users/admin/github/my-humanware` |
| `/Users/admin/github/ariel-os-worktrees` | `/Users/admin/github/my-humanware-worktrees` |
| `/Users/admin/ariel-os-data` | `/Users/admin/humanware-data` |
| `~/Library/Application Support/HumanwareOS/ariel-os` | `~/Library/Application Support/HumanwareOS/my-humanware` |
| launchd labels `com.arielos.*` | `com.humanware.*` |

Hard-coded references at `origin/main`: about 30 in Humanware OS (mostly `AGENTS.md`, `STREAM.md`, `ops/stream-paths.env.example`, two skills, the session console, the run-signature plugin) and about 100 across about 30 files in the instance repo (Caddyfile, `humanware.instance.json`, `services/openclaw.json`, launchd plists, observability scripts). Each one should read `HUMANWARE_DATA_ROOT` or the instance config rather than a literal path.

## Skill reset

Audit of all transcripts in `~/.claude/projects` and `evidence/sessions` (Skill-tool invocations), on 2026-10-02:

| Framework skill | Invocations |
|---|---|
| observe, orient, decide, act, review, rederive, challenge | 0 |
| compound | 1 |
| google-workspace | 0 as a skill; the connector it describes is in use |

Delete `skills/{observe,orient,decide,act,review,compound,rederive,challenge}` and `commands/*`. Keep `google-workspace` until the connector's tool descriptions carry its steps, then delete it too. Add a skill back only when real work repeats a procedure. The feedback loop stays as it works now: the human's channel feedback is evidence, and recurring corrections become source changes through review.

## Order (one PR each, each reversible)

1. **Framework:** remove literal paths, add the skill deletions, amend rule 7 and the data-plane spec. No behavior depends on the new names yet.
2. **Instance:** rename the repo on GitHub, parameterize paths, rename launchd labels. Rebuild the runtime and verify.
3. **Data root:** stop services, move `ariel-os-data` → `humanware-data`, leave a symlink at the old path for one release, restart, then verify both agents load context. Requires explicit human approval for the restart.
4. **Working documents:** move the curated folders into `my-humanware/working/`, with a symlink back during transition.
5. **Cleanup:** remove the symlinks after one clean week.

Rollback for steps 2–4 is the reverse move plus the previous runtime build.

## Open questions

1. Is `com.humanware.*` acceptable for launchd labels, or should it be `com.myhumanware.*`?
2. Confirm the folder list for working documents.
