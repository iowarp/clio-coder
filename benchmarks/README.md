# Clio benchmark artifacts

This directory is intentionally narrow. It tracks public benchmark adapters and
sanitized benchmark result manifests only.

The eval engine ships in `src/domains/eval`. Internal suites, live fleet runs,
model sweeps, context regression corpora, and private operator results live
outside this repository.

## Layout

```text
benchmarks/
  community/                  Public adapters for external benchmark datasets.
  results/<suite>/<run-id>/   Sanitized result manifests and summaries.
```

`benchmarks/results/<suite>/<run-id>/` is the only tracked result location. A
tracked run directory contains `manifest.json` and `summary.json`. Large run
outputs, raw streams, checkouts, private fleet files, and external datasets stay
untracked.

## Community adapters

`benchmarks/community/` contains thin adapters for public benchmark ecosystems:

1. SWE-bench Lite patch generation through `swe-bench-lite/swebench_clio.py`.
2. Terminal-Bench container episodes through `terminal-bench/tb_clio_agent/`.
3. SciCode prompt generation and grading through `scicode/scicode_clio.py`.

Each adapter drives Clio through the installed CLI or `clio eval`; none of these
files is the eval engine itself.

## Fleet config

Real fleet coordinates are private. `benchmarks/community/fleet.json` is
gitignored, and `CLIO_FLEET` may point at any private JSON file with the same
shape as `benchmarks/community/fleet.example.json`.

The adapter scripts also honor per-run overrides such as `CLIO_MAIN_URL`,
`CLIO_MAIN_MODEL`, `CLIO_WORKER_URL`, `CLIO_WORKER_MODEL`, and the matching
target and thinking variables.

```sh
CLIO_FLEET=/path/to/private/fleet.json npm run bench:tb
npm run bench:swe -- --instances pytest-dev__pytest-6116 --out benchmarks/community/swe-bench-lite/runs/smoke
npm run bench:scicode -- inspect-data --data /path/to/scicode/problems_all.jsonl
```

## Result manifests

Tracked result records are small, portable JSON files. Adapter outputs follow
this convention:

```text
benchmarks/results/<suite>/<run-id>/manifest.json
benchmarks/results/<suite>/<run-id>/summary.json
```

The manifest describes the suite, dataset, split, Clio version, commit, run
date, model, target profile, resolved instance count, error count, artifact
hashes, and notes. The summary contains the compact aggregate result for the
same run.
