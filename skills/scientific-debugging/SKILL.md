---
name: scientific-debugging
description: Use when debugging has stalled after the first obvious fix, when a failure spans multiple systems, when someone is about to try random changes, or when a scientific or HPC code produces wrong numbers, NaNs, nondeterministic results, or an unexplained performance regression. Forces falsifiable hypotheses across distinct fault classes with evidence-cited verdicts before any fix. Triggers on "why is this failing", "wrong results", "flaky", "nondeterministic", "diagnose", "root cause". Not for designing benchmarks or pre-registered experiments; use experiment-protocol.
version: 0.1.2
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - ls
  - find
  - git
  - context
  - code_nav
  - bash
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/scientific-debugging
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
---

# Scientific Debugging

Debug by falsification, not by trying fixes. A fix attempted before a confirmed
diagnosis is an experiment run without a hypothesis; when it "works" you have
learned nothing, and when it does not you have contaminated the evidence.

Anti-trigger: if the failure is a typo, a missing import, or an error message
that names its own cause, fix it directly and skip this workflow. The loop
below is for failures that survived the first obvious fix.

## The Loop

1. **Goal.** One sentence stating the observable "fixed" state. "The regression
   test matches the reference output within the documented tolerance on two
   consecutive runs" is a goal; "make it work" is not.
2. **Hypothesize.** Write at least three hypotheses. Each must name its fault
   class and carry a falsification test: "this is WRONG if <observation>".
   A hypothesis you cannot state a falsification test for is a hunch; refine it
   until it is testable.
3. **Rank.** Order by test cost times prior likelihood. Run the cheapest
   decisive test first, not the most interesting one.
4. **Test.** One variable per test. Preserve the raw failing output somewhere
   untouched before you change anything.
5. **Verdict.** Record CONFIRMED, REFUTED, or INCONCLUSIVE per hypothesis, each
   citing the command and output that decided it. A verdict without a citable
   observation is a guess.
6. **Iterate.** Refuted everything? Generate new hypotheses from what the tests
   revealed. Confirmed one? Only now edit code.

## Fault Classes

Hypotheses must span at least two distinct classes. Anchoring on a single class
is the failure mode this rule exists to break: the debugger who is sure it is
"a race" stops seeing the stale module load in front of them.

| Class | Typical suspects |
|---|---|
| numerics | accumulation order, mixed precision, tolerance misuse, fastmath |
| data | format or layout drift, HDF5/NetCDF/Zarr metadata, units, corruption |
| concurrency | races, MPI collective mismatch, nondeterministic reduction order |
| environment | modules, compiler flags, library versions, scheduler context |
| resources | memory pressure, filesystem quirks, quota, node differences |
| regression | a recent change; bisect the history instead of staring at code |

## Tiers

**Quick diagnosis** (default): the loop above, state held in conversation,
time-boxed at fifteen minutes of investigation. If the box expires without a
CONFIRMED verdict, escalate. Say that you are escalating; do not silently keep
poking.

**Structured investigation**: write an investigation file (for example
`INVESTIGATION.md` or `.clio/investigation-<slug>.md` via bash heredoc since
this skill does not edit code) containing the goal, baseline measurements of
the failing behavior, and one experiment per hypothesis with its verdict
condition committed *before* the experiment runs. Update verdicts as evidence
arrives. The file is the state; the conversation is commentary.

## Evidence Rule

The fix commit should cite the confirming observation, e.g. "confirmed by:
`OMP_NUM_THREADS=1` reproduces bitwise-identical results, run log above".
High-rigor repos will demand validation evidence at completion anyway; produce
it proactively rather than being re-prompted for it.

## Worked Example

Report: "after the refactor, results differ from reference by 1e-4."

- Goal: `pytest tests/test_advection.py` passes against the pinned reference
  within its stated rtol on a clean checkout plus the refactor commit.
- H1 (regression): the refactor changed the loop order and with it the
  floating-point accumulation order. WRONG if the pre-refactor commit shows the
  same 1e-4 drift. Test: `git stash && pytest ...` (cost: 1 min).
- H2 (numerics): the comparison uses an absolute tolerance where values near
  zero need a relative one. WRONG if the drift is uniform across magnitudes.
  Test: print elementwise error vs magnitude (cost: 5 min).
- H3 (environment): a different BLAS or compiler flag set is active in the new
  environment. WRONG if `pip freeze`/module list matches the reference
  environment pin. Test: diff environments (cost: 2 min).
- Order: H1, H3, H2. H1 verdict: REFUTED, pre-refactor commit is clean, output
  cited. H3: REFUTED, environments identical. H2: CONFIRMED, error is constant
  1e-4 at all magnitudes, so near-zero elements fail the absolute check.
- Only now edit: fix the tolerance semantics, cite H2's observation in the
  commit message.

## Red Flags

- Editing code before any hypothesis has a CONFIRMED verdict.
- All hypotheses drawn from one fault class.
- A test that changes two variables at once.
- "It seems better now" presented as a verdict.
- Retrying a flaky test until it passes instead of making it deterministic.
- The fifteen-minute box expiring without an explicit escalation.
- Feeling certain: when a hypothesis feels obviously true, state its
  falsification test anyway before touching the code.
