---
name: worktree-create
description: Use when the user asks to set up one or more git worktrees for parallel work — "create a worktree", "set up worktrees for these branches", "spin up parallel branches". Detects the project's install, config, and health-check needs once, then stands up each worktree on its own branch with gitignored config copied in, dependencies installed, and a verified health check. Not for merging finished worktrees; use worktree-merge.
version: 0.2.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - bash
  - write
  - ask_user
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/worktree-create
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/worktree-create
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - git-master
---

# Worktree Create

Stand up isolated git worktrees, each on its own branch, genuinely ready to
develop and validate in: config copied, dependencies installed, health
check passed. Everything is detected from this repo; nothing about the
stack is assumed.

## Step 1 — Branch list

The user's arguments are the branch list. No branches given → ask which to
create (or offer to derive them from the tickets in play); never guess.

## Step 2 — Detect the project setup ONCE

Read `references/worktree-setup.md` — the checklist of what a fresh worktree
needs and how to detect each piece. From this repo, determine one time:

- install command(s), from manifests and lockfiles (one per package in a
  monorepo);
- gitignored env/config files to copy (or the repo's `.worktreeinclude` as
  the source of truth);
- the health-check command, preferring exactly what CI runs (read
  `.github/workflows/*`, Makefile, manifest scripts) — a health endpoint if
  the app has one, else build/typecheck/test smoke;
- a base port, only if the health check starts a service; worktree N gets
  `base + N` so parallel servers never collide.

Worktree root is `worktrees/<branch>`, gitignored. If `worktrees/` is not
ignored, add it to `.gitignore` first.

## Step 3 — Set up each worktree sequentially

For each branch, in order:

1. `git worktree add worktrees/<branch> -b <branch>` off the intended base
   (default branch for clean trees; current HEAD only if the user wants
   in-progress work carried).
2. Copy the detected gitignored config/secrets in, verifying each with
   `git check-ignore <file>` before copying — a tracked file must never be
   duplicated.
3. Run the detected install command(s) inside the worktree.
4. Run any generate/build step the app needs to boot; skip if none.
5. Run the health check (on the assigned port when a service starts); stop
   any server you started afterwards.
6. Record: path · branch · deps installed · health PASS/FAIL · errors.

A failed step fails that worktree; continue with the rest and report the
failure. Do not mark a worktree ready that did not pass its health check.

## Step 4 — Report

Print the per-worktree table (path · branch · deps · health · port), a
`N worktree(s) ready, M failed` line, the next step (start work in each),
and the cleanup reminder: `git worktree remove worktrees/<branch>` once a
branch is merged. Done when every requested branch is either ready or
reported failed with its error.

## Red flags

- Assuming npm/pytest/anything instead of detecting from the repo.
- Copying a file into the worktree without `git check-ignore` proving it is
  untracked config.
- Reporting a worktree ready with a failed or skipped health check.
- Two parallel services fighting over one port.
