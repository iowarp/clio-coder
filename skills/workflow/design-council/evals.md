# Evals - design-council

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 - storage-format decision with real tradeoffs

Setup: a project checkpointing large arrays; prompt: "council: should we use
HDF5 or Zarr for our checkpoint format?"

Expected:

- Composes 3 to 5 perspectives from the topic (each with a name, stance,
  expertise, and a target to attack), not from a generic role menu.
- Dispatches perspectives as read-only workers (scout, researcher, or
  provenance recipes), parallel within a round.
- Round 2 responses address named points from the round 1 transcript.
- Disagreement is surfaced with its crux stated, not averaged away.
- Synthesis lists agreements, live disagreements with the crux,
  a recommendation, and preserved dissent, citing the transcript.
- Dispatch receipts exist linking statements to worker runs.

## S2 - consensus topic

Setup: prompt asks the council to debate a question with an obvious answer for
this repo (for example "should we hand-roll our own YAML parser or keep the
existing dependency?").

Expected:

- Round 1 comes back in agreement; the council stops there.
- Says explicitly that the council was not needed and returns the consensus.
- Does not run responses or convergence rounds, and does not manufacture
  friction.

## S3 - dispatch unavailable

Setup: dispatch is admission-denied or absent in the environment.

Expected:

- Falls back to inline sequential perspectives with the same round structure
  and synthesis format.
- Labels the result as degraded (single-model debate, no receipts).

## S4 - anti-trigger: plan stress-test

Setup: user says "poke holes in my plan" or wants their decisions interrogated
one at a time.

Expected:

- Refers to grill-me instead of convening a council.

## Baseline failure modes to watch for (RED)

- Generic personas (optimist, pessimist, devil's advocate) with no expertise
  or attack target.
- One blended essay of pros and cons instead of independent positions that
  respond to each other.
- No worker dispatch at all, or workers asked to edit files.
- A "balanced" synthesis that hides the crux of disagreement.
- Fabricated debate on a consensus topic to justify the ceremony.

## Observed live-smoke results

Run 2026-07-01/02, headless `clio run --skill` against a scratch fixture (an
MPI checkpointing module writing one raw npy per rank per step).

- Full council (atomic rename vs direct write): three bounded rounds, four
  topic-composed perspectives each dispatched as read-only `scout` workers
  (parallel within rounds, sequential between), receipts on every statement
  (exit 0, agentId scout), synthesis with agreements, a crux, and the
  Performance Engineer's dissent preserved and answered. Note the topic
  proved genuinely debatable, so full rounds were correct.
- Degraded fallback (HDF5 vs Zarr, run while the fleet target had model
  residency failures): the skill attempted a parallel `dispatch` first,
  observed worker failures in receipts, then ran the same rounds inline and
  labeled the result degraded exactly as the clause requires.
- Early termination (S2, zero-padded vs unpadded checkpoint filenames): the
  first draft of the skill ran full rounds on side-quibbles for two
  debatable-in-hindsight "consensus" topics; the composition and termination
  clauses were tightened to judge consensus on the decision question itself.
  With the shipped wording the council declared itself not needed before any
  dispatch, cited the rule, and returned the consensus with caveats. No
  manufactured friction.

## Smoke record (2026-08-13)

One representative scenario via `clio skills eval` against Nemo-3.5-Lightning
(30B local, llamacpp on mini), full-auto sandbox. NOT COMPLETED: treatment timed out at the 900s ceiling mid-council (serial perspectives). Needs a longer timeout or fewer personas for headless eval; skill was visibly working when cut.

Follow-up (2026-08-13, v0.3.0): Step 1 now makes three perspectives the
default and tells a headless run to use three and one round, which is the
blocker the timeout exposed. Not re-run, so `eval-status` stays
`scenarios-recorded`; the next campaign has to confirm the shortened council
fits the ceiling.
