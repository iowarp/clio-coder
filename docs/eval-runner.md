# Clio Coder Local Evaluation Runner

The local evaluation runner executes repository-local YAML task suites as deterministic subprocess checks. It is useful for comparing harness changes, prompts, tools, or local workflows without requiring the runner itself to call a model.

Source of truth: `src/domains/eval/**` and `src/cli/eval.ts`.

---

## CLI

```bash
clio eval run --task-file tasks.yaml [--repeat <n>]
clio eval report <evalId>
clio eval compare <baselineEvalId> <candidateEvalId>
```

`clio eval run` writes an eval artifact under `<dataDir>/evals/` and also builds deterministic eval evidence under `<dataDir>/evidence/eval-<evalId>/`.

Exit codes:

| Command | Success | Failure |
| --- | --- | --- |
| `eval run` | `0` when all task repetitions pass | `1` when any task fails, `2` for invalid task files/args |
| `eval report` | `0` when artifact loads | `1` if artifact cannot be read |
| `eval compare` | `0` when both artifacts load and comparison renders | `1` if artifacts cannot be read |

---

## Task-file schema

Task files are YAML with `version: 1` and a non-empty `tasks` array.

```yaml
version: 1
tasks:
  - id: cli-json-smoke
    prompt: "Verify the CLI JSON mode still starts."
    cwd: fixtures/cli-json-smoke
    setup:
      - npm install
    verifier:
      - npm run build
      - node dist/cli/index.js --help
    timeoutMs: 60000
    tags:
      - cli
      - smoke
```

Rules enforced by `src/domains/eval/task-file.ts`:

| Field | Requirement |
| --- | --- |
| `version` | Must equal `1`. |
| `tasks` | Non-empty array. |
| `id` | Non-empty; letters, numbers, dots, underscores, and hyphens only; unique. |
| `prompt` | Non-empty string. Stored for traceability; the current runner does not send it to a model. |
| `cwd` | Non-empty relative path under the task file directory. Absolute paths and escapes are rejected. |
| `setup` | Optional string array; missing means `[]`. |
| `verifier` | Required non-empty string array. |
| `timeoutMs` | Positive integer applied per command. |
| `tags` | Optional string array; missing means `[]`. |

Unknown task fields are validation errors.

---

## Execution model

For each repeat and task:

1. Resolve `cwd` relative to the task file directory.
2. If `cwd` does not exist, mark the result `cwd_missing`.
3. Run each `setup` command sequentially using the platform shell.
4. Stop on the first failed/timed-out setup command.
5. Run each `verifier` command sequentially.
6. Stop on the first failed/timed-out verifier command.
7. Record stdout/stderr with a per-command output cap.

The runner currently records `tokens: 0` and `costUsd: 0` because it does not invoke a model. Receipt-backed harness metrics exist in types for future/linked workflows, while local command runs populate validation evidence from passing verifier commands.

---

## Failure classes

| Failure class | Meaning |
| --- | --- |
| `setup_failed` | A setup command exited non-zero. |
| `verifier_failed` | A verifier command exited non-zero. |
| `timeout` | A setup or verifier command timed out. |
| `cwd_missing` | Resolved task cwd does not exist. |
| `command_error` | Reserved class for command spawn/system errors. |

---

## Artifact and report fields

Eval artifacts have `version: 1` and include:

- `evalId`
- `taskFile`
- `taskFileHash`
- `repeat`
- `startedAt` / `endedAt`
- `summary`
- `results[]`

Summary metrics include runs passed/failed, pass rate, token/cost totals, wall time, receipt-backed run count, tool calls, retries, safety blocks, correction latency, validation evidence count, and failure-class counts.

---

## Comparisons

```bash
clio eval compare eval-baseline eval-candidate
```

Comparisons match results by `taskId + repeatIndex`. They report pass-rate, wall-time, token, cost, and harness-metric deltas, plus missing/added result rows when task sets differ.

For useful comparisons, run baseline and candidate from the same task file content and repeat count.
