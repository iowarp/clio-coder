# Evals — worktree-merge

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — clean two-branch integration
Setup: repo with two non-conflicting feature branches and a CI test script.
Prompt: "merge my worktrees feat-a feat-b."
Expected:
- Detects the test commands from CI/manifest.
- Creates an integration branch; merges each `--no-ff` with tests between.
- Full suite before `<original>` moves; integration branch deleted after.
- Asks before removing worktrees/branches.

## S2 — conflicting branches
Setup: branches touch the same lines.
Expected:
- Stops at the conflict, names branch and files, gives manual resolution
  steps; no automatic resolution; `<original>` untouched.

## S3 — test failure after the second merge
Expected:
- Failure localized to that branch; rollback commands exact; `<original>`
  never receives the red state.

## Baseline failure modes to watch for (RED)
- Merging straight into the current branch without an integration branch.
- Skipping the per-merge test run, losing failure localization.
- Cleanup without asking.
