---
name: resolve-merge-conflicts
description: Use when a git merge, rebase, or cherry-pick is stopped on conflicts and they need resolving — "fix these conflicts", "finish the merge", conflict markers in files. Resolves by reconstructing both sides' intent from history, preserves both where possible, validates with the project's own checks, and completes the operation. Not for planning an integration of many branches; use worktree-merge.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - edit
  - ask_user
  - artifact
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/resolve-merge-conflicts
  audit: pass
  provenance: adapted
  origin: https://github.com/mattpocock/skills/tree/main/skills/engineering/resolve-merge-conflicts
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - coder
    - git-master
---

# Resolve Merge Conflicts

Conflicts are resolved from intent, not from picking the side that makes
the markers go away. The job ends with the merge or rebase completed and
the project's checks green.

## Step 1 — Map the state

```bash
git status
git log --oneline --left-right --merge 2>/dev/null || git log --oneline -10
git diff --name-only --diff-filter=U
```

Identify: which operation is in progress (merge, rebase, cherry-pick),
which branches or commits are involved, and every conflicting file.

## Step 2 — Reconstruct both intents

For each conflicting file, find why each side changed:

```bash
git log --oneline <ours>..<theirs> -- <file>
git log --oneline <theirs>..<ours> -- <file>
```

Read the commit messages; follow PR or issue references when the message
alone does not explain the change. A hunk resolved without knowing both
sides' intent is a guess wearing a merge commit.

## Step 3 — Resolve each hunk

- Both intents compatible → preserve both.
- Genuinely incompatible → pick the side matching the merge's stated goal
  and record the trade-off for the report; when the goal itself does not
  decide it, ask the user rather than choosing silently.
- Never invent new behavior in a resolution: the merged code does only
  what one or both sides already did.
- Do not `--abort` to escape a hard conflict; abort only if the user
  decides the operation itself was wrong.

Search for leftover markers before moving on:
`grep -rn "<<<<<<<\|>>>>>>>" <conflicting files>` must return nothing.

## Step 4 — Validate

Discover the project's own checks (CI workflow, manifest scripts,
Makefile) and run them: typecheck, then tests, then lint/format. Fix
anything the merge broke — the resolution is not done at "markers gone",
it is done at "checks green".

## Step 5 — Complete the operation

Stage the resolved files and commit the merge; for a rebase or
cherry-pick, `git rebase --continue` / `git cherry-pick --continue` and
repeat from Step 1 for each further stop until the operation reports
complete.

Done when the operation has fully finished, checks are green, and the
report lists each conflict with which intent(s) survived and any recorded
trade-offs.

## Red flags

- Taking `--ours`/`--theirs` wholesale without reading either side.
- A resolution that introduces logic neither side had.
- Committing with conflict markers still in a file.
- Declaring done without running the project's checks.
