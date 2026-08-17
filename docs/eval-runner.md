# Clio Coder Local Evaluation Runner

> [!TIP]
> **Interactive Spec Available:** An interactive task suite validator, subprocess execution simulator, and compare calculator is located at [docs/html/eval_blueprint.html](html/eval_blueprint.html) (Version: 0.3.0).

The local evaluation runner executes repository-local YAML task suites as deterministic subprocess checks. It is useful for comparing harness changes, prompts, tools, or local workflows.

Source of truth: [src/domains/eval/](../src/domains/eval/) and [src/cli/eval.ts](../src/cli/eval.ts).

---

## CLI Commands

The CLI commands under `clio-coder eval` support running, validating, reporting, comparing, and gating evaluation suites.

```bash
clio-coder eval validate --suite <suite.yaml>
clio-coder eval run --suite <suite.yaml> [--target <id>] [--model <id>] [--out <path>] [--clio-coder-entry <path>]
clio-coder eval run --task-file <tasks.yaml> [--repeat <n>] [--out <path>] [--clio-coder-entry <path>]
clio-coder eval report <evalId> --format text|json|md|swe-jsonl|junit
clio-coder eval compare <baselineEvalId> <candidateEvalId>
clio-coder eval gate <candidateEvalId> --baseline <baselineEvalId> [--thresholds <file>]
```

### Command Roles
* **`validate`**: Validates the structure and constraints of a Suite v2 YAML file without executing it.
* **`run`**: Runs a Suite v2 (via `--suite`) or a compatibility v1 task file (via `--task-file`). Outputs a text summary and writes an eval artifact under `<dataDir>/evals/` and evidence under `<dataDir>/evidence/eval-<evalId>/`.
* **`report`**: Formats and prints a report from a saved `evalId`. Supports multiple `--format` outputs:
  * `text` (default): Human-readable stdout summary.
  * `json`: Raw JSON structure of the artifact.
  * `md`: Markdown document with tables and summaries.
  * `swe-jsonl`: Standardized JSONL format representing task runs (e.g. for SWE-bench comparisons).
  * `junit`: XML report for CI/CD integration.
* **`compare`**: Compares two evaluation artifacts (baseline and candidate) by matching tasks.
* **`gate`**: Compares candidate metrics against baseline or absolute thresholds, exiting non-zero if assertions fail (useful for PR gating).

Exit codes:

| Command | Success | Failure |
| --- | --- | --- |
| `eval validate` | `0` when validation passes | `2` for validation issues |
| `eval run` | `0` when all task repetitions pass | `1` when any task fails, `2` for invalid configs |
| `eval report` | `0` when artifact loads | `1` if artifact cannot be read, `2` for invalid ID |
| `eval compare` | `0` when both artifacts load and compare succeeds | `1` if artifacts cannot be read, `2` for invalid ID |
| `eval gate` | `0` when all threshold assertions pass | `1` if assertions fail, `2` for config/invalid ID errors |

---

## Suite v2 Schema

Suite v2 files define matrix targets, workspaces, runner parameters, validation metrics, assertions, and path blocklists.

```yaml
version: 2
suite:
  id: "science-suite"
  title: "Scientific Software Evaluation"
  visibility: "local"
  description: "Suite for verifying HPC integrations."
matrix:
  targets:
    - id: "local-gemini"
      model: "gemini-3.5-flash"
    - id: "local-claude"
      model: "claude-sonnet-5"
  repeats: 3
tasks:
  - id: "fft-tolerance-check"
    tags:
      - numeric
      - fast
    workspace:
      kind: "temp-copy" # local | git | temp-copy
      path: "fixtures/fft-src"
      excludes:
        - "**/node_modules/**"
    runner:
      kind: "clio-run" # clio-run | context-index | context-init | external-command
      prompt: "Optimize the FFT tolerance bounds in solver.ts"
      timeoutMs: 60000
    verify:
      commands:
        - "npm run test"
      assertions:
        - metric: "result.pass"
          op: "eq"
          value: true
        - metric: "tokens.total"
          op: "lt"
          value: 15000
      forbidPaths:
        - "**/credentials.yaml"
    metrics:
      collect:
        - "tokens.total"
        - "latency.wallMs"
    timeoutMs: 90000
```

### Schema Field Reference

| Field / Section | Sub-fields | Description |
| --- | --- | --- |
| `version` | - | Must equal `2`. |
| `suite` | `id`, `title`, `visibility`, `description` | Metadata identifying the evaluation suite. |
| `matrix` | `targets[]`, `repeats` | Matrix of execution targets (specifying model and thinking flags) and the repetition count. |
| `workspace` | `kind`, `path`, `url`, `commit`, `checkout`, `excludes` | Workspace strategy: `local` (run in-place), `git` (clone from URL), or `temp-copy` (isolated copy of a directory). |
| `runner` | `kind`, `prompt`, `command`, `commands`, `args`, `timeoutMs` | Runner type: `clio-run` (starts Clio agent loop), `context-index` (runs indexer), `context-init` (initializes context), `external-command` (spawns subprocess). |
| `verify` | `commands`, `assertions`, `forbidPaths` | Validation steps: shell commands, metric assertions (e.g. `op: lt` for max token counts), and files/directories that must not be created or modified (`forbidPaths`). |
| `metrics` | `collect` | List of metric names to compile for the evaluation runs. |

---

## Workspace Kinds
* **`local`**: Executes the task directly in the specified local path.
* **`git`**: Clones the repository from `url`, checks out the specified `commit` or `checkout` ref, and runs there.
* **`temp-copy`**: Copies the directory at `path` to a temporary workspace location before running. This prevents side-effects from polluting other task runs.

---

## Runner Kinds
* **`clio-run`**: Invokes the main Clio Coder agent loop with the task's prompt, tracing all tools.
* **`context-index`**: Triggers the context engine to build index structures (`codewiki`).
* **`context-init`**: Initializes workspace files (such as generating `CLIO-CODER.md`).
* **`external-command`**: Spawns an external command or sequence of commands in the task workspace.

---

## Metric Assertions

Metrics collected during runs can be validated automatically using the `verify.assertions` list. Supported operator fields (`op`) are:
* `lt` (less than)
* `lte` (less than or equal)
* `gt` (greater than)
* `gte` (greater than or equal)
* `eq` (equal)
* `neq` (not equal)

Metrics that can be validated include `tokens.input`, `tokens.output`, `tokens.total`, `latency.wallMs`, `tools.totalCalls`, `tools.failed`, `tools.blocked`, `verifier.exitCode`, and `result.pass`.

---

## Failure Classes

Evaluation tasks may fail with one of the following classes:

| Failure Class | Meaning |
| --- | --- |
| `setup_failed` | A setup command exited non-zero. |
| `verifier_failed` | A verifier command exited non-zero. |
| `timeout` | A setup or verifier command timed out. |
| `cwd_missing` | Resolved task cwd does not exist. |
| `command_error` | Reserved class for command spawn/system errors. |

---

## v1 Compatibility

Version 1 task files can still be run directly via:
```bash
clio-coder eval run --task-file tasks.yaml [--repeat <n>]
```
Under the hood, these are parsed and wrapped into a Suite v2 adapter with:
* Workspace kind: `local` (using task `cwd` as workspace path)
* Runner kind: `external-command` (executing task `setup` commands)
* Verify commands: Task `verifier` commands
* Timeout and tags mapped directly

---

## Token Accounting & Provenance

Clio maintains two distinct token accounting streams with different provenances. These accounts are never merged, reconciled, or treated as interchangeable:

1. **`tokens.*` (Wire Streaming)**: Folded live off stdout from assistant `message_end` events watched by `token-stream.ts` / `createStreamInvariantFold`. This represents usage reported by the provider for assistant messages watched over the wire. On surfaces without stdout streaming (such as `clio-coder fleet run --json`), `tokens.measured` is `false`.
2. **`receiptUsage.*` (Journal Receipts)**: Summed from an evaluation item's run journal. Every attempt writes a receipt carrying token counts and USD cost authenticated against its own ledger envelope.

### Fail-Closed Reporting
Both accounting streams report unmeasured state with no counts at all rather than a numeric zero. Reporting zero for an unmeasured run would falsely claim the run cost nothing. On an unmeasured run, `tokens.total` resolves to `null` and fails closed on metric threshold comparisons.

---

## Eval Artifact Format (v4)

Evaluation artifacts use format version 4 (`EvalArtifactV4`). Summary token metrics report `measuredRuns` out of total `runs`:

```typescript
export interface EvalArtifactV4 {
  version: 4;
  evalId: string;
  suite: { id: string; hash: string };
  clio: EvalClioProvenance;
  environment: EvalEnvironmentProvenance;
  matrix: { target: string; model: string | null; thinking: string | null };
  summary: EvalArtifactSummaryV4;
  results: EvalArtifactResultV4[];
}
```

---

## Task Outcome Measurement (`verify.measure`)

Task outcome commands declared under `verify.measure` evaluate whether the model solved the workload and record metrics (`task.solved`, `task.exitCode`). A non-zero exit from `verify.measure` is recorded as data and **never fails the evaluation item**. Task solution outcome is a measurement, while only machinery invariant behavior operates as a gate.

