---
name: piv-create-pr
description: Use when the user asks to push the current branch and open a pull request — "open a PR", "create the pull request", "ship this for review". Detects the base branch, gates on clean committed state, pushes, opens the PR with a structured body, and returns the URL. Requires the gh CLI and explicit user intent; never fires as an implied next step after a commit.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - ask_user
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/piv-create-pr
  audit: pass
  provenance: adapted
  origin: https://github.com/coleam00/skills/tree/main/.claude/skills/piv-create-pr
  eval-status: untested
  model-size: any
  agents:
    - main
    - git-master
---

# Create PR

Push the feature branch and open the pull request. Opening a PR is a
contribution: run this only on the user's explicit ask, never as your own
next step.

## Step 1 — Detect the base branch

Never hardcode `main`. In order:

1. A base the user named.
2. `git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'`
3. `git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}'`
4. Last resort: `main`.

Call the result `<base>`.

## Step 2 — Gate on git state

```bash
git branch --show-current
git status --short
git log origin/<base>..HEAD --oneline
gh pr list --head "$(git branch --show-current)" --json url
```

| State | Action |
|---|---|
| Currently on `<base>` | STOP: the work needs its own branch first. |
| Uncommitted changes | STOP: commit or stash before opening a PR. |
| No commits ahead of `<base>` | STOP: nothing to PR. |
| A PR already exists for this branch | STOP and print its URL. |
| Clean, ahead, no PR | Proceed. |

Every STOP is final for this run: report the reason and end.

## Step 3 — Gather the body

- PR conventions from the project instruction file (`CLIO.md`, `AGENTS.md`,
  `CLAUDE.md`) override the template below.
- Commits: `git log origin/<base>..HEAD --pretty=format:"- %s"`.
- Shape: `git diff --stat origin/<base>..HEAD`.
- Validation status: results from checks actually run this session; anything
  not run is stated as not run, never implied as passing.
- Linked ticket/issue refs from branch name and commit messages
  (`#123`, `Fixes #...`, tracker IDs).
- If `.github/PULL_REQUEST_TEMPLATE.md` exists, fill that instead of the
  default sections.

## Step 4 — Push and open

```bash
git push -u origin HEAD
gh pr create --base "<base>" --title "<tag>: <concise description>" --body "$(cat <<'EOF'
## Summary
<1-2 sentences: what this delivers>

## What changed
<commit summaries>

## Validation
- <check>: <pass/fail/not run>

## Notes for the reviewer
<intentional deviations and decisions, or "none">

## Linked
<issue/ticket refs, or "none">
EOF
)"
```

Use `--draft` when the user says the work is not review-ready.

## Step 5 — Report

```bash
gh pr view --json number,url,title,baseRefName,headRefName
```

Done when the user has: PR number and URL, base ← head branches, and a
one-line statement of what review comes next. The loop ends at an open PR;
merging is a human decision.

## Red flags

- Opening a PR nobody asked for.
- A Validation section claiming checks that were never run this session.
- Hardcoding `main` as the base.
- Pushing with uncommitted changes still in the tree.
