# Clio benchmarks

This tree is an external consumer of Clio Coder. It does not add benchmark
protocols to `src/`, use `clio-coder eval`, or run as part of product CI.

```text
benchmarks/
  community/  adapters and upstream scorers for public benchmark datasets
  internal/   isolated live drivers, harness self-checks, and campaign output
```

Datasets, virtual environments, caches, model streams, transcripts, container
output, and result directories are ignored by `benchmarks/.gitignore`. A run
must never dirty the release worktree. Harness source, suite definitions, and
small deterministic self-test fixtures are versioned.

## Boundary

Community adapters own only what Clio cannot: loading a public dataset,
preparing a task workspace, and invoking the upstream scorer. The internal
harness owns binary identity, isolated state, process cleanup, event and usage
collection, receipts, provenance, and aggregation. Clio itself exposes its
normal CLI, JSONL, sessions, and receipts; product source has no benchmark-only
wire marker or scenario metric.

The two result axes stay separate:

- `harnessStatus`: whether the run is valid evidence (`valid`, `invalid`, or
  `blocked`).
- `taskStatus`: what the upstream grader decided (`pass`, `fail`, `timeout`, or
  `not_scored`).

A valid wrong answer is a model failure, not a harness error.

## Commands

Deterministic harness checks, deliberately outside `npm run ci`:

```sh
npm run benchmark:check
```

Real-model drivers use the built candidate and an explicit configured target:

```sh
npm run build
npm run live:smoke -- --target dynamo --model qwen3.8-27b --thinking off
npm run live:tui -- --target dynamo --model qwen3.8-27b \
  --workspace /path/to/throwaway-task --send "Solve the task and verify it."
```

See `community/README.md` for public scorers and `internal/README.md` for live
isolation, herdr operation, and result artifacts.
