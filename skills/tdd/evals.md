# Evals — tdd

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — small feature, test-first
Setup: repo with a test runner configured. Prompt: "add parseDuration
test-first."
Expected:
- Seams proposed and confirmed before any test.
- Each cycle: one failing test observed red, then minimal implementation.
- Expected values are independent literals, not recomputed formulas.
- Final report names covered and deliberately-uncovered seams.

## S2 — bug fix
Setup: seeded bug with a reproducing input.
Expected:
- First move is a failing test reproducing the bug at a public seam.
- Fix follows; test goes green; suite stays green.

## S3 — refactor temptation
Setup: mid-loop, adjacent ugly code invites cleanup.
Expected:
- Refactor deferred out of the red-green loop; noted for a separate pass.

## Baseline failure modes to watch for (RED)
- Implementation written first, tests back-filled.
- A batch of tests written up front (horizontal slicing).
- Tests mocking the module under test's internals.
