---
name: design-council
description: Use when a design decision has real tradeoffs and needs several expert perspectives that challenge each other before code is written, such as architecture choices, API shapes, storage formats, parallelization strategies, or dependency decisions. Runs a bounded debate through dispatched read-only workers, where each perspective states a position, then responds to the other positions, then the orchestrator synthesizes agreements, remaining disagreements, and a recommendation, with the transcript preserved through dispatch receipts and evidence. Quick mode runs a single round for a fast perspective check. Triggers on "council", "debate this", "multiple perspectives", "weigh the options", "what would experts say". Not for a one-question-at-a-time interrogation of a plan; use grill-me. Not for splitting implementation work across workers; use dispatch directly.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - dispatch
  - dispatch_batch
  - read
  - grep
  - glob
  - ls
  - workspace_context
  - code_nav
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/design-council
audit: pass
---

# Design Council

Run a bounded multi-perspective debate on a real design decision. The council
exists to surface the crux of a disagreement before code commits to one side;
it is not a ritual, and it is not needed when everyone would agree.

## Compose Perspectives

Derive 3 to 5 perspectives from the topic itself, never from a generic role
menu. Four sharp perspectives beat eight generic ones. Each perspective gets:

- a name and a stance (what it argues for)
- the expertise it argues from
- the specific thing it should attack in the other positions

For "HDF5 vs Zarr for checkpoints" that might be: an HPC I/O veteran defending
single-file HDF5 on parallel filesystems, a cloud-native engineer arguing
object-store-first Zarr, an operator worried about tooling and recovery, and a
numerics lead demanding bit-exact round-trips. Not "optimist, pessimist,
pragmatist".

Before composing anyone, ask whether credible experts actually disagree on the
answer. If every perspective you can imagine would pick the same option and
differ only in caveats, the council is not needed: say so, give the consensus
answer with those caveats attached, and stop. Do not build personas whose only
purpose is to oppose a settled question.

## Vehicle

Dispatch each perspective as a read-only worker. The recipe fixes capability;
your task prompt supplies the persona and the accumulated transcript. Pick per
perspective from the read-only recipes in the live catalog:

- `scout` for stances that should be grounded in this repository's code
- `researcher` for stances that lean on external docs, standards, or papers
- `provenance` for stances arguing from runtime evidence and receipts

Run one round's perspectives in parallel (several `dispatch` calls in one
message, or one `dispatch_batch`), rounds sequential. Workers never edit;
the debate is analysis. Each task prompt carries the persona block, the
decision context, and the full transcript so far. Dispatch receipts link every
statement to a worker run, so the debate is evidence, not vibes.

## Rounds

1. **Positions.** Each perspective states its position, its strongest
   argument, and what evidence would change its mind.
2. **Responses.** Each perspective receives the round 1 transcript and must
   respond to named points from the others: concede, rebut, or sharpen.
3. **Convergence.** Each perspective states what it now agrees with, where it
   still disagrees and why that crux is the crux, and its final
   recommendation.

Quick mode (fast perspective check, or the user asked for a light pass):
round 1 plus synthesis, no responses.

Early termination: judge disagreement on the decision question itself, not on
side conditions. If every round 1 position picks the same option and differs
only in caveats, toggles, or requests to measure later, that is consensus:
stop, say the council was not needed, and return the consensus with the
caveats attached. Do not run responses or convergence rounds, and never
manufacture friction to justify the ceremony.

## Synthesis

After the last round, the orchestrator (you) writes:

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

Cite the transcript for every claim (perspective and round). Dispatch receipts
and evidence bundles preserve the full worker outputs for audit.

## Degraded Mode

If dispatch is unavailable or admission-denied, run the same rounds inline:
write each perspective's contribution yourself, sequentially, keeping the same
round structure and synthesis format. Label the output clearly as degraded
(single-model debate, no receipts) so nobody mistakes it for independent
workers.

## Boundaries

A plan that needs stress-testing by questioning its author one question at a
time is grill-me, not a council. Splitting implementation work across workers
is plain dispatch, not a council. Council workers analyze; they never build.

## Red Flags

- Perspectives named "optimist" and "pessimist" (role menu, not topic).
- More than five perspectives, or debate rounds beyond three.
- A synthesis that averages positions instead of naming the crux.
- Manufactured disagreement on a settled question.
- A worker asked to edit files as part of the debate.
- Synthesis statements that no transcript line supports.
