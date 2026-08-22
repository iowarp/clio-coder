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
2. Terminal-Bench container episodes through `terminal-bench/tb_clio_coder/`.
3. SciCode prompt generation and grading through `scicode/scicode_clio.py`.
4. OpenAI HumanEval completion generation and grading through `human-eval/humaneval_clio.py`.

Each adapter drives Clio through the installed CLI or `clio-coder eval`; none of these
files is the eval engine itself.

## Running an adapter

Run the Python adapters with `uv run --no-project` so a benchmark command never
captures a machine-specific interpreter path:

```sh
uv run --no-project --with datasets --with swebench \
  python benchmarks/community/swe-bench-lite/swebench_clio.py \
  --instances pytest-dev__pytest-6116 \
  --out benchmarks/community/swe-bench-lite/runs/smoke

uv run --no-project python benchmarks/community/scicode/scicode_clio.py inspect-data \
  --data /path/to/scicode/problems_all.jsonl

uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py run \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/smoke
```

Each adapter takes `--target <id>` and `--model <id>` naming one of the
operator's configured Clio targets. `benchmarks/community/README.md` has the
per-adapter detail.

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
