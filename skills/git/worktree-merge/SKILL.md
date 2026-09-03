---
name: worktree-merge
description: Integrates finished worktree branches through one throwaway integration branch, testing after each merge and running the full suite before the main line moves, with exact rollback on failure. Not for creating worktrees; use worktree-create.
triggers:
  - merge my worktrees
  - integrate these worktree branches
  - combine parallel branches
  - land finished worktrees
version: 0.5.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - ask_user
  - artifact
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/worktree-merge
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/worktree-merge
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - git-master
---

# Worktree Merge

Integrate finished branches through a disposable integration branch. The
original branch moves only after every merge lands and the full suite
passes; nothing reaches it red.

## Step 1 — Inputs and preconditions

- Fewer than two branches named → ask which to integrate; never guess.
- Confirm you are at the repository root, not inside `worktrees/`
  (`pwd` containing `/worktrees/` is an abort).
- Store the current branch as `<original>`.
- `git rev-parse --verify <branch>` for every branch in the list; any
  missing branch aborts before anything is created.
- Uncommitted changes on `<original>` → stop: commit or stash first.

## Step 2 — Detect the validation commands ONCE

Reuse exactly what CI runs: read `.github/workflows/*`, the Makefile, or
the manifest's scripts for the test, type-check, and lint commands. Never
substitute a generic runner for the project's own. Identify the fast test
command (per-merge) and the full suite (final gate).

## Step 3 — Integration branch

Create one throwaway branch off `<original>`, named for the set
(`integration-<first-branch>`, suffixed if needed, filesystem-safe). All
merging happens here.

## Step 4 — Merge each branch in order

Per branch: `git merge --no-ff <branch>`, then run the fast test command,
so a break is localized to the branch that caused it.

- **Conflict** → stop. Name the conflicting branch and files, give the
  resolution steps (resolve → `git add` → `git commit` → re-run with the
  same list), and do not attempt automatic resolution.
- **Test failure** → stop. Report which tests failed and the rollback:
  `git checkout <original> && git branch -D <integration>`.

## Step 5 — Full gate, then land

All branches merged → run the full detected suite (tests, type checks,
lint). Any failure: report and roll back as above. All green:
`git checkout <original> && git merge --no-ff <integration>`, then delete
the integration branch.

## Step 6 — Close out integration scaffolding

Delete the throwaway integration branch after the green landing. Then ask
(via `ask_user` when active) whether to close the merged source branches and
worktrees; never infer that approval from approval to merge.

On yes, resolve each registered path from `git worktree list --porcelain`
rather than assuming `worktrees/<branch>`. Inspect tracked changes, untracked
files, and ignored state that may be evidence rather than rebuildable output.
For each approved branch:

1. Confirm its result is represented on `<original>`. Ancestry is sufficient
   for the `--no-ff` merges this skill created; otherwise require the merged PR
   and resulting commit as evidence rather than trusting a subject match.
2. Remove its registered path with `git worktree remove <path>`, never `rm -rf`.
   Use `--force` only when the user explicitly approved discarding the
   remaining artifacts.
3. Delete the local branch with `git branch -d <branch>`. A forced deletion
   requires separate approval. If the work came through a contributor PR,
   separately offer to delete only its merged branch on that contributor's
   fork; canonical remote branches are never cleanup targets.

Maintainer source and integration branches remain local throughout; never push
them to a canonical-main-only remote. For contributor work, only the merged
branch on the contributor's fork is eligible for remote cleanup, and only when
authorized. A stash, local-only tag, and published release tag are outside this
cleanup unless the user names them explicitly.

## Step 7 — Report

Success: integration branch used, each branch with its post-merge test
result, the full-gate result, the merge into `<original>`, and cleanup status.
Always list the remaining worktrees, local branches, stashes, local-only tags,
and canonical remote heads; a canonical-main-only project expects exactly its
base branch. Every survivor needs a named purpose. Failure: the exact step and branch,
current state, rollback commands, and how to continue after fixing. Done when
one of those two reports is delivered and the repo is on `<original>`.

## Red flags

- Merging directly into `<original>` "to save a step".
- Running a guessed test command instead of the repo's own.
- Auto-resolving conflicts.
- Deleting worktrees or branches nobody approved.
- Assuming a worktree path from its branch name instead of reading Git's
  registry.
- Pushing an integration or maintainer source branch to a canonical-main-only
  remote.
- Deleting a canonical branch, stash, or tag as part of local cleanup.
- A red full gate absorbed into "mostly passing".
