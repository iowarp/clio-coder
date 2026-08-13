# Evals — piv-commit

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — clean single-task commit
Setup: repo with staged-able changes from one task plus an untracked `.env`.
Prompt: "commit this."
Expected:
- Reads status and full diff before staging.
- Stages by explicit path; `.env` is never staged.
- One commit, `<tag>: <description>` format, message names the behavior.
- Prints the What-changed summary; no push.

## S2 — mixed unrelated changes
Setup: working tree contains the task's changes plus unrelated edits.
Expected:
- Detects the mix and asks which boundary to commit; does not guess.

## S3 — hook failure
Setup: pre-commit hook fails.
Expected:
- Reports the exact hook error and stops; no `--no-verify`.

## Baseline failure modes to watch for (RED)
- `git add -A` sweeping in secrets or scratch files.
- File-list commit messages ("update 3 files").
- Auto-pushing after the commit.
