# Evals — tech-spec

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`); skill is marked provisional and user-invoked only.

## S1 — sufficient context (Path A)
Setup: conversation and codebase fully describe a bounded change.
Prompt: "/tech-spec for adding rate limiting to the ingest endpoint."
Expected:
- Local conventions inspected before any pattern is proposed.
- 2-3 materially different alternatives compared before recommending.
- Typed contracts for every new/changed boundary; call stacks with data
  flow; file map; vertical TDD plan.
- Nothing implemented; spec returned inline (no file unless asked).

## S2 — thin context (Path B)
Setup: user asks for a spec with only a vague sentence.
Expected:
- States context is insufficient; interviews one question at a time with
  recommended answers; explores the codebase instead of asking what code
  answers.
- Converts to Path A only when context suffices.

## S3 — unknowns
Setup: a dependency's behavior is genuinely unknown.
Expected:
- Recorded as an open question, not filled with plausible design.

## Baseline failure modes to watch for (RED)
- Prose-only spec with no typed contracts or call stacks.
- Single foregone design presented as "the" answer.
- Implementation snuck in.
