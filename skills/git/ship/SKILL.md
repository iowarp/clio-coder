---
name: ship
description: Use when finished work should leave the machine — "ship this", "commit and open the PR", "get this up for review". Stages reviewed paths, writes one atomic conventional commit referencing the issue, then pushes and opens the PR. Push and PR happen only on explicit intent; a bare "commit this" stops after the commit. Not for producing the change; use fix-issue.
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
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/ship
  audit: pass
  provenance: original
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - coder
    - git-master
---

# Ship

Move finished, verified work out: one atomic commit, then push and PR.
Two irreversibility gates govern the whole skill: never push with
uncommitted changes in the tree, and never open a PR the user did not ask
for. Invoking ship for "commit this" means commit only; push and PR
require the user's explicit intent, stated or asked.

## Step 1 — Project conventions win

Read the project instruction file (`CLIO-CODER.md`, `AGENTS.md`,
`CLAUDE.md`) for commit and PR rules: message format, tags, sign-off,
required footers, PR template. Whatever it specifies overrides the
defaults below.

## Step 2 — Commit

See everything before staging anything: `git status --porcelain`,
`git diff HEAD`, and the untracked list file by file. Exclude
secret-shaped files (`.env*`, keys, credentials), build artifacts, and
anything the user did not work on. A tree mixing unrelated changes is the
user's boundary to draw: ask, never guess.

Stage by explicit path — no `git add -A`. One atomic commit,
`<tag>: <what changed and why>` with a `fixes #N` / `refs #N` footer when
the work resolves a tracker issue. If hooks or signing fail, report the
exact error and stop; `--no-verify` only on the user's say-so.

If the user asked only to commit, report `git log -1 --stat` and end here.

## Step 3 — Gate the push

Detect the base branch; never hardcode `main`:
`git symbolic-ref refs/remotes/origin/HEAD`, else
`git remote show origin | grep 'HEAD branch'`, else ask.

| State | Action |
|---|---|
| On the base branch | STOP: the work needs its own branch first. |
| Uncommitted changes remain | STOP: commit or set them aside explicitly. |
| No commits ahead of base | STOP: nothing to ship. |
| A PR already exists for this branch | STOP and print its URL. |

Every STOP is final for this run: report the reason and end.

## Step 4 — Push and open the PR

`git push -u origin HEAD`, then `gh pr create` against the detected base.
Body from `.github/PULL_REQUEST_TEMPLATE.md` when present, else: Summary,
What changed (commit subjects), Validation (only checks actually run this
session, each pass/fail/not-run — nothing implied), Notes for the reviewer,
Linked issues. `--draft` when the user says it is not review-ready.

## Step 5 — Report

Done when the user has the PR number and URL, base ← head, and one line on
what review happens next. Merging is a human decision; the loop ends at an
open PR.

## Red flags

- `git add -A` with unreviewed untracked files present.
- A push that left uncommitted changes behind.
- A PR nobody asked for, or a Validation section claiming checks never run.
- Two unrelated changes in one commit because asking felt slow.
- A commit message that lists files instead of naming the change.
