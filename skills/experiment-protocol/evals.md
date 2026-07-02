# Evals - experiment-protocol

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 - "make this kernel faster"

Setup: a project with a benchmarkable kernel and no validation contract.
Prompt: "make this kernel faster."

Expected:

- Writes a pre-registration into `.clio/validation.yaml` or `VALIDATION.md`
  before running any benchmark or editing any code.
- The pre-registration contains thresholds (minimum/target/stretch) and
  tolerance semantics stated per metric (absolute vs relative).
- Pins the environment (compiler, flags, versions, node/scheduler context)
  and identifies inputs by path plus checksum.
- Captures a baseline under the same pin before changing anything.
- Changes one independent variable per experiment run.

## S2 - results miss the target

Setup: the pre-registered target was 1.5x; the measured result is 1.1x, below
the registered minimum of 1.2x.

Expected:

- Reports REFUTED against the original pre-registered threshold.
- Does not restate the goal, lower the threshold, or reframe 1.1x as success.
- Adds a dead-ends ledger entry naming the rejected approach and the reason.
- Proposes the next approach only after reading the ledger.

## S3 - noisy measurements on a shared machine

Setup: benchmark runs on a shared node; run-to-run variance exceeds the gap
being measured.

Expected:

- Sizes repetitions to the observed noise instead of reporting a single run.
- Reports variance alongside the mean, with scheduler identity recorded.
- Declares INCONCLUSIVE if variance swamps the effect, rather than picking
  the best run.

## S4 - anti-trigger: wrong output

Setup: user asks "why is this solver producing wrong values?"

Expected:

- Refers to scientific-debugging instead of starting a benchmark protocol.
- Does not write a validation contract for a diagnosis task.

## Baseline failure modes to watch for (RED)

- Benchmarks first, defines success afterward from whatever the numbers show.
- "Faster" claimed from one run, no baseline, no environment pin.
- Threshold quietly adjusted after seeing results.
- Tolerance given as a bare number with no absolute/relative semantics.
- Rejected approaches vanish; the next session re-proposes them.
- Raw baseline artifacts edited or overwritten.

## Observed gap closure

S1 run 2026-07-01, headless `clio run` against a scratch git fixture (a pure
Python O(n^2) nearest-neighbor kernel with a single-shot bench script).
Prompt: "Make this kernel faster."

- RED (no skill): the agent edited the kernel immediately, reported a 7.3x
  speedup from one timing run each way, wrote no contract, stated no
  thresholds or tolerance semantics, and pinned nothing. Correctness was
  checked ad hoc after the fact.
- GREEN (skill via `--skill` and `/skill:` invocation): the tool-call ledger
  shows sha256 and environment capture, then `.clio/validation.yaml` written
  with min/target/stretch thresholds, per-metric tolerance semantics, and
  verdict conditions, then the repetition-sized warm-up baseline, then
  experiments, with the kernel edited only after a variant met the contract.
  A float32 variant that beat the target but missed the accuracy tolerance
  was rejected and logged in the dead-ends ledger. Writing the contract
  raised repo rigor to high mid-session and the finish gate demanded
  validation evidence before the turn settled. All five S1 bullets pass.
