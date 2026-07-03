# Internal Eval Suites

Private suites should live outside this repository. Keep datasets, prompts,
live fleet coordinates, calibration outputs, and raw run artifacts in a private
checkout or object store.

Run a private suite from this source checkout with:

```sh
npm run build
clio eval run --suite <external-path> --clio-entry dist/cli/index.js
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
        - .clio
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
        - .clio
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
