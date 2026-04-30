# Local Eval Runner

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The eval domain provides a reproducible way to compare harness changes across local task suites. A YAML task file declares one or more tasks with explicit setup commands, verifier commands, a per-task timeout, and tag metadata. The runner executes setup and verifier commands as subprocesses against the task's `cwd`, captures stdout, stderr, exit codes, signals, and wall time, and persists the result as a stable `EvalRunArtifact` JSON. Each eval run also writes a deterministic evidence corpus and links the generated `evidenceId` back into every result. The CLI surface is `clio eval run`, `clio eval report`, and `clio eval compare`.

## Data layout

Each eval run persists one artifact at:

```
<dataDir>/evals/<evalId>.json
```

The evidence corpus produced for the same run lives at the standard evidence path:

```
<dataDir>/evidence/<evidenceId>/
```

Eval ids are deterministic: `eval-<startedAt-utc-compact>-<taskFileHash[:8]>`. The same task file hashed against the same start instant produces the same id. The task file itself is not copied into the artifact directory; instead the artifact records the absolute task-file path and its `sha256` content hash so a comparison can refuse mismatched suites.

## Public CLI surface

- `clio eval run --task-file <tasks.yaml> [--repeat <n>]` loads and validates the task file, runs every task `repeat` times in declaration order, builds an evidence corpus, persists the eval artifact, and prints the report. Exit code is `0` when every task passed and `1` when any task failed.
- `clio eval report <evalId>` loads the persisted artifact and prints the same report `clio eval run` emits.
- `clio eval compare <baselineEvalId> <candidateEvalId>` matches results by `taskId+repeatIndex` and prints matched, added, missing, regression, improvement, unchanged, failure-class, token, cost, wall-time, and pass-rate deltas.

`--repeat` defaults to `1`. `--task-file` is required for `run`. Both eval ids are required for `compare`.

## Public types

Types live in `src/domains/eval/types.ts` and are re-exported from `src/domains/eval/index.ts`.

- `EvalTask` carries `id`, `prompt`, `cwd`, `setup[]`, `verifier[]`, `timeoutMs`, and `tags[]`.
- `EvalTaskFile` carries `version: 1` and `tasks[]`. Validation is done by `loadEvalTaskFile` in `task-file.ts`.
- `EvalCommandResult` carries one subprocess invocation: `phase` (`setup` or `verifier`), `index`, `command`, `exitCode`, `signal`, `timedOut`, `wallTimeMs`, `stdout`, `stderr`.
- `EvalFailureClass` enumerates the closed failure taxonomy: `setup_failed`, `verifier_failed`, `timeout`, `cwd_missing`, `command_error`.
- `EvalResult` is the public minimal record: `taskId`, `runId`, `pass`, `exitCode`, `tokens`, `costUsd`, `wallTimeMs`, optional `failureClass`, optional `receiptPath`, optional `evidenceId`.
- `EvalRunRecord` extends `EvalResult` with `repeatIndex`, `cwd`, `prompt`, `tags[]`, and `commands[]`.
- `EvalSummary` aggregates `runs`, `passed`, `failed`, `passRate`, `tokens`, `costUsd`, `wallTimeMs`, and `failureClasses[]`.
- `EvalRunArtifact` is the persisted file shape: `version: 1`, `evalId`, `taskFile`, `taskFileHash`, `repeat`, `startedAt`, `endedAt`, `summary`, `results[]`.
- `EvalComparisonSummary` carries the matched/added/missing buckets, regressions, improvements, failure-class changes, and per-axis deltas. Defined in `compare.ts` with `EVAL_COMPARE_MATCHING_RULE = "taskId+repeatIndex"`.

## Invariants

1. The matching rule for `clio eval compare` is `taskId+repeatIndex`. Results that exist in the baseline but not the candidate are reported as `missing`; results that exist in the candidate but not the baseline are reported as `added`.
2. Setup commands run before verifier commands. A non-zero setup exit fails the task with `failureClass: setup_failed`; a non-zero verifier exit fails with `failureClass: verifier_failed`.
3. A missing `cwd` fails the task before any command runs with `failureClass: cwd_missing`.
4. The per-task `timeoutMs` is enforced per command. A timed-out command fails with `failureClass: timeout`.
5. Token, cost, and wall-time totals are aggregated from per-command durations only. v0.1.4 does not call any model from the eval runner; tokens and `costUsd` are recorded as `0` for verifier-only suites.
6. Each eval run writes a deterministic evidence corpus and patches `evidenceId` into every result before persisting the artifact. The same `evalId` always maps to the same `evidenceId`.
7. The task file hash is recorded in the artifact and validated on `compare`. Comparing two artifacts produced by different task files is supported but the operator is responsible for deciding whether the comparison is meaningful.

## Status and scope notes

v0.1.4 ships repo-local YAML task files, the deterministic verifier runner, the evidence link, the report renderer, and the baseline/candidate comparator. Model calls are not yet made by the runner; the path is wired so future slices can plug in agent invocations between `setup` and `verifier`. There is no built-in suite registry; the operator points at any YAML file. Cross-machine reproducibility is the operator's responsibility because cwd, environment, and installed tooling are not pinned by the runner.

## References

- `src/domains/eval/types.ts`: type surface.
- `src/domains/eval/task-file.ts`: YAML loading and validation.
- `src/domains/eval/runner.ts`: setup and verifier subprocess execution.
- `src/domains/eval/store.ts`: artifact persistence and id derivation.
- `src/domains/eval/compare.ts`: baseline vs. candidate matching and deltas.
- `src/domains/eval/report.ts`: human-readable report rendering.
- `src/domains/eval/index.ts`: public domain entry.
- `src/cli/eval.ts`: CLI wiring.
- `tests/unit/eval-runner.test.ts`, `tests/unit/eval-evidence.test.ts`, `tests/unit/eval-compare.test.ts`: regression coverage.
- `docs/.superpowers/IMPROVE.md` section M7: roadmap entry.
