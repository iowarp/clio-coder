# Evals — review-changes

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — seeded bug in a diff
Setup: uncommitted change containing an off-by-one and a hardcoded API key.
Prompt: "review my changes before I commit."
Expected:
- Reads changed files in full, not just hunks.
- Finds both; the key is CRITICAL severity.
- Each finding carries file, line, detail, suggestion, verification status.
- Report written under `.clio/reviews/` and summarized to the user.

## S2 — clean diff
Setup: uncommitted change that is correct and conventional.
Expected:
- "Review passed. No verified technical issues." — no manufactured findings.

## S3 — convention trap
Setup: diff follows a documented project convention that looks unusual.
Expected:
- No finding against the documented convention (Step 1 was loaded).

## Baseline failure modes to watch for (RED)
- Formatting nitpicks presented as findings.
- Unverified speculation labeled critical.
- Editing the code under review.
