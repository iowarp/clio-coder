# INFRA — Batch 1 git skills blocked before they can be evaluated

- date: 2026-08-13T14:36:00Z
- loaded-set: Nemo-3.5-Lightning (unchanged, before and after; server is healthy,
  this is NOT an endpoint problem)
- affects: commit-crafting, review-changes, create-pr, investigate-issue,
  worktree-create, worktree-merge (Batch 1 items 1-6), plus
  resolve-merge-conflicts in Batch 2

## The blocker

Headless `clio run` cannot service a permission confirmation:

    src/entry/orchestrator.ts:1576
    "clio run cannot confirm permission requests; rerun interactively to approve this action."

The sandbox config is at the `clio configure` default, `autonomy: auto-edit`.
Under that level every mutating or exec-shaped git call is refused. Observed in
all three commit-crafting scenarios: `git status`, `git status --porcelain`,
`git -C <ws> status`, `git init`, `git --version`, and `which git` all returned
the refusal. Read-only shell (`ls -la`, `pwd`) went through fine, so this is
specifically the permission gate, not a broken bash tool.

Consequence: a git skill under eval cannot run git. Every Batch 1 git skill will
produce the same artifact commit-crafting just produced. Adding fixtures to
evals.md does not fix it, because the fixture only seeds the workspace; the
treatment run still cannot issue a git command against it.

## Two independent gaps, both need a decision

1. **Autonomy level.** Candidate fix is `autonomy: full-auto` in the sandbox
   settings.yaml. That is a semantics change to the eval, not a config typo, so
   I did not make it unilaterally. If the intent is "evals measure the skill's
   judgment, given tools that work", full-auto is right. If the intent is "evals
   measure behavior at the autonomy operators actually run", then the harness
   needs a non-interactive approval path instead and that is a code change the
   skillsmith owns.

2. **Missing fixtures.** Every commit-crafting scenario assumes repo state that
   an empty seed workspace cannot have. Same will be true of the other five git
   skills. Flagged per the brief; evals.md belongs to the skillsmith.

## Third finding, orthogonal, affects the WHOLE campaign

The judge is not obeying its grounding instruction. On S1 and S3 it scored the
skill's own SKILL.md prose as if it were observed behavior and returned pass on
five bullets where the transcript shows nothing happened. On S2, same run, it
correctly failed. So pass verdicts from Nemo-3.5-Lightning are not currently
trustworthy on their own; fail verdicts appear sound.

Tell: a spurious pass reason is phrased about the skill ("Skill confirms...",
"Skill requires...", "Skill rule: ..."), not about the run. I will keep checking
every pass against the transcript and will not report a bullet as passing on the
judge's word alone.

## Status

Holding. Not proceeding to review-changes (Batch 1 item 2) because it would spend
roughly 10 minutes of mini time to reproduce this same infra artifact, and the
brief makes model time the budget. Need a call on the autonomy question before
the git block of Batch 1 is worth running.

Non-git Batch 1 items (ast-grep item 7, herdr item 8) are not blocked by this and
can proceed independently if you want throughput in the meantime.
