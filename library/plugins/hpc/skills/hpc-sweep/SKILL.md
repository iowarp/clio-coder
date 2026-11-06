---
name: hpc-sweep
description: "Runs a Slurm parameter sweep as an experiment: plans a job array and shows a dry run, submits on the operator's word, checks each run with its declared verify check, and tabulates every run, failed and unverified included. Not for a single job."
triggers:
  - run a parameter sweep
  - sweep these parameters on slurm
  - submit the sweep
  - dry run the sweep
  - tabulate the sweep results
  - refine the sweep grid
---

# Parameter sweeps on Slurm

A sweep is a job array plus a manifest, judged run by run. Every run ends in the
table with its parameters, its scheduler state, its job id, the verdict of its
declared check and the conditions behind that verdict. A run that failed, or
completed without anything the check could judge, stays in the table as such.
The verdicts say whether each run agreed with its reference within the check's
declared tolerance. They do not say the simulation is right.

The helper is `${pluginRoot}/assets/scripts/sweep.py` (Python 3.10+). It plans
and tabulates. It never submits, polls or cancels. Those go through the
`slurm-jobs` skill's `mcp_slurm__*` capabilities. Run the helper with `bash`
from the project root: `python3 <helper> plan|aggregate ...`.

## Phase 0 - Prerequisites

1. Load the `slurm-jobs` skill and run its Phase 0. The Slurm server must be
   listed with id `slurm`. Without it, stop with that skill's remedy.
2. Read the sweep file. If there is none, write one with the operator (format
   below) and stop for their review before planning.
3. `verify()` with no arguments. The sweep's `check` must be listed with
   `One run per call: <id>/<run>, <run> a directory under <out>/runs`. If it is
   missing or has no runs directory, show the operator the catalog entry below
   and stop. Never write `.clio-coder/verifiers.yaml` without their approval.

## The sweep file

YAML (JSON when PyYAML is absent). Paths are relative to the project root.

```yaml
version: 1
name: decay                     # [a-z0-9][a-z0-9_-]*, names sweeps/<name>/
parameters:                     # each name becomes an environment variable in the run
  k: [1, 4]
  dt: [0.001, 0.01]
mode: grid                      # grid (every combination) or sample
# sample: { count: 16, seed: 7 }  # mode: sample; a parameter may then be { low, high, log?, integer? }
template: sim/run.sh            # the run body; it starts inside its run directory
resources: { cores: 1, memory: 1G, time_limit: "00:10:00", partition: debug }
concurrency: 4                  # most runs in flight at once; becomes the array's %N
check: decay-error              # the verify check that judges one run
metrics: metrics.json           # optional JSON object each run writes; its numbers go in the table
# submit: jobs                  # one job per run instead of an array; needed for resources.directives
```

The template runs as `bash <template>` with the working directory set to
`sweeps/<name>/runs/<task>/`, `SWEEP_TASK_ID` and `SWEEP_RUN_DIR` set, and every
parameter exported. Each run directory holds `params.json` before submission.
Use absolute paths inside the template.

The per-run check is a `.clio-coder/verifiers.yaml` entry that declares `runs`.
Verify appends the run directory to its command, so the command judges one run:

```yaml
  - id: decay-error
    description: Relative error of one run against the analytic solution
    command: [python3, checks/decay_error.py]   # receives sweeps/decay/runs/<task>
    cwd: .
    timeoutMs: 60000
    tags: [sweep]
    kind: numeric-compare
    reference: checks/zero.json
    tolerance: { absolute: 0.01 }
    runs: sweeps/decay/runs
```

Use `kind: numeric-compare`. Only a judged check records a claim, so a
`command` check would leave every run `unverified` in the table, and `reproduce`
does not accept `runs` because its clean environment never holds a run's output.
A parameter-dependent expectation belongs in the check command: print the
deviation from the expected value and compare it against a reference of zeros.

## Phase 1 - Plan and dry run (the default)

`python3 <helper> plan <sweep file>`. It writes `sweeps/<name>/manifest.tsv`,
`array.sh` (or `jobs/task-<n>.sh`), `plan.json` and `runs/<task>/params.json`,
and prints the run list, every script and the exact `mcp_slurm__slurm_submit`
call. It refuses to plan over a run directory that already holds output.

Show the operator the run count, the parameter table, the script and the
submission call verbatim. Unless the operator's request says to submit, stop
here: the dry run is the answer. Ask with `ask_user` whether to submit when it
is available; a headless run reports the dry run and stops.

## Phase 2 - Submit

Only on the operator's word. Make exactly the submission `plan.json` names, with
its `array` expression unchanged: the `%N` suffix is the sweep's concurrency
cap, and dropping it lets every run start at once. For `submit: jobs`, keep at
most `concurrency` jobs submitted and not terminal, and submit the next only
when one finishes. The Slurm server asks for approval on every submission; a
headless run at `default` denies it, so report that the sweep needs an operator
and stop. Record the job id verbatim at once.

## Phase 3 - Monitor

Follow `slurm-jobs` Phase 3 and its array reference: describe each task by
`<array id>_<task>` with `output="none"`, back off from 30 seconds to 5 minutes,
and never read the bare array id as the array's state. Polling ends when every
task is terminal. Report a task that stays pending with its reason; do not
cancel it unasked.

## Phase 4 - Check each finished run

For every task whose state is `COMPLETED` with exit 0, call
`verify(check="<check>/<task>")`, one call per run. Do not skip a run because
the last ones passed, and do not rerun a check to change its verdict. A check
that cannot judge (its command fails before printing a result) leaves the run
unverified. That is a finding, not something to repair in this phase. Do not
check failed tasks.

## Phase 5 - Tabulate

```bash
clio-coder claims list --check <check> --json > sweeps/<name>/claims.json
python3 <helper> aggregate sweeps/<name>/plan.json --job <array id> --claims sweeps/<name>/claims.json
```

For `submit: jobs`, pass `--job <task>=<job id>` for each run. The helper reads
each task's state with `sacct`; where `sacct` is unavailable, pass
`--state <task>=<STATE>:<exit>` from the describe results. If the check's `cwd`
is not `.`, pass `--check-cwd <cwd>`. It writes `results.tsv` and `results.md`
in `sweeps/<name>/`, in the project, because the table is the experiment's
result and belongs with its manifest, scripts and run outputs under version
control. Clio's state holds only the claims behind it.

Verdicts: `agrees` or `disagrees` (the check judged the run), `unverified`
(completed, but no judged result was recorded for it), `run failed` (a terminal
state other than `COMPLETED` with exit 0), `not terminal`, or `unknown` (no
scheduler record).

## Phase 6 - Offer a refinement

Show the table and its tally line. Then, attended, use `ask_user` with concrete
refinements drawn from the table, for example a finer grid between the last
agreeing and the first disagreeing value of one parameter, a new array of only
the failed task ids, or no change. A refinement is a new sweep file with a new
`name`, planned and dry-run like the first; never overwrite a finished sweep's
directory. Headless: list the refinements in the report and stop.

## Final answer

The sweep name, manifest path and sha256, the submission made (or "dry run, not
submitted"), the array job id, the tally line, the path of `results.md`, and one
`Slurm job` line per task in the `slurm-jobs` form. Name every failed and
unverified run with its reason.
