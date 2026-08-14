# Internal Eval Suites

> [!TIP]
> **Interactive Spec Available:** Interactive blueprints are available for internal evaluation suites at [docs/html/evals_internal_blueprint.html](html/evals_internal_blueprint.html) and soak benchmark suites at [docs/html/soak_blueprint.html](html/soak_blueprint.html) (Version: 0.3.0).

Private suites should live outside this repository. Keep datasets, prompts,
live fleet coordinates, calibration outputs, and raw run artifacts in a private
checkout or object store.

Run a private suite from this source checkout with:

```sh
npm run build
clio-coder eval run --suite <external-path> --clio-entry dist/cli/index.js
```

Use `--out <dir>` when the artifact should be written outside the default Clio
data directory. Public summaries can be copied into
`benchmarks/results/<suite>/<run-id>/` only after they have been sanitized down
to `manifest.json` and `summary.json`.

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

---

## Soak Benchmark Suite

The soak benchmark suite located under [`benchmarks/soak/`](../benchmarks/soak/) measures Clio's own machinery performance, integrity, and structural invariant promises under load. Unlike standard evaluation suites, the soak suite evaluates the reliability of Clio rather than model capability. A weak model that fails to solve the workload still passes the suite if Clio's machinery behaves correctly; a strong model fails the suite if Clio fails to seal a receipt, cannot authenticate a receipt, or violates a system invariant.

The soak suite comprises four specialized suite files:

### 1. Machinery Under Load (`clio-soak.yaml`)
Evaluates the same task workload across two execution surfaces: the headless main-agent surface (`clio-run`) and a dispatched worker surface (`agent: coder`). It tests single-file bugs, multi-file bugs, and compaction continuity across restarts.
- **Surface Differences**: Main-agent tasks verify session ledger continuity (`ledger.formatVersion`, `ledger.toolPairsUnmatched`, `ledger.assistantBetweenCallAndResult`), while dispatch worker tasks verify process group cleanup (`process.orphanedChildren == 0`).
- **Compaction Continuity**: Verifies that compaction summaries are present (`continuity.compactionSummaryPresent`) and that pre-compaction facts are preserved (`continuity.answeredFromPreCompaction`).
- **Suite-Wide Gates**: Gates on `receipt.sealed`, `receipt.integrityValid`, `receipt.outcomeMatchesExit`, `tokens.measured`, `stream.cumulativeSnapshots == 0`, `stream.usageDoubleCounted == false`, and `stream.segmentUsageMatchesMessages == true`.

### 2. Per-Step Write Boundaries (`clio-soak-boundary.yaml`)
Validates write boundary enforcement across steps without model participation. Enforcement is strictly detect-and-rollback and is never sandboxing.
- `write-boundary.rolled-back`: Verifies clean detection of allowlist violations (`writes_boundary_violation`), git-level file restoration, and sealed verdict generation (`boundary.violationsRolledBack == 1`, `boundary.rollbackIncomplete == 0`).
- `write-boundary.rollback-incomplete`: Tests honest failure reporting when a path was dirty prior to snapshot taking. prior bytes exist only in the overwritten tree, so rollback leaves the tree unchanged and records incomplete rollback (`boundary.rollbackIncomplete == 1`, `boundary.violationsRolledBack == 0`).

### 3. Fault Injection Chaos (`clio-soak-chaos.yaml`)
Evaluates system resilience against process signals.
- `chaos.sigint-mid-tool`: Prompts Clio for a long-running bash tool call and injects `SIGINT` once the subprocess initializes. Asserts exit code `130`, confirms no orphaned children remain (`process.orphanedChildren == 0`), and verifies receipt sealing, receipt integrity, and provider token reporting.

### 4. Bounded Loops (`clio-soak-loop.yaml`)
Validates iteration bounds and receipt accounting for fleet loops (`bounded-loop.fleet`).
- **Loop Bounds**: Asserts that verification attempts do not exceed declared limits (`loop.attemptsSpent <= 3`), recovery attempts seal individual receipts (`loop.receiptsMatchRepairs == true`), and unneeded nodes report as `unneeded` rather than skipped or failed (`loop.skippedNodes == 0`).
- **Two Token Accountings**: Distinguishes `tokens.*` (folded live off wire stdout by `createStreamInvariantFold`) from `receiptUsage.*` (journal receipts sealed and authenticated against ledger envelopes). On fleet runs, wire streaming is absent (`tokens.measured == false`), while journal receipts provide authenticated usage (`receiptUsage.measured == true`).

