---
name: grill-me
description: Use when the user wants a plan, design, or idea stress-tested through a phased one-question-at-a-time interview before any code is written, or when intent is too ambiguous to plan from. Scans available context first, reviews known facts, fills missing decisions, respects stop signals, and ends with a compact decision log. Triggers on "grill me", "interview me", "stress-test this plan", "poke holes in this".
version: 0.3.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - glob
  - ls
  - find
  - git_status
  - git_diff
  - git_log
  - workspace_context
  - entry_points
  - where_is
  - find_symbol
  - ask_user
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/grill-me
audit: pass
---

# Grill Me

Run a rigorous, repo-aware interview that turns a vague plan into explicit
decisions. The point is not to interrogate for sport; it is to surface hidden
branches before anyone writes code.

This workflow is inspired by phased context-review interviews: scan first,
decide which areas are review versus fill, ask one question at a time, persist
the structured decisions through `ask_user`, and close with a decision log.

## Operating Contract

- Use `ask_user` for the interview whenever it is active.
- For every interview round, call `ask_user` with `mode: "single_question"` and
  exactly one question.
- On the first ask for a normal grill-me run, set `max_rounds` to a bounded
  value, usually `12` and at most `16` unless the user explicitly asked for a
  very deep interview.
- Put your recommended answer first when options are natural. Include 2-3 real
  alternatives with short tradeoff descriptions.
- The user answers in natural language. You translate answers into compact
  decision keys and rationale when you call `ask_user` with `action: "complete"`.
- If `ask_user` is unavailable, ask in plain text, still one question at a
  time, and keep an internal decision log.

Example first ask:

```json
{
  "action": "ask",
  "mode": "single_question",
  "max_rounds": 12,
  "questions": [
    {
      "header": "Primary Outcome",
      "question": "What should this plan optimize for first?",
      "options": [
        {
          "label": "Smallest useful slice",
          "description": "Ship a narrow version quickly and defer broader polish."
        },
        {
          "label": "Clean foundation",
          "description": "Spend more time on architecture before user-visible behavior."
        },
        {
          "label": "Risk retirement",
          "description": "Prototype the uncertain part before committing to scope."
        }
      ]
    }
  ]
}
```

## Phase Map

Walk phases in order unless the user names a narrower target. Do not skip the
scan. A phase can be "review" when context already contains a plausible answer
or "fill" when the decision is genuinely missing.

| Phase | Scope | Default mode |
|---|---|---|
| 0 | Scan available context: user prompt, named files, repo structure, git state, existing plans/specs | No questions unless the subject is missing |
| 1 | Frame: user, problem, outcome, non-goals, success criteria | Fill or review |
| 2 | Current state: existing code, constraints, conventions, integration points, prior attempts | Review |
| 3 | Shape: data model, API/UX surface, ownership boundaries, naming, compatibility | Fill |
| 4 | Risk: failure modes, migrations, rollout, test strategy, observability, reversibility | Fill |
| 5 | Delivery: first slice, done-when checks, deferrals, handoff target (`prd`, `cut-it`, or direct implementation) | Review then complete |

## Workflow

### Step 1 - Scan

Read what the user already gave you. If the task references files, plans, code,
tests, or project conventions, inspect them before asking. Prefer
`workspace_context`, `grep`, `read`, and codewiki tools over guessing.

Privately build a phase map:

- known facts
- assumptions worth challenging
- missing decisions
- dependencies between decisions
- likely deferrals and why they might be safe

Never spend the user's attention on facts that the repo answers. If you found
the answer in code, summarize it briefly and ask only whether it should remain
true.

### Step 2 - Choose Review Or Fill

For each phase:

- **Review mode**: context already has an answer. Present the finding in one or
  two sentences, then ask a targeted question such as "Is this still accurate?"
  or "Should we keep this constraint?"
- **Fill mode**: context is sparse or ambiguous. Ask the highest-leverage
  missing decision first.

Always resolve root decisions before leaves. Scope and success criteria come
before names, data fields, UI copy, test details, or task slicing.

### Step 3 - Ask One Question

Each `ask_user` round contains one question only:

- one stable `header`
- one concrete question
- recommended option first when options fit
- no multi-part wording hidden inside the question

Bad: "Who is this for, what should v1 include, and how should we test it?"

Good: "Which user should v1 optimize for first?"

If an answer is vague, ask a follow-up on the same branch. Do not jump to a new
branch while the current one is still unresolved.

### Step 4 - Respect Stop Signals

Stop immediately when the user says "stop", "enough", "later", "done", "next
time", or cancels the modal. Do not ask another question to confirm stopping.

If you have enough decisions to be useful, call:

```json
{
  "action": "complete",
  "summary": "Short interview closeout.",
  "decisions": [
    {
      "key": "primary_outcome",
      "value": "Smallest useful slice",
      "rationale": "The user prioritized fast validation over broad architecture.",
      "confidence": "high",
      "source_question": "What should this plan optimize for first?"
    }
  ]
}
```

Then provide the decision log. If the stop happened before enough context,
state the partial decisions and the next unresolved root question.

### Step 5 - Complete

Before final prose, call `ask_user` with `action: "complete"` and a compact
`decisions` array. Then write the final decision log:

```markdown
## Decision Log - <topic>
1. <decision> - chosen over <alternative> because <reason>
2. ...

Deferred:
- <item> - safe because <reason>

Open risks:
- <risk or unresolved branch>

Recommended next step:
- <prd | cut-it | direct implementation> - <why>
```

## Question Priority

Use this ordering when several questions are possible:

1. User and problem being solved.
2. Primary success measure.
3. Explicit non-goals.
4. Existing constraints from repo or environment.
5. Data/API/UX boundary.
6. Failure modes and recovery.
7. Tests and done-when checks.
8. First implementation slice.
9. Naming and polish.

## Decision Rules

- If the user says "whatever you think", record your recommendation as the
  decision and say so.
- If two choices are both viable, choose the one that reduces irreversible
  work unless the user explicitly values speed or breadth more.
- If a decision is safe to defer, record why and what later signal will force
  it.
- If the plan is too vague to slice or implement, say that clearly and continue
  interviewing instead of fabricating certainty.

## Red Flags

- Asking multiple questions in one `ask_user` round.
- Asking about facts discoverable from the repo.
- Letting `ask_user` hit the round limit without completing the interview.
- Ending with a summary paragraph instead of the decision log.
- Treating cancellation as permission to keep asking.
