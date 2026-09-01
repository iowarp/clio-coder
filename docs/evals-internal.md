# Internal Eval Suites

> [!TIP]
> **Interactive spec available:** The source checkout includes the
> [internal eval blueprint](https://github.com/iowarp/clio-coder/blob/main/docs/html/evals_internal_blueprint.html).

Private suites should live outside this repository. Keep datasets, prompts,
live fleet coordinates, calibration outputs, and raw run artifacts in a private
checkout or object store.

Run a private suite from this source checkout with:

```sh
npm run build
clio-coder eval run --suite <external-path> --clio-coder-entry dist/cli/index.js
```

Use `--out <dir>` when the artifact should be written outside the default Clio
data directory. External benchmark campaigns should adapt their cases and
grader observations into the same eval engine while keeping private datasets,
credentials, endpoints, and raw artifacts outside this repository.

The public behavioral corpus is the deliberate exception to the otherwise
private Suite v2 data policy. Its reviewable, synthetic suites live under
`evals/`: a model-free positive/adversarial authority pair for every
built-in worker recipe, four tiny main-agent model scenarios covering all eight
behavioral categories with event- and grader-derived facts, and an intentional
decoy negative control. The model-free driver uses the shipped recipe catalog,
real dispatch admission, scripted workers, and sealed receipts rather than
frontmatter inspection. See
[eval-runner.md](eval-runner.md#public-built-in-behavioral-corpus) for the
focused commands. Private prompts, calibration cases, fleet coordinates, and
campaign artifacts still belong outside this repository and must not be copied
into the public corpus.

## Running a private suite as a measurement

A private suite is usually run to answer whether a harness change moved
something, which makes it a measurement rather than a pass or fail. Three
mechanics matter for that, all documented in full in
[eval-runner.md](eval-runner.md#the-verdict-envelope).

Run repeated trials with `--trials N` rather than by editing `matrix.repeats`.
The flag overrides the suite's repeat count and asks for an isolated workspace
per matrix item, so a `local` workspace is copied for the run instead of being
mutated across trials. Each result's verdict carries its `trialIndex`, and the
artifact's `aggregates` reduce them per scenario: `k`, `passAtK` (any trial
passed), `passPowK` (every trial passed), and a mean and nearest-rank p90 for
every tracked metric. A single trial produces a `k: 1` aggregate whose mean and
p90 are the same observed value, which is a fact to state in a report rather
than a distribution to reason about.

Read the tracked metrics with their sources attached. A private suite on a
local target is measuring prefill economics as much as correctness, so
`uncachedPrefillTokens`, `cacheReadTokens`, `ttftMsFirstCall`, and the
`expectedColdReasons` histogram are the interesting columns, and each one says
whether it came from the ledger, from the receipt, or was `estimated`. A metric
marked `estimated` on one side of a comparison and measured on the other is
refused rather than differenced.

Behavioral suites add a second projection beside those tracked performance
metrics. Compare it per scenario, role, and target/model envelope rather than
reducing unlike roles into one pass rate. Correctness and safety are hard
regression gates; tool efficiency, unnecessary exploration, delegation
quality, unsupported claims, tokens, latency, and receipt cost remain separate
families with their own measured coverage and repeat variance. A missing value
is null and makes that row incomparable, never zero.

Put release-blocking assertions under `thresholds.fail` and non-blocking spend
or latency budgets under `thresholds.informational`. Informational findings are
printed in every gate run but do not change its exit status. Do not put a cost
budget in the hard list to compensate for weak correctness, and do not turn a
correctness rule into an informational budget; the comparison gate evaluates
correctness and safety before either kind of operator-authored threshold.

Record the serving configuration or the comparison is not one. The artifact
captures `targetId`, `runtimeId`, `modelId`, `serverBuild`, `total_slots`,
`thinkingLevel`, and `compiledPromptHash`, read from the server after the matrix
has run while it is still awake. `eval compare` refuses two artifacts whose
configurations differ unless `--allow-config-drift` is passed, and prints both
either way. Treat that refusal as the useful behavior it is: a private suite
compared across a server restart that changed a flag, a quantization, or the
thinking level is measuring the server, not the change under test.

The verdict envelope keeps its original `behavioral: null` field for compatibility.
A suite that declares a versioned behavioral scenario records the result as a
separate `clio.eval.behavior.v1` document on the Artifact v4 result, cross-linked
to the unchanged verdict identity. Its labels come only from bounded transcript,
tool, receipt, or grader facts, never from an ungrounded judge paragraph. A run whose harness broke records
`machinery: "infrastructure_failure"`, which the parser refuses to pair with a
`pass`, so a private suite cannot report a passing rate that includes runs
nothing measured.

## Context Regression Seed

```yaml
version: 2
suite:
  id: internal-context-regression
  title: Internal context regression
  visibility: private
  description: Private context index determinism and coverage regression.
  provenance:
    owner: internal-eval
    source: private
matrix:
  targets:
    - id: local
  repeats: 3
tasks:
  - id: context-index-private-checkout
    tags:
      - internal
      - context
      - offline
    workspace:
      kind: local
      path: .
      excludes:
        - .git
        - node_modules
        - dist
        - coverage
    runner:
      kind: context-index
    verify:
      assertions:
        - metric: context.indexedFiles
          op: gt
          value: 0
        - metric: context.coverage
          op: gt
          value: 0
      forbidPaths:
        - data/private-dump
        - runs/raw
    metrics:
      collect:
        - context.indexedFiles
        - context.coverage
        - context.structuralHash
        - context.digestTokens
        - latency.wallMs
    timeoutMs: 120000
thresholds:
  fail:
    - metric: result.pass
      op: eq
      value: false
    - metric: context.coverage
      op: lte
      value: 0
```

## Model Matrix Seed

```yaml
version: 2
suite:
  id: internal-model-matrix
  title: Internal model matrix
  visibility: private
  description: Private model target smoke matrix for headless Clio runs.
  provenance:
    owner: internal-eval
    source: private
matrix:
  targets:
    - id: local-fast
      model: example-fast-model
      thinking: low
    - id: local-deep
      model: example-deep-model
      thinking: high
  repeats: 2
tasks:
  - id: version-smoke
    tags:
      - internal
      - matrix
      - smoke
    workspace:
      kind: temp-copy
      path: fixtures/version-smoke
      excludes:
        - node_modules
        - dist
    runner:
      kind: external-command
      commands:
        - node -e "console.log('matrix smoke')"
    verify:
      assertions:
        - metric: verifier.exitCode
          op: eq
          value: 0
    metrics:
      collect:
        - latency.wallMs
        - verifier.exitCode
    timeoutMs: 30000
  - id: tiny-clio-run
    tags:
      - internal
      - matrix
      - model-required
    workspace:
      kind: temp-copy
      path: fixtures/tiny-repair
      excludes:
        - node_modules
        - dist
    runner:
      kind: clio-run
      prompt: Fix the intentionally broken function so the local verifier passes.
    verify:
      commands:
        - npm test
      assertions:
        - metric: result.pass
          op: eq
          value: true
    metrics:
      collect:
        - tokens.input
        - tokens.output
        - tokens.total
        - latency.wallMs
        - patch.filesChanged
        - verifier.exitCode
    timeoutMs: 600000
thresholds:
  fail:
    - metric: result.pass
      op: eq
      value: false
    - metric: tools.blocked
      op: gt
      value: 0
```

## Live Turns Seed

```yaml
version: 2
suite:
  id: internal-live-turns
  title: Internal live turns
  visibility: private
  description: Private live-fleet prompts for end-to-end Clio turn checks.
  provenance:
    owner: internal-eval
    source: private
matrix:
  targets:
    - id: live-orchestrator
      model: example-live-model
      thinking: low
  repeats: 1
tasks:
  - id: readonly-repo-summary
    tags:
      - internal
      - live
      - readonly
      - model-required
    workspace:
      kind: temp-copy
      path: fixtures/live-readonly
      excludes:
        - node_modules
        - dist
        - .clio-coder
    runner:
      kind: clio-run
      prompt: Summarize the repository purpose and make no file changes.
    verify:
      forbidPaths:
        - unexpected-output.txt
      assertions:
        - metric: result.pass
          op: eq
          value: true
        - metric: patch.filesChanged
          op: eq
          value: 0
    metrics:
      collect:
        - tokens.total
        - latency.wallMs
        - tools.totalCalls
        - tools.failed
        - patch.filesChanged
    timeoutMs: 300000
  - id: live-small-edit
    tags:
      - internal
      - live
      - edit
      - model-required
    workspace:
      kind: temp-copy
      path: fixtures/live-small-edit
      excludes:
        - node_modules
        - dist
        - .clio-coder
    runner:
      kind: clio-run
      prompt: Fix the failing unit test with the smallest source change.
    verify:
      commands:
        - npm test
      assertions:
        - metric: result.pass
          op: eq
          value: true
        - metric: patch.testFilesModified
          op: eq
          value: 0
    metrics:
      collect:
        - tokens.input
        - tokens.output
        - tokens.total
        - latency.wallMs
        - tools.totalCalls
        - tools.failed
        - patch.filesChanged
        - patch.testFilesModified
        - verifier.exitCode
    timeoutMs: 600000
thresholds:
  fail:
    - metric: result.pass
      op: eq
      value: false
    - metric: tools.failed
      op: gt
      value: 0
```
