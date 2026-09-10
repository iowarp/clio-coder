---
version: 1
name: pipeline-review
description: Coordinate a two-stage inspection of scientific pipeline data definitions and validation assertions.
steps:
  - id: inspect-pipeline
    agent: scout
    scope: readonly
    dependencies: []
  - id: verify-invariants
    agent: verifier
    scope: readonly
    dependencies: [inspect-pipeline]
maxWorkers: 2
onFailure: stop
---

Review the scientific pipeline specified at: {{pipeline}}.

## Workflow Stages

1. **inspect-pipeline (`scout`)**:
   Inspect data schemas, pipeline steps, dependency declarations, and configuration inputs in the target pipeline.
2. **verify-invariants (`verifier`)**:
   Independently verify that numerical tolerances, sanity checks, regression tests, and invariant assertions are defined and bounded.

## Prerequisites & Environment Requirements

- **Core Agents**: This fleet coordinates the built-in `scout` and `verifier` recipes provided by Clio (`src/domains/agents/builtins/`).
- **Configuration**: Requires a configured read-only model target with context support.
- **Variables**: The caller must supply the `{{pipeline}}` variable naming the pipeline configuration or script path (e.g. `--var pipeline=configs/pipeline.yaml`).
