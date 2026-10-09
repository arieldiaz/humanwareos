# Coding sessions

The checkout and closeout contract for coding work started from a conversational surface or coding harness. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 800 words.

## When isolation is mandatory

Create a task branch and isolated git worktree before the first product edit when any of these is true:

- the thread starts from a written spec for a new capability;
- the change is a multi-file feature, migration, or architectural refactor;
- the work is expected to cross a session boundary or run beside other work in the same repository.

A written new-build spec is the bright-line trigger; do not spend another judgment call deciding whether it is sufficiently large. A small, reversible fix may use an existing checkout only when that checkout is clean, no other live session holds it, and the repository's own branch policy permits the change.

## Isolate edits, not conversations

Use a task-owned branch and worktree to avoid filesystem collisions. Parallel implementations need non-overlapping edit scopes and an integration plan. Reviewers may inspect the same work. This does not create a thread owner or restrict who may respond to the human.

## Start from canonical state

Fetch the canonical remote branch, then create the task branch and worktree from that remote tip. Never derive a new worktree from a dirty shared checkout or assume its current branch is the correct base. Give the coding harness the worktree path as its explicit working directory.

Long-lived deployment or runtime checkouts are not feature workspaces. Keep them clean and pinned to their intended canonical branch; feature work flows into them through the repository's normal merge path.

## Reconcile before merge

Before opening or merging a pull request, fetch the canonical branch again and inspect open and just-merged work for the same scope. If another owner already landed the outcome, close the redundant branch instead of merging it. A clean worktree does not prove that the work itself is still unique.

## Prove the close

End every coding session in one of two states:

- the branch is committed and pushed, with its pull request or merge state reported; or
- the work is consciously discarded, with no unique change left only in that checkout.

The completion report names the repository and worktree, branch, working-tree state, commit and push state, and whether the change is merged to the canonical branch. A local commit without a pushed remote ref is not a durable handoff.

A merged pull request ends its branch and worktree. The session that merges it, or the scheduled check that observes the merge, deletes the remote branch and removes the worktree in the same run; a merged branch's worktree is residue, never a workspace. A superseded branch that will not merge is closed and deleted the same way. Worktrees and branches that outlive their pull request are the signal that this step was skipped.
