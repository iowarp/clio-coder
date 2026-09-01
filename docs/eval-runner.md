# Clio Coder Local Evaluation Runner

> [!TIP]
> **Interactive spec available:** The source checkout includes the
> [eval blueprint](https://github.com/iowarp/clio-coder/blob/main/docs/html/eval_blueprint.html).

The local evaluation runner executes repository-local YAML task suites as deterministic subprocess checks. It is useful for comparing harness changes, prompts, tools, or local workflows.

Source of truth: [src/domains/eval/](../src/domains/eval/) and [src/cli/eval.ts](../src/cli/eval.ts).

---

## CLI Commands

The CLI commands under `clio-coder eval` support running, validating, reporting, comparing, and gating evaluation suites.

```bash
clio-coder eval validate --suite <suite.yaml>
clio-coder eval run --suite <suite.yaml> [--trials <n>] [--target <id>] [--model <id>] [--out <path>] [--clio-coder-entry <path>]
clio-coder eval run --task-file <tasks.yaml> [--repeat <n>] [--out <path>] [--clio-coder-entry <path>]
clio-coder eval report <evalId> --format text|json|md|swe-jsonl|junit
clio-coder eval compare <baselineEvalId> <candidateEvalId> [--metric <name>] [--format text|json|md|junit] [--allow-config-drift]
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
* **`gate`**: Compares candidate metrics against baseline and absolute thresholds. Correctness and safety regressions fail independently of informational budgets.

Exit codes:

| Command | Success | Failure |
| --- | --- | --- |
| `eval validate` | `0` when validation passes | `2` for validation issues |
| `eval run` | `0` when all task repetitions pass | `1` when any task fails, `2` for invalid configs |
| `eval report` | `0` when artifact loads | `1` if artifact cannot be read, `2` for invalid ID |
| `eval compare` | `0` when both artifacts compare and the behavioral hard gate passes | `1` for a hard regression or unreadable artifact, `2` for invalid ID |
| `eval gate` | `0` when correctness, safety, and hard threshold assertions pass | `1` for any hard failure, `2` for config/invalid ID errors |

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
| `matrix` | `targets[]`, `repeats`, `dimensions[]` | Matrix of execution targets, repetition count, and the execution-envelope fields intentionally varied by the suite. |
| `workspace` | `kind`, `path`, `url`, `commit`, `checkout`, `excludes` | Workspace strategy: `local` (run in-place), `git` (clone from URL), or `temp-copy` (isolated copy of a directory). |
| `runner` | `kind`, `prompt`, `command`, `commands`, `args`, `timeoutMs` | Runner type: `clio-run` (starts Clio agent loop), `context-index` (runs indexer), `context-init` (initializes context), `external-command` (spawns subprocess). |
| `behavioral` | `schema`, `corpus`, `execution`, `expectedBehavior`, `forbiddenBehavior`, `judge` | Optional `clio.eval.scenario.v1` behavioral contract. Rules name a closed category and a typed predicate over transcript, tool, receipt, or grader facts. |
| `verify` | `commands`, `measure`, `assertions`, `forbidPaths` | Validation steps: shell commands, a task-outcome grader, metric assertions (e.g. `op: lt` for max token counts), and files/directories that must not be created or modified (`forbidPaths`). |
| `metrics` | `collect` | List of metric names to compile for the evaluation runs. |

---

## Workspace Kinds
* **`local`**: Executes the task directly in the specified local path.
* **`git`**: Clones the repository from `url`, checks out the specified `commit` or `checkout` ref, and runs there.
* **`temp-copy`**: Copies the directory at `path` to a temporary workspace location immediately before the matrix item runs and removes it afterward. In a Git checkout, the copy contains exactly tracked files plus untracked files not excluded by Git ignore rules (`git ls-files --cached --others --exclude-standard`), with `excludes` applied afterward. Outside Git it retains the recursive directory copy. This prevents side-effects from polluting other task runs without copying ignored datasets or build trees.

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
  servingConfiguration?: EvalServingConfigurationV1;
  aggregates?: EvalScenarioAggregateV1[];
}
```

`servingConfiguration` and `aggregates` are additive. The v4 reader still accepts an artifact that omits them, and each result's `verdict` is optional for the same reason, so an artifact written before this release loads unchanged.

---

## The verdict envelope

Every result carries a strictly parsed `clio.eval.verdict.v1` envelope (`src/domains/eval/schema/verdict.ts`). Suite v2 results are adapted into it at one explicit boundary (`src/domains/eval/schema/adapter.ts`) rather than by widening the artifact version, because the envelope carries no information a v4 artifact cannot hold.

```json
{
  "schema": "clio.eval.verdict.v1",
  "scenarioId": "latency-nonnegative",
  "trialIndex": 0,
  "outcome": "pass",
  "machinery": "ok",
  "reason": null,
  "trackedMetrics": { "...": "see below" },
  "behavioral": null,
  "evidence": {
    "assignmentId": "qcy5rfopdrfw",
    "terminalReceiptDigest": "d85a3ad4f8ae...",
    "graderExitCode": 0
  }
}
```

The envelope is fail-closed by construction. `outcome` is one of `pass`, `fail`, or `unmeasured`; `machinery` is `ok` or `infrastructure_failure`; `reason` is null for a pass or unmeasured outcome and names the rule or failure class for every failure; the original `behavioral` reservation remains exactly `null`; and an envelope claiming both `infrastructure_failure` and `pass` is rejected at parse rather than recorded. A run whose harness broke therefore cannot be read as a model that succeeded. Behavioral results use the separately versioned sibling document below rather than changing this persisted schema.

### Behavioral scenario and verdict documents

Behavioral evaluation is additive and does not change the persisted `clio.eval.verdict.v1` reader. A Suite v2 task may declare a `clio.eval.scenario.v1` block, and its Artifact v4 result then carries a sibling `clio.eval.behavior.v1` document whose `verdictRef` names the verdict schema, scenario id, and trial index. This preserves existing verdicts and the tracked-metrics baseline while making a cross-linked behavioral document independently parseable.

The closed categories are `tool_choice`, `exploration`, `delegation`, `safety_comprehension`, `claim_grounding`, `denied_tool_recovery`, `completion_behavior`, and `task_correctness`. Each category result is exactly one of `satisfied`, `violated`, `unknown`, or `unmeasured`. The document outcome is `pass`, `behavioral_failure`, `unknown`, `unmeasured`, or `infrastructure_failure`; missing facts are never invented as successes, and an infrastructure failure cannot become a behavioral pass.

Expected and forbidden rules contain typed predicates over facts sourced from `transcript`, `tool`, `receipt`, or `grader`. Facts cite a locator, SHA-256 digest, and optional bounded excerpt. The parser caps rules, facts, evidence per category, ids, and explanations. Before judging, facts and unavailable sources are sorted into a canonical representation and hashed as `judgeInputDigest`, so input order cannot change the judge result. Duplicate or conflicting facts, missing categories, malformed evidence, contradictory outcomes, and a behavioral document that references a different result are refused.

Suite execution adapts scalar run metrics into these observable facts at the Suite v2 to Artifact v4 boundary. A declared no-tool target leaves tool-dependent rules `unmeasured`, while an available evidence source that omits a required fact produces `unknown`. Categories a role-specific scenario does not claim to measure remain `unmeasured`; they are not numeric zero and do not silently satisfy a rule.

### Public built-in behavioral corpus

The source repository carries corpus `public-built-in-behavior` version `1.0.0`
under `evals/`. It contains no private prompts, endpoints, credentials, or
mutable external dataset:

- `behavioral-machinery.yaml` provides one positive and one adversarial
  machinery-only check for each of the 13 shipped built-in worker recipes. Its
  deterministic driver loads the production recipe catalog, admits a real
  dispatch through the production gate, runs a scripted worker, and verifies
  the sealed receipt and result-contract outcome. The 26 scenarios require no
  model; they do not infer behavior by grepping recipe frontmatter.
- `behavioral-model.yaml` provides four isolated main-agent scenarios on the
  `mini` target: a focused edit, adversarial scope control, required
  delegation, and recovery after Bash is denied. Together they cover all eight
  behavioral categories with per-tool call and blocked-call counts, distinct
  and allowlisted read-path counts, declared decoy hits, and grader-emitted
  claim-support and completion facts.
- `behavioral-model-negative-control.yaml` intentionally reads a declared
  decoy. A healthy run solves its literal task while recording
  `behavioral_failure` with violated exploration and safety labels, proving
  that the rules can reject observed model behavior rather than merely restate
  aggregate success counters.

These are source-checkout workflows: the npm archive keeps the inputs for
inspection and reproducibility, but the deterministic TypeScript driver uses
the repository development toolchain. Build once, then run either focused
suite from the repository root:

```sh
node dist/cli/index.js eval run --suite evals/behavioral-machinery.yaml --clio-coder-entry dist/cli/index.js
node dist/cli/index.js eval run --suite evals/behavioral-model.yaml --target mini --clio-coder-entry dist/cli/index.js
node dist/cli/index.js eval run --suite evals/behavioral-model-negative-control.yaml --target mini --clio-coder-entry dist/cli/index.js
```

The machinery tasks use the repository read-only and create only private
scratch state under `TMPDIR`; model tasks use a fresh `temp-copy` workspace and
remove it after the matrix item settles. The machinery suite is the fast
admission, worker, and receipt contract. The model suite is the live behavioral
measurement: keep its Artifact v4 output as evidence for the exact target and
serving configuration that ran, rather than treating one observed model result
as a universal guarantee. Behavioral facts and their evidence store only
bounded read counters, not path strings. As with other eval runs, the artifact's
bounded diagnostic stdout may retain the underlying tool event stream.

### `trackedMetrics`

Eleven numbers plus a reason histogram, each carrying the source it came from. `source` is `ledger` (the per-call ledger folded from the worker's own JSON stream), `receipt` (the sealed run receipt), or `estimated`, and `estimated` is what a missing observation is marked as rather than being silently counted as measured.

| Metric | Usual source |
| --- | --- |
| `modelCalls` | ledger |
| `uncachedPrefillTokens` | ledger, from `promptCache.backend` |
| `cacheReadTokens` | ledger, from `promptCache.backend`, falling back to pi-ai cache reads |
| `generatedTokens` | ledger |
| `reasoningTokens` | receipt; nullable, because absent and zero are different claims |
| `toolCalls`, `toolErrors` | ledger when present, otherwise receipt |
| `ttftMsFirstCall` | ledger |
| `wallClockMs` | receipt |
| `contextTokensAtEnd` | ledger |
| `compactions` | ledger |
| `expectedColdReasons` | ledger, one sourced count per reason |

A dispatched worker's receipt reports `sessionId: null` and writes no session archive, which is why the ledger source exists at all: the runner folds structured usage, backend timing, cache, and monotonic TTFT facts out of the worker's `message_end` events. It keeps no prompt text, no model prose, and no tool-result content in that fold.

### Scenario aggregates

`aggregates` groups verdicts by `scenarioId`, sets `k` to the trial count, and records `passAtK` (any trial passed) and `passPowK` (every trial passed). Each tracked numeric metric reports observation, measured, and unmeasured counts, mean, min, max, nearest-rank p90, population variance, standard deviation, and the set of sources observed. A metric with no observation keeps every numeric statistic `null`; it never becomes zero. At `k: 1`, variance and standard deviation are zero only when the value was actually measured.

### Behavioral multi-metric results

A result with a `clio.eval.behavior.v1` verdict also carries the additive
`clio.eval.behavior.metrics.v1` projection. The projection binds the scenario
to its role and target/model envelope and records one `number | null`
observation for each closed metric. The source travels beside every value:

| Family | Metric | Direction | Gate | Source |
|---|---|---|---|---|
| correctness | `correctness.taskSolved` | higher | hard | grader |
| safety | `safety.violations` | lower | hard | behavioral label |
| behavior | `behavior.labelViolations` | lower | informational | behavioral labels |
| efficiency | `efficiency.toolCalls` | lower | informational | terminal tool events |
| exploration | `exploration.unnecessaryReads` | lower | informational | read observation counters |
| delegation | `delegation.quality` | higher | informational | behavioral label |
| claims | `claims.unsupported` | lower | informational | grader |
| tokens | `tokens.total` | lower | informational | runner usage stream |
| latency | `latency.wallMs` | lower | informational | monotonic runner clock |
| cost | `cost.usd` | lower | informational | sealed receipt |

Label metrics are numeric projections only when the category is `satisfied` or
`violated`; `unknown` and `unmeasured` remain null. A missing grader, token
stream, receipt, read observation, or category label likewise remains null.
The projection therefore records observation coverage without claiming that
silence was success, safety, or zero cost.

### Behavioral comparisons and variance

`eval compare` reduces the behavioral projection independently for every
scenario, role, target id, and model id. Each row contains the baseline and
candidate distributions, coverage, mean delta, variance delta, and two closed
classifications: `improved`, `regressed`, `unchanged`, or `incomparable` for the
mean and for variability. Lower variance is the improvement direction for the
variability classification.

Correctness and safety rows are hard. A measured regression fails the hard
gate even when pass rate, tokens, latency, or cost improved. Losing a
correctness or safety measurement that existed in the baseline is also a hard
failure; a category explicitly unmeasured on both sides stays incomparable but
does not invent a regression. Other families remain visible informational
tradeoffs. `--metric` accepts either a behavioral metric or family as well as a
tracked metric, but filtering displayed rows never filters the hard-gate
decision.

Comparison output supports `text`, `json`, `md`, and `junit`. All four carry
the same hard-gate result and closed classifications. JUnit failures represent
only hard behavioral failures; an informational efficiency or cost regression
is emitted as testcase output rather than a failed testcase.

### Execution-envelope provenance and comparability

Every newly written behavioral result carries an additive
`clio.eval.execution-envelope.v1` sibling. Artifact v4,
`clio.eval.verdict.v1`, and `clio.eval.behavior.metrics.v1` retain their
existing identities. The envelope records the selected prompt fragment ids,
authored versions or `unversioned` marker, fragment content hashes, prompt
composition hash, recipe id/version/fingerprint when a worker recipe applies,
target, wire model, runtime, thinking level, tool signature, effective
autonomy, rule-pack and project-policy hashes, bounded project-context
provenance, and corpus id/version. A machinery-only scenario uses explicit
nulls for model concepts that did not apply; null is not substituted for a
fact that was observed.

Suite v2 may declare `matrix.dimensions` from `prompt`, `recipe`, `target`,
`wireModel`, `runtime`, `thinkingLevel`, `toolSignature`, `autonomy`, `policy`,
`projectContext`, and `corpus`. Comparison ignores only dimensions declared by
both artifacts. Any other envelope difference marks every metric row for that
scenario/role/target incomparable and fails the behavioral gate. A missing
envelope on only one side is also incomparable. Two older artifacts that both
predate the sibling remain readable and compare under their existing data.

Text, JSON, Markdown, and JUnit comparison reports carry the same envelope
mismatch. Text and Markdown also include independent per-scenario and per-role
baseline/candidate counts for improved, regressed, unchanged, and incomparable
metric means and variances. When the prompt or recipe identity changes, the
generated evidence names each affected corpus scenario and role instead of
hiding it behind an aggregate score.

### Reference behavioral baseline

`evals/behavioral-machinery-baseline.json` is retained as reviewable reference
evidence for the machinery corpus. It is not a CI or release gate. Run the
current `evals/behavioral-machinery.yaml` through the built CLI when a prompt,
recipe, policy, or expected-behavior change needs a fresh measurement, inspect
the named scenario evidence, and update any retained baseline deliberately in
the reviewed change. Model-required and negative-control suites remain manual
measurements tied to their exact target and serving configuration.

### Hard thresholds and informational budgets

Suite and external threshold files keep two separate assertion lists:

```yaml
thresholds:
  fail:
    - metric: task.solved
      op: eq
      value: false
  informational:
    - metric: cost.usd
      op: gt
      value: 0.25
```

`fail` is the backwards-compatible hard list. A firing or unresolved hard
assertion makes `eval run` or `eval gate` exit nonzero. `informational` uses the
same typed predicates and reports every firing budget or missing measurement,
but never changes the exit status. `eval gate` additionally evaluates the
baseline-to-candidate correctness and safety hard gate, so a cheaper candidate
cannot offset a task or safety regression.

### `--trials N`

`--trials N` overrides the suite's `matrix.repeats` and asks for an isolated workspace per matrix item. A `local` workspace is converted to a temporary copy immediately before that item runs, so an explicit trial run never mutates the directory it was pointed at; `git` and `temp-copy` workspaces already produce a distinct preparation directory per item. Workspace and state directories are removed on the item's `finally` path, including runner, setup, and copy failures. The trial index rides through to each verdict's `trialIndex`.

### Serving-configuration provenance and drift refusal

`servingConfiguration` records what the numbers were measured against: `targetId`, `runtimeId`, `modelId`, `serverBuild`, `total_slots`, `thinkingLevel`, and `compiledPromptHash`. The build string and slot count are read from the server after the matrix has run while it is still awake, by fetching `/props` and falling back to the model-qualified slots query when `/props` exposes no `total_slots`. The prompt hash is the receipt's static composition hash, so a prompt change is visible as a configuration change rather than as a mysterious metric shift.

`eval compare` prints both configurations and refuses outright when they differ:

```text
serving configuration drift; pass --allow-config-drift to compare these runs
baseline serving: target=mini runtime=llamacpp model=... server_build=b226-2115b73d8 total_slots=1 thinking=off compiled_prompt_hash=...
candidate serving: ...
```

`--allow-config-drift` proceeds and labels the comparison `config drift: allowed`. There is a second refusal that has no override: a metric whose baseline distribution contains an `estimated` observation and whose candidate does not, or the reverse, raises `EvalTrackedMetricSourceMismatchError` rather than printing a delta, because subtracting a measurement from an estimate produces a number that looks like evidence and is not. `--metric <name>` filters tracked or behavioral rows, accepts `expectedColdReasons`, a specific `expectedColdReasons.<reason>`, a behavioral family, or a behavioral metric, and errors when the name matches nothing.

---

## Task Outcome Measurement (`verify.measure`)

Task outcome commands declared under `verify.measure` are the code grader for whether the model solved the workload and record metrics (`task.solved`, `task.exitCode`). A non-zero exit fails the final result and is named on its verdict as `reason: grader_failed`, while `machinery` remains `ok` when the runner and machinery verifiers succeeded. This keeps the artifact's `pass`, verdict outcome, scenario aggregates, and summary on one pass decision without misreporting a grader failure as broken machinery.
