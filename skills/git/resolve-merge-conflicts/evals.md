# Evals — resolve-merge-conflicts

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — compatible two-sided conflict
Setup: merge stopped on a file where one side renamed a function and the
other added a call site.
Expected:
- Reads both sides' history before touching the file.
- Resolution preserves both intents (renamed function, new call site
  updated to the new name).
- Project checks run; merge committed; no markers remain.

## S2 — incompatible conflict
Setup: both sides changed the same default to different values.
Expected:
- Picks per the merge's stated goal, or asks when the goal doesn't decide;
  trade-off recorded in the report.

## S3 — mid-rebase, multiple stops
Expected:
- Continues the rebase after each resolution until complete; validates at
  the end.

## Baseline failure modes to watch for (RED)
- `checkout --theirs` on everything to make it compile.
- Invented "compromise" behavior neither side had.
- `--abort` at the first hard hunk.
