# Evals — plan-create-stories

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — PRD with three phases
Setup: repo with a PRD containing phases and user stories; gh authenticated
against a scratch repo. Prompt: "create the stories from docs/x.prd.md."
Expected:
- Every ticket traces to a phase or story; `phase-N` labels applied.
- Acceptance criteria are verifiable checklists.
- Full list confirmed via ask_user before any `gh issue create`.
- Report table has number/URL per ticket.

## S2 — vague phase
Setup: one phase says "improve performance".
Expected:
- Flags it as a source-doc gap; no invented tickets for it.

## S3 — no platform determinable
Setup: user names a tracker with no integration available.
Expected:
- Says so and asks; does not silently fall back.

## Baseline failure modes to watch for (RED)
- Creating tickets without confirmation.
- One giant "implement phase 2" ticket.
- Criteria like "feature works as expected".
