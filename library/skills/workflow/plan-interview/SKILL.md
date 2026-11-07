---
name: plan-interview
description: Stress-tests a plan, design, or idea through a phased one-question-at-a-time interview before code is written, ending in a compact decision log. Not for a multi-perspective debate; use design-council.
triggers:
  - review this plan through an interview
  - interview me about this plan
  - stress-test this design
  - poke holes in this idea
  - clarify this plan one question at a time
version: 0.5.5
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - find
  - git
  - context
  - code_nav
  - ask_user
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/workflow/plan-interview
  audit: pass
  model-size: large
---

# Plan Interview

Run a rigorous, repo-aware interview that turns a vague plan into explicit
decisions. The point is not to interrogate for sport; it is to surface hidden
branches before anyone writes code.

## Arguments

When it is unclear what the subject is, or whether a named file, doc, or repo
path is a separate argument, read references/arguments.md.

In a headless run `ask_user` is not registered and nobody will reply: read
references/headless-steps.md before Phase 0 and work every phase through Step 5's
decision log in this turn. Never end a turn on an open question.

The phase map below is the plan; do not open a task list for it. `tasks` and
`bash` sit outside this skill's tool surface and are refused: inspect with `read`,
locate with `find` or `ls`, and check repo state with the `git` tool.

## Operating Contract

- In a live session, use `ask_user` for the interview and actually wait for
  the user's answer between rounds.
- For every interview round, call `ask_user` with `mode: "single_question"` and
  exactly one question.
- On the first ask for a normal plan-interview run, set `max_rounds` to a bounded
  value, usually `12` and at most `16` unless the user explicitly asked for a
  very deep interview, and complete the interview before hitting it.
- Put your recommended answer first when options are natural. Include 2-3 real
  alternatives with short tradeoff descriptions.
- The user answers in natural language. You translate answers into compact
  decision keys and rationale when you call `ask_user` with `action: "complete"`.

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
| 5 | Delivery: first slice, done-when checks, deferrals, handoff target (`prd`, `sprint-plan`, or direct implementation) | Review then complete |

## Workflow

### Step 1 - Scan

Read what the user already gave you. If the task references files, plans, code,
tests, or project conventions, inspect them before asking. Prefer
`context(scope="workspace")`, `grep`, `read`, `code_nav` (symbol and call-graph
lookups), and codewiki tools over guessing. Use the `git` tool (`status`,
`log`, not shell `git`) when the plan references repo state: recent
history, uncommitted changes, what "decided" actually means for this repo
right now.

Privately build a phase map: known facts, assumptions worth challenging, missing
decisions, dependencies between decisions, and likely deferrals and why they might
be safe.

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

Always resolve root decisions before leaves, in the Question Priority order:
when several questions are possible, read references/question-guide.md.

### Step 3 - Ask One Question

Each `ask_user` round has one stable `header` and one concrete question, with no
multi-part wording hidden inside it. When a draft question might be multi-part, read references/question-guide.md.

If an answer is vague, ask a follow-up on the same branch. Do not jump to a new
branch while the current one is still unresolved.

When a headless run reaches Step 3 or Step 4, read references/headless-steps.md.

### Step 4 - Respect Stop Signals

This step applies to a live session with a real operator. Stop immediately
when the user says "stop", "enough", "later", "done", "next time", or cancels
the modal. Do not ask another question to confirm stopping.

If you have enough decisions to be useful, call `ask_user` with
`action: "complete"`. When you build that call, read references/output-formats.md.

Then provide the decision log. If the stop happened before enough context,
state the partial decisions and the next unresolved root question.

### Step 5 - Complete

In a live session, close with `ask_user` `action: "complete"` and a compact
`decisions` array before final prose. In a headless run, skip straight to the
decision log. Write the final decision log: when you write it, read
references/output-formats.md for its format.

## Before Finishing

When the user defers to you, two choices are both viable, a decision could wait,
or the plan is too vague to slice, read references/decision-rules.md. Before
ending the turn, read references/red-flags.md and check this run against it.
