---
name: experiment-protocol
description: Use when running a performance study, numerical comparison, parameter sweep, kernel or solver benchmark, or any change justified by "faster" or "more accurate", and success criteria should be locked before results exist. Pre-registers thresholds, tolerances, environment pins, and verdict conditions into the repository validation contract before any measurement. Triggers on "benchmark", "compare implementations", "optimize", "tolerance", "reproduce results", "parameter sweep". Not for diagnosing a stalled bug; use scientific-debugging.
version: 0.1.2
license: Apache-2.0
allowed-tools:
  - read
  - write
  - grep
  - ls
  - find
  - git
  - context
  - code_nav
  - bash
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/research/experiment-protocol
  audit: pass
  provenance: designed
  eval-status: scenarios-recorded
  model-size: any
---

# Experiment Protocol

Lock the success criteria before any result exists. Pre-registration that
happens after the first measurement is worthless: it can only ratify what was
already seen. Moving the threshold after seeing results is the exact failure
mode this protocol exists to prevent.

Anti-trigger: if the question is "why is this output wrong", that is a
diagnosis, not an experiment; use scientific-debugging.

## Phase 0 - Pre-register

Before any measurement, write the protocol into the repository validation
contract: `.clio/validation.yaml` (preferred) or `VALIDATION.md` at the repo
root. Creating this file raises Clio's repo-derived rigor to high immediately;
from the next turn onward, completion claims in this session must carry
validation evidence or state a limitation. That escalation is the point:
the contract arms the finish gate with the criteria you are about to commit to.

The pre-registration must contain:

- **Outcome**: one sentence, e.g. "the fused kernel reaches at least 1.8x the
  baseline throughput on the pinned input at equal accuracy".
- **Thresholds**: minimum (below this is REFUTED), target, stretch.
- **Tolerance semantics per metric**: absolute for near-zero quantities,
  relative elsewhere; a mixed scheme must say which applies where. "1e-6" with
  no stated semantics is not a tolerance.
- **Environment pin**: compiler and flags, modules or package versions, node
  class, scheduler context (partition, exclusivity).
- **Input identity**: paths plus checksums (`sha256sum`).
- **Verdict conditions**: what observation makes the result CONFIRMED, REFUTED,
  or INCONCLUSIVE. Committed now, immutable after the first measurement.

## Phase 1 - Baseline

Capture current behavior under the pinned environment before changing
anything. Store raw outputs and timings as artifacts; never edit them. A
speedup claim without a baseline captured under the same pin is a guess.

## Phase 2 - Experiment

- One independent variable per run. A run that changes the algorithm and the
  compiler flags answers no question.
- Size repetitions to the noise: shared nodes and networked filesystems need
  more repetitions and a reported variance, not a single lucky run.
- Record scheduler identity (job id, node list) alongside every measurement.

## Phase 3 - Analysis

Compare against the pre-registered thresholds only. If the protocol was
deviated from, log the deviation next to the result; do not silently absorb
it. Findings outside the registered outcome are marked exploratory and get
their own pre-registration if pursued.

## Phase 4 - Iterate

Keep a dead-ends ledger in the contract file or beside it: one line per
rejected approach with the reason it was rejected. Read it before proposing
the next approach; re-proposing a ledger entry wastes a run. Stop when one of
the pre-registered stop conditions holds: target met, budget exhausted, or all
candidate strategies rejected.

## Worked Example

Request: "make the halo exchange faster."

```yaml
# .clio/validation.yaml
experiment: halo-exchange-overlap
outcome: overlap communication with interior compute; >= 1.5x step throughput
thresholds: { minimum: 1.2x, target: 1.5x, stretch: 2.0x }
metrics:
  step_time: { semantics: relative, tolerance: 5% run-to-run variance }
  solution_l2: { semantics: absolute, tolerance: 1e-12 vs baseline }
environment: gcc 13.2 -O3, openmpi 4.1.6, 4x cpu-bind=cores, exclusive nodes
inputs: { mesh: data/mesh-256.h5, sha256: "<checksum>" }
verdicts:
  confirmed: step_time speedup >= 1.2x AND solution_l2 within tolerance
  refuted: speedup < 1.2x with variance < 5%, or accuracy loss
  inconclusive: run-to-run variance > 5% (resize repetitions first)
dead_ends: []
```

Baseline: 20 repetitions on exclusive nodes, mean and variance recorded with
job ids. Experiment: nonblocking exchange only, flags untouched. Result: 1.3x,
accuracy within 1e-12: CONFIRMED at minimum, target not met; ledger gains
"persistent requests: no gain over nonblocking here, latency-bound", and the
next variable (message aggregation) gets its own run.

## Red Flags

- Any measurement taken before the contract file exists.
- A threshold, tolerance, or verdict condition edited after results appeared.
- Wall-clock numbers with no environment pin attached.
- A single-run victory claim on a shared machine.
- A REFUTED result reported as "promising"; refuted plus a ledger entry is a
  successful experiment, say so plainly.
- Deleting or rewriting baseline artifacts.
