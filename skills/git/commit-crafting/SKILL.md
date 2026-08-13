---
name: commit-crafting
description: Use when the user asks to commit the current work — "commit this", "make a commit", "commit what we did" — and the changes are complete. Stages reviewed files, writes one atomic conventional-tagged commit, and reports what changed. Local commit only; never pushes. Not for opening a PR; use create-pr.
version: 0.2.0
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
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/commit-crafting
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/commit-crafting
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - coder
    - git-master
---

# Commit Crafting

Create exactly one atomic commit for the current uncommitted work, then stop.
Never push, tag, or open a PR from this skill.

## Step 1 — Project conventions win

Check the project instruction file (`CLIO.md`, `AGENTS.md`, or `CLAUDE.md`)
for commit-message rules: format, tags, scope conventions, sign-off. Whatever
it specifies overrides the defaults below.

## Step 2 — See everything before staging anything

Use `git` (op=status, op=diff) when available, else:

```bash
git status --porcelain
git diff HEAD
```

Read the untracked list file by file. Exclude from staging: secret-shaped
files (`.env*`, keys, credentials), build artifacts, scratch files, and
anything the user did not work on. If the tree mixes unrelated changes, say
so and ask whether to commit all of it or only the task's files — never
guess an atomic boundary the user has not drawn.

## Step 3 — Stage and commit

Stage by explicit path (`git add <paths>`), not `git add -A`. Write the
message as `<tag>: <what changed and why, one line>` with a tag that matches
the work: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. The message
describes the behavior change, not the file list. Commit once.

If the commit fails (hooks, signing), report the exact error and stop; do
not bypass hooks with `--no-verify` unless the user says to.

## Step 4 — Report

Done when `git log -1 --stat` shows the commit and you have printed:

- **What changed**: 3-6 sentences for a developer skimming the log — the
  problem solved and the key touch points.
- **Agent-layer changes**: only if files under `.claude/`, `.clio/`,
  `skills/`, or the project instruction files changed — one line per file on
  what evolved. Omit the section entirely otherwise.

## Red flags

- `git add -A` with unreviewed untracked files present.
- A commit message that lists files instead of naming the change.
- Two unrelated changes in one commit because asking felt slow.
- Any push, tag, or remote operation.
