---
name: branch-closeout
description: Proves merged work on the canonical base, inspects and removes associated worktrees through Git, deletes local branches safely, and audits surviving repository refs. Not for creating worktrees; use worktree-create. Not for integrating branches; use worktree-merge.
triggers:
  - close out this branch
  - clean up merged branch
  - remove merged worktree
  - closeout branch
  - branch-closeout
version: 0.1.0
license: Apache-2.0
compatibility: git >=2.30.0, gh CLI >=2.0.0 (optional for remote PR verification), POSIX-compatible shell
allowed-tools:
  - read
  - grep
  - ls
  - git
  - bash
  - tasks
  - ask_user
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/branch-closeout
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
  agents:
    - main
    - git-master
---

# Branch Closeout

Safely tear down local scaffolding after work has merged. Closeout proves landing evidence before removing any ref or worktree, distinguishes canonical and fork remotes, protects dirty or ignored worktree state, and audits surviving repository references.

See [the closeout checklist](references/closeout-checklist.md) for detailed commands and edge cases.

## Arguments

Arguments are passed in the user invocation message. Interpret them structurally from the prompt:

```text
/skill:branch-closeout [--canonical remote] [--base branch] [--delete-fork-branch] <branch...>
```

### Examples
- `/skill:branch-closeout feat/worker-profiles`
- `/skill:branch-closeout --base main --canonical upstream fix/session-leak`
- `/skill:branch-closeout --delete-fork-branch feat/issue-99`

### Positional Arguments
- `<branch...>`: One or more local branch names to close out.
  - Required. If missing, prompt the user for the branch name; never guess.
  - Must be valid ref names (`git check-ref-format --branch <branch>`).

### Options
- `--canonical <remote>`: Remote name of the canonical upstream repository.
  - Default: detected canonical remote from repository URLs or `upstream` / `origin`.
- `--base <branch>`: Base branch on which the changes landed.
  - Default: detected canonical default branch (e.g. `main` or `master`).
- `--delete-fork-branch`: Delete the corresponding branch on the contributor's fork remote after local closeout.
  - Default: `false`.
  - Refusal Guard: If the fork remote resolves to the canonical repository, this option is strictly refused.

### Unknown Arguments and Validation
- Unknown flags must be rejected with an error; do not pass unknown options to git or gh.
- Ref names and paths must be validated before execution. Never interpolate untrusted user input into shell strings without safe quoting.

## Step 1 — Detect Remotes and Policy

1. Identify `<canonical>` remote: inspect `git remote -v` and `gh repo view`.
2. Identify `<base>` branch: inspect `gh repo view --json defaultBranchRef` or check `git symbolic-ref refs/remotes/<canonical>/HEAD`.
3. Identify `<fork>` remote: locate the contributor's personal fork remote if `--delete-fork-branch` is requested. If `<canonical>` is the only remote, fork deletion is not applicable.

## Step 2 — Prove Integration

Never delete a branch based on similar commit subjects or author names alone.
For each `<branch>`:
1. `git fetch --prune <canonical>`
2. **Direct ancestry**: Check if the branch is fully merged:
   ```bash
   git merge-base --is-ancestor <branch> <canonical>/<base>
   ```
3. **Squash or Cherry-Pick**: If ancestry fails, verify if a squash merge landed via PR:
   ```bash
   gh pr view <branch> --repo <canonical> --json state,mergedAt,mergeCommit
   ```
   Confirm that the reported `mergeCommit.oid` is present on `<canonical>/<base>`.
4. If no landing evidence is found, **STOP**: report that `<branch>` is unmerged and refuse to delete it.

## Step 3 — Inspect Worktree State

1. Query registered worktrees via `git worktree list --porcelain`.
2. If a worktree is registered for `<branch>`:
   - Check for uncommitted tracked modifications: `git -C <path> status --porcelain`
   - Check for untracked and ignored artifacts: `git -C <path> status --ignored --porcelain`
   - If dirty changes or non-rebuildable artifacts exist, prompt the user via `ask_user` before removal.
3. Remove the registered worktree with `git worktree remove <path>`.
   - Never use `rm -rf`.
   - Use `--force` only if the user explicitly approved discarding remaining uncommitted/untracked artifacts.

## Step 4 — Delete Branches Safely

1. Delete the local branch:
   ```bash
   git branch -d <branch>
   ```
2. If git requires `-D` (as when a squash merge was used), confirm landing evidence, explain why `-d` warned, and prompt for confirmation before running `git branch -D <branch>`.
3. If `--delete-fork-branch` is set and authorized:
   - Verify `<fork>` is not `<canonical>`.
   - Run `git push --delete <fork> refs/heads/<branch>`.
   - Never delete branches from `<canonical>`, and never delete `<base>`.

## Step 5 — Report Surviving State

Audit and output the complete survivor inventory:
- Remaining worktrees (`git worktree list`)
- Remaining local branches (`git branch`)
- Remaining stashes (`git stash list`)
- Local-only tags (`git tag -l` vs remote tags)
- Canonical remote heads (`git ls-remote --heads <canonical>`)

In a canonical-main-only repository, the expected canonical head set is strictly `refs/heads/<base>`. Report any extra heads as anomalies.

## Red Flags

- Deleting a branch without verifying ancestry or squash PR evidence on the canonical base.
- Deleting or attempting to delete canonical `main` or canonical remote branches.
- Using `rm -rf` instead of `git worktree remove`.
- Force-removing a dirty worktree without explicit user approval.
- Implicitly dropping stashes, local tags, or unrelated branches during cleanup.
