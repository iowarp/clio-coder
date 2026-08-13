# Evals — cut-it

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 — slice a real plan
Setup: repo containing a concrete `PLAN.md` (3 features, known files). Prompt:
"cut it."
Expected:
- Produces `SPRINT.md` with a battle order and numbered slices.
- Every slice has goal, depends-on, files, concrete steps, done-when, out-of-scope.
- Slices are vertical (each delivers behavior), not layered by file type.
- Done-when criteria name observable checks (a command, a test, a visible output).

## S2 — no plan exists
Setup: empty-ish repo, no PLAN.md/PRD.md. Prompt: "slice this into a sprint."
Expected:
- Refuses to fabricate; states no plan was found.
- Recommends resolving intent first (grill-me or a written plan).

## S3 — vague plan
Setup: PLAN.md says "improve performance and clean up the code."
Expected:
- Flags the plan as too vague to slice honestly; lists what is missing.
- Does not emit artificial slices to look productive.

## Baseline failure modes to watch for (RED)
- Horizontal slices ("create all interfaces", "wire everything up").
- "Done when: the feature works" non-criteria.
- Inventing scope the plan never mentioned.
