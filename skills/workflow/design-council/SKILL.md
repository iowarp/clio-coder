---
name: design-council
description: Use when a design decision has real tradeoffs and needs several expert perspectives that challenge each other before code is written, such as architecture choices, API shapes, storage formats, parallelization strategies, or dependency decisions. Quick mode runs a single round for a fast perspective check. Triggers on "council", "debate this", "multiple perspectives", "weigh the options", "what would experts say". Not for a one-question-at-a-time interrogation of a plan; use grill-me. Not for splitting implementation work across workers; use dispatch directly.
triggers:
  - convene a design council
  - debate this design
  - get multiple expert perspectives
  - weigh the architecture options
  - what would experts say
version: 0.3.2
license: Apache-2.0
allowed-tools:
  - dispatch
  - read
  - grep
  - find
  - ls
  - context
  - code_nav
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/workflow/design-council
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: large
  agents:
    - scout
    - researcher
    - provenance
---

# Design Council

Run a bounded multi-perspective debate on a real design decision. The council
surfaces the crux of a disagreement before code commits to one side. It is not
a ritual: if experts would agree, do not convene it.

## Step 0 — Check the question is contested

Before composing anyone, ask: would credible experts actually disagree on the
answer? If every perspective you can imagine picks the same option and differs
only in caveats, stop here. Say the council is not needed, give the consensus
answer with the caveats attached, and end.

## Step 1 — Compose perspectives

Derive perspectives from the topic itself, never from a generic role menu.
Three is the default and the right number for almost every decision. Go to
four or five only when the decision genuinely has that many independent
stances, and never headless: each perspective is a worker run, and a model
that dispatches the round serially instead of in parallel turns five
perspectives into five sequential runs. If you are running without a user to
wait on you, use three perspectives and one round.

Each perspective gets:

- a name and a stance (what it argues for);
- the expertise it argues from;
- the specific thing it must attack in the other positions.

Example, "HDF5 vs Zarr for checkpoints": an HPC I/O veteran defending
single-file HDF5 on parallel filesystems; a cloud-native engineer arguing
object-store-first Zarr; an operator worried about tooling and recovery; a
numerics lead demanding bit-exact round-trips. Never "optimist, pessimist,
pragmatist".

## Step 2 — Dispatch each perspective as a read-only worker

The recipe fixes capability; your task prompt supplies the persona. Pick per
perspective from the read-only recipes in the live catalog:

- `scout`: stance grounded in this repository's code.
- `researcher`: stance leaning on external docs, standards, or papers.
- `provenance`: stance arguing from runtime evidence and receipts.

Run one round's perspectives in parallel: one `dispatch` call with the round's
task prompts in `tasks` and `mode="parallel"`. Rounds are sequential. Each
task prompt carries the persona block, the decision context, and the full
transcript so far. Workers never edit files; the debate is analysis only.
Dispatch receipts link every statement to a worker run.

## Step 3 — Run the rounds

1. **Positions.** Each perspective states its position, its strongest
   argument, and what evidence would change its mind.
2. **Responses.** Each perspective receives the round 1 transcript and must
   respond to named points from the others: concede, rebut, or sharpen.
3. **Convergence.** Each perspective states what it now agrees with, where it
   still disagrees and why that crux is the crux, and its final
   recommendation.

**Quick mode** (user asked for a light pass): round 1 plus synthesis. No
responses round.

**Early termination.** After round 1, judge disagreement on the decision
question itself, not on side conditions. If every position picks the same
option and differs only in caveats, toggles, or requests to measure later,
that is consensus: skip rounds 2 and 3, report that the council was not
needed, and return the consensus with caveats. Never manufacture friction.

## Step 4 — Synthesize

After the last round, you (the orchestrator) write:

```markdown
## Council Synthesis - <decision>

Agreements:
- <point> (all perspectives, round <n>)

Live disagreements:
- <point> - crux: <the fact or value judgment that would settle it>

Recommendation:
- <choice> because <reasoning grounded in the transcript>

Dissent preserved:
- <perspective>: <the objection that survives the recommendation>
```

Cite the transcript (perspective and round) for every claim. Done when every
synthesis line has a citation and the recommendation names its crux.

## Degraded mode

If dispatch is unavailable or admission-denied, run the same rounds inline:
write each perspective's contribution yourself, sequentially, same round
structure and synthesis format. Label the output as degraded (single-model
debate, no receipts).

## Boundaries

Stress-testing a plan by questioning its author one question at a time is
`grill-me`, not a council. Splitting implementation work across workers is
plain dispatch, not a council. Council workers analyze; they never build.
For a lightweight built-in alternative with no skill workflow, the TUI
ships `/council [--roster] [--rounds] [--synthesis judge|vote|none]`; use
this skill when the debate needs the full round structure and receipts.

## Red Flags

- Perspectives named "optimist" and "pessimist" (role menu, not topic).
- More than five perspectives, or debate rounds beyond three.
- A synthesis that averages positions instead of naming the crux.
- Manufactured disagreement on a settled question.
- A worker asked to edit files as part of the debate.
- Synthesis statements that no transcript line supports.
