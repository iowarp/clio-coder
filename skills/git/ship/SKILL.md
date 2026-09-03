---
name: ship
description: "Ships finished work: writes one reviewed atomic commit, keeps maintainer branches local, or pushes a contributor branch to their fork and opens a PR only on explicit intent. Not for producing the change; use fix-issue."
triggers:
  - ship this
  - commit this
  - commit and open the PR
  - push and open a pull request
  - get this up for review
version: 0.4.0
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
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/git/ship
  audit: pass
  provenance: designed
  eval-status: smoke-checked
  model-size: any
  agents:
    - main
    - coder
    - git-master
---

# Ship

Move finished, verified work out as one atomic commit. In a maintainer clone
whose canonical remote must contain only `main`, topic and release-candidate
branches stay local for gated integration. A contributor pushes to their own
fork and opens a PR into the canonical repository. Never push with uncommitted
changes, never push a working branch to a canonical-main-only remote, and never
open a PR the user did not ask for. Invoking ship for "commit this" means
commit only; any push and PR require explicit intent.

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

## Step 3 — Classify remotes and gate publication

Detect the canonical repository and base branch from project instructions,
`gh repo view`, and remote URLs. In a contributor clone, `origin` normally
names the contributor's fork and `upstream` the canonical repository; do not
assume either name. In a maintainer clone, `origin` may be canonical.

| State | Action |
|---|---|
| On the base branch | STOP: the work needs its own branch first. |
| Uncommitted changes remain | STOP: commit or set them aside explicitly. |
| No commits ahead of the fetched canonical base | STOP: nothing to ship. |
| Canonical remote is main-only and no contributor fork remote exists | Commit only; do not push the local branch. Report it ready for local integration. |
| Proposed push remote is the canonical main-only repository | STOP: add/select the contributor's fork instead. |
| An open PR already exists for this branch | STOP and print its URL. |
| A merged PR exists and the user asked for closeout | Continue to Step 6 with its merge commit as evidence. |
| A closed, unmerged PR exists | STOP and print its URL and state. |

Every STOP is final for this run: report the reason and end.

## Step 4 — Contributor fork push and PR

Only contributors take this path. Push the topic branch to the verified fork
remote with an explicit refspec, then open the PR against the verified
canonical repository and base. Never use a bare `git push -u origin HEAD`
because `origin` may be canonical. The effective shape is:

```text
git push -u <fork-remote> refs/heads/<topic>:refs/heads/<topic>
gh pr create --repo <canonical-owner/repo> --base <base> --head <fork-owner>:<topic>
```

Body from `.github/PULL_REQUEST_TEMPLATE.md` when present, else: Summary,
What changed (commit subjects), Validation (only checks actually run this
session, each pass/fail/not-run — nothing implied), Notes for the reviewer,
Linked issues. `--draft` when the user says it is not review-ready.

## Step 5 — Report

Done when the user has the PR number and URL, base ← head, and one line on
what review happens next. Merging is a human decision; the ordinary shipping
loop ends at an open PR.

## Step 6 — Close out merged work

This is a later re-entry, never something inferred while opening the PR. When
the user asks to clean up after merge:

1. Run `git fetch --prune`, inspect the PR's merged state, and record its merge
   or squash commit on the base branch. A matching subject is not proof.
2. Inspect the source worktree's tracked, untracked, and ignored state. If any
   non-rebuildable artifact remains, stop and ask whether to preserve it.
3. Remove a registered worktree with `git worktree remove <path>`, never raw
   filesystem deletion. `--force` requires explicit approval to discard the
   remaining state.
4. Delete the local source branch. For a contributor PR, delete the merged
   branch from the contributor's fork when authorized. A canonical-main-only
   remote must never have had the topic branch.
5. Report remaining worktrees, local branches, stashes, local-only tags, and
   canonical remote heads; the expected canonical head set is only the base.

Maintainer release candidates are local-only compact branches (`v043`), while
dotted names (`v0.4.3`) are reserved for immutable release tags. Gate the
candidate, fast-forward local `main` with `--ff-only`, recheck fetched
`origin/main`, and push only the fully qualified `main` ref with explicit
maintainer authorization. After CI succeeds, push only the fully qualified
annotated tag. Verify its peeled commit, then delete the local candidate.
Never push a release-candidate branch or delete/move a published tag.

## Red flags

- `git add -A` with unreviewed untracked files present.
- A push that left uncommitted changes behind.
- Pushing a topic or release-candidate branch to a canonical-main-only remote.
- Assuming a remote named `origin` is the contributor's fork.
- A PR nobody asked for, or a Validation section claiming checks never run.
- Two unrelated changes in one commit because asking felt slow.
- A commit message that lists files instead of naming the change.
- Treating a similar subject or patch id as proof that a PR merged.
- Deleting a remote branch, published tag, stash, or local artifact under an
  approval that covered only local branch cleanup.
