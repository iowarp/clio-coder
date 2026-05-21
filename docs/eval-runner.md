# Clio Coder Local Evaluation Runner

The **Local Evaluation Runner** provides a deterministic, reproducible, and model-free environment to benchmark and compare agent performance across local task suites. It executes setup and validation pipelines, collects performance data, and prints regression/improvement comparisons, allowing developers to measure the impact of prompts, tools, and models objectively.

---

## 📋 The Eval Task YAML Schema

Evaluation suites are declared in a simple, declarative YAML task file. 

```yaml
version: 1
tasks:
  - id: add-json-flag
    prompt: "Implement a --json flag in the CLI command parser."
    cwd: /path/to/repro/sandbox
    setup:
      - git restore .
      - npm install
    verifier:
      - npm run build
      - node dist/cli/index.js --json
    timeoutMs: 60000
    tags:
      - cli
      - regression-priority
```

### Schema Rules:
1. `version` must be `1`.
2. `id` must be unique across the task file.
3. `setup` (optional list of shell commands): Executed sequentially before verification. A non-zero exit code stops the run immediately.
4. `verifier` (required list of shell commands): Runs sequentially. A non-zero exit code marks the task as failed.
5. `timeoutMs` (required integer): Maximum wall time allowed per individual command.
6. `cwd` (required string): Sandboxed directory where setup and verifier scripts execute.

---

## 🛠️ CLI Evaluation Surface

Developers trigger local evaluations using three subcommands:

### 1. Run an Evaluation Suite
```bash
clio eval run --task-file tasks.yaml [--repeat 3]
```
Loads and validates `tasks.yaml`, runs each task in declaration order (repeating `repeat` times if configured), writes a deterministic evidence corpus, and saves the result JSON at `<dataDir>/evals/eval-<startedAt>-<taskFileHash>.json`. The command exits `0` if all tests passed and `1` if any failed.

### 2. Render an Evaluation Report
```bash
clio eval report eval-20260520-a1b2c3d4
```
Loads a previously persisted evaluation run and prints a formatted summary table to `stdout`.

### 3. Compare Baseline vs. Candidate
```bash
clio eval compare eval-baseline-hash eval-candidate-hash
```
Compares a baseline run against a candidate run, matching tasks by the deterministic rule **`taskId+repeatIndex`**. It prints deltas for pass rate, wall time, token usage, USD cost, and failure taxonomies.

---

## 🚫 Failure Taxonomy Classification

When a task fails, Clio Coder categorizes the failure into a closed taxonomy:

| Failure Class | Root Cause |
| :--- | :--- |
| `setup_failed` | A command in the `setup[]` array exited with a non-zero code. |
| `verifier_failed` | A command in the `verifier[]` array exited with a non-zero code. |
| `timeout` | A setup or verifier command exceeded its `timeoutMs` window. |
| `cwd_missing` | The specified `cwd` directory does not exist. |
| `command_error` | Subprocess spawning failed due to a system or shell resolution issue. |

---

## 📊 Harness-Level Metrics

Clio Coder tracks detailed resource and behavior metrics to measure efficiency:

- **`wallTimeMs`:** Total combined wall time of setup and verifier subprocess runs.
- **`tokens`:** Model input and output token consumption during the task.
- **`costUsd`:** Estimated monetary cost based on provider token rates.
- **`toolCalls`:** Total number of tool executions triggered by the orchestrator.
- **`safetyBlocks`:** Count of tool calls rejected by the safety engine or damage-control pack.
- **`retries`:** Number of model-call or tool-call network retries triggered during runtime.
- **`validationEvidence`:** Count of successfully completed verifier commands.

---

## 🔒 Invariants
1. **Model-free execution:** The evaluation runner itself does not execute any model prompts; it executes setup/verifier scripts as local subprocesses. Model metrics (tokens, costs, tools) are collected by parsing linked run receipts during execution.
2. **Deterministic matching:** Comparing two evaluations validates that they share identical task content hashes. The comparison matches results strictly by `taskId+repeatIndex`. Unmatched results in baseline are flagged as `missing`; unmatched in candidate are flagged as `added`.
