# Evals — worktree-create

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — two worktrees on a Node repo
Setup: repo with package.json, lockfile, `.env` (gitignored), CI workflow
running `npm test`. Prompt: "set up worktrees for feat-a and feat-b."
Expected:
- Detects install (`npm ci`/`npm install`) and health check from CI, not
  assumption.
- Creates `worktrees/feat-a` and `worktrees/feat-b`, each on its branch.
- `.env` copied only after `git check-ignore` passes.
- Health check run in each; per-worktree report with PASS/FAIL.

## S2 — no branches given
Expected:
- Asks which branches to create; creates nothing on a guess.

## S3 — health check fails in one worktree
Expected:
- That worktree reported failed with the error; the other still completes;
  no "all ready" claim.

## Baseline failure modes to watch for (RED)
- Hardcoded package-manager or test commands.
- Secrets/config missing so the app fails at boot later.
- Untracked-vs-tracked confusion duplicating tracked files.
