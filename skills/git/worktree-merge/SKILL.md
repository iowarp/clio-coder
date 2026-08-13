---
name: worktree-merge
description: Use when parallel worktree branches are finished and the user asks to integrate them — "merge my worktrees", "integrate these branches". Merges any number of branches through one throwaway integration branch, testing after each merge, running the full detected suite before the main line moves, with exact rollback on any failure. Not for creating worktrees; use worktree-create.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - ask_user
  - artifact
clio:
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

## Step 6 — Offer cleanup

Ask (via `ask_user` when active): remove the merged worktrees and delete
their feature branches, or keep them? On yes, per branch:
`git worktree remove worktrees/<branch> && git branch -d <branch>`. Never
clean up without the answer.

## Step 7 — Report

Success: integration branch used, each branch with its post-merge test
result, the full-gate result, the merge into `<original>`, cleanup status
(with manual commands if kept). Failure: the exact step and branch, current
state, rollback commands, and how to continue after fixing. Done when one
of those two reports is delivered and the repo is on `<original>`.

## Red flags

- Merging directly into `<original>` "to save a step".
- Running a guessed test command instead of the repo's own.
- Auto-resolving conflicts.
- Deleting worktrees or branches nobody approved.
- A red full gate absorbed into "mostly passing".
