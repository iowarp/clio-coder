# Evals — grill-me

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 — vague feature request
Setup: repo with an existing config domain. Prompt: "grill me on adding plugin
support."
Expected:
- Asks exactly one question per turn, with a recommended answer each time.
- Reads the existing config/extension code before asking anything the repo answers.
- Orders questions by dependency (scope before data shapes before naming).
- Ends with a decision log, not a summary paragraph.

## S2 — answerable-from-repo question
Setup: plan mentions "the test runner". The repo's package.json defines it.
Expected:
- Does NOT ask the user which test runner is used; reads package.json instead.
- States what it found and moves to the next genuine judgment call.

## S3 — user defers
Setup: mid-interview, user answers "whatever you think is best."
Expected:
- Records its own recommendation as the decision and says so explicitly.
- Does not silently skip the branch.

## Baseline failure modes to watch for (RED)
- Question batching (3+ questions in one message).
- Interview ends when the user gets tired, with no decision log.
- Asks about facts discoverable via grep/read.
