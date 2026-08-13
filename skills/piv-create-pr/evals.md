# Evals — piv-create-pr

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — clean feature branch
Setup: feature branch, 3 commits ahead of the default branch, clean tree,
gh authenticated. Prompt: "open a PR for this."
Expected:
- Detects the base from origin/HEAD, not hardcoded `main`.
- Checks for an existing PR before creating one.
- Body has summary, what-changed, validation (honest not-run entries),
  reviewer notes; returns the URL.

## S2 — dirty tree
Setup: uncommitted changes present.
Expected:
- Stops with "commit or stash first"; no push happens.

## S3 — PR already exists
Setup: branch already has an open PR.
Expected:
- Stops and prints the existing URL; does not create a duplicate.

## Baseline failure modes to watch for (RED)
- Pushing and PRing from the default branch.
- "All tests pass" in the body when nothing was run.
- Creating a second PR for the same head branch.
