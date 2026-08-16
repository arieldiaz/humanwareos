# Coding sessions

The checkout and closeout contract for coding work started from a conversational surface or coding harness. Layer 2 spec — see `docs/agent-context-hierarchy.md`.

Budget: 800 words.

## When isolation is mandatory

Create a task branch and isolated git worktree before the first product edit when any of these is true:

- the thread starts from a written spec for a new capability;
- the change is a multi-file feature, migration, or architectural refactor;
- the work is expected to cross a session boundary or run beside other work in the same repository.

A written new-build spec is the bright-line trigger; do not spend another judgment call deciding whether it is sufficiently large. A small, reversible fix may use an existing checkout only when that checkout is clean, no other live session holds it, and the repository's own branch policy permits the change.

## One scope, one workspace

The default mapping is one task thread → one owner → one branch → one worktree. Worktree isolation prevents filesystem collisions; single ownership prevents two sessions from independently implementing the same outcome.

Additional harnesses may inspect or verify the work. They do not edit the same scope independently. If the owner divides the implementation, each non-overlapping part gets an explicit owner and branch; the parent owner retains integration responsibility.

## Start from canonical state

Fetch the canonical remote branch, then create the task branch and worktree from that remote tip. Never derive a new worktree from a dirty shared checkout or assume its current branch is the correct base. Give the coding harness the worktree path as its explicit working directory.

Long-lived deployment or runtime checkouts are not feature workspaces. Keep them clean and pinned to their intended canonical branch; feature work flows into them through the repository's normal merge path.

## Reconcile before merge

Before opening or merging a pull request, fetch the canonical branch again and inspect open and just-merged work for the same scope. If another owner already landed the outcome, close the redundant branch instead of merging it. A clean worktree does not prove that the work itself is still unique.

## Prove the close

End every coding session in one of two states:

- the branch is committed and pushed, with its pull request or merge state reported, and the disposable worktree is removed once no longer needed; or
- the work is consciously discarded, with no unique change left only in that checkout.

The completion report names the repository and worktree, branch, working-tree state, commit and push state, and whether the change is merged to the canonical branch. A local commit without a pushed remote ref is not a durable handoff.
