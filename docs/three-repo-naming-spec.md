# Three-part naming and skill reset — cutover plan

Status: framework changes are in this PR. The instance changes are in a companion instance PR, because one PR cannot span two repositories. Cutover waits for human approval and a restart window. Doppler consolidation is out of scope for this change.

## Decision

| Name | Slug | Holds | Git |
|---|---|---|---|
| Humanware OS | `humanwareos` | Reusable framework, specs, software, capability skills | Public upstream |
| My Humanware | `my-humanware` | Configuration only: domain, styles, tones, identity overlays, routes, service definitions, secret references | Private repo |
| Humanware Data | `humanware-data` | Everything observed, produced, or worked on, including working documents | Local data root, backed up, never a repo |

The existing placement rules are unchanged. Only the names change.

## Skills

A Skill-tool audit (2026-10-02, every `~/.claude/projects` transcript plus `evidence/sessions`) found zero invocations of observe, orient, decide, act, review, rederive, and challenge, and one of compound. This PR deletes them and `commands/`. Google Workspace stays as a capability skill until the integration moves to the harness side. The loop continues as practiced: channel feedback is evidence, and recurring corrections become reviewed source changes.

## Renames

Paths:

| From | To |
|---|---|
| GitHub `arieldiaz/ariel-os` | `arieldiaz/my-humanware` (GitHub redirects the old URL) |
| `/Users/admin/github/ariel-os` | `/Users/admin/github/my-humanware` |
| `/Users/admin/github/ariel-os-worktrees` | `/Users/admin/github/my-humanware-worktrees` |
| `/Users/admin/ariel-os-data` | `/Users/admin/humanware-data` |
| `~/Library/Application Support/HumanwareOS/ariel-os` | `~/Library/Application Support/HumanwareOS/my-humanware` |

launchd labels: today they use three prefixes (`com.arielos.*`, `com.humanwareos.*`, `com.ariel.caddy`). All become `com.humanware.<service>`. `ai.openclaw.gateway` keeps its vendor label. Eleven stale `com.humanwareos.cutover.*` jobs are still loaded and will be removed. Buzz is removed entirely: its plists, routes, and docs.

Secrets: Doppler projects and key names are unchanged in this cutover; consolidation is a separate follow-up.

## Inventory at `origin/main`

- Framework: no instance paths remain after this PR. The example backup paths now use `humanware-data`. The public docs now use the three names.
- Instance: 91 files contain an old path, repo name, or label. The largest are the Caddyfile, `humanware.instance.json`, `services/openclaw.json`, 22 plists, observability scripts. Each literal path becomes a read of `HUMANWARE_DATA_ROOT` or the instance config, so a future rename is a config change.

## Cutover sequence

Preparation (no restart, can merge any time):

1. **Framework PR (this one):** delete the skills, commands, and Buzz docs, remove the `commands` copy from the runtime build, and rename the parts throughout the public docs. Tests pass, and the runtime build is unaffected.
2. **Instance PR:** parameterize every literal path, delete Buzz, rename the plists and labels, and add `ops/cutover/my-humanware.sh`. The script is idempotent, has a `--dry-run` that prints every move, and has a `--rollback`.

Cutover (one approved window, about 30 minutes):

3. Freeze: stop all `com.arielos.*`, `com.humanwareos.*`, and `com.ariel.*` jobs, then the gateway. This includes Buzz jobs.
4. Move: rename the GitHub repo, move the local checkout, worktree root, data root, and runtime root. Leave symlinks at every old path.
5. Activate: rebuild the runtime from the new paths, load the `com.humanware.*` plists, and start the gateway.
6. Verify: both agents answer in Slack and load context from `humanware-data`. Caddy serves `os.arieldiaz.com`. Each `com.humanware.*` job is running or exited 0. The heartbeat and token jobs write to the new root. Search the live processes for the old paths and expect nothing.

Rollback: stop the new jobs, run `--rollback` to reverse the moves, reload the old plists, and reactivate the previous runtime build.

Cleanup (after one clean week): remove the symlinks, then search the host for old names.
