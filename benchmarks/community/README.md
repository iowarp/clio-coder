# Clio community benchmarks

This directory contains public adapters for external coding benchmarks. The
adapters are wrappers around Clio, not a second eval engine.

## Contents

```text
community/
  fleet.example.json
  clio_fleet.py
  uv_command.py
  swe-bench-lite/
  terminal-bench/
  scicode/
  human-eval/
```

`fleet.json` is intentionally gitignored. Keep real endpoints in that file or
point `CLIO_FLEET` at another private file.

## Python runner

Run Python adapters with `uv run --no-project ...` so benchmark commands do not
capture a local interpreter path. Generated `clio eval` task files also use uv.
Set `UV_BIN` to pin a uv executable, or `CLIO_BENCH_UV_WITH` to inject extra
comma-separated `uv --with` packages into generated verifier commands.

## Fleet setup

Inspect a private fleet file with:

```sh
CLIO_FLEET=/path/to/private/fleet.json uv run --no-project python benchmarks/community/clio_fleet.py
```

The same file shape is shown in `fleet.example.json`. Per-run environment
overrides still work:

```sh
CLIO_MAIN_URL=http://orchestrator.example:8080 \
CLIO_MAIN_MODEL=example-orchestrator-model \
CLIO_WORKER_URL=http://worker.example:1234 \
CLIO_WORKER_MODEL=example-worker-model \
uv run --no-project python benchmarks/community/clio_fleet.py
```

Do not commit real fleet URLs, private hostnames, credentials, or local machine
paths.

## SWE-bench Lite

The SWE-bench adapter clones each selected instance, runs `clio run --json`
with the issue text, and writes a source-only patch to `predictions.jsonl`.
It also writes `manifest.json` and `summary.json` in the run directory.
Evaluation with the official harness is a separate Docker workflow.

```sh
uv run --no-project --with datasets --with swebench \
  python benchmarks/community/swe-bench-lite/swebench_clio.py \
  --instances pytest-dev__pytest-6116 \
  --out benchmarks/community/swe-bench-lite/runs/smoke \
  --timeout 1800
```

Use `recompute_patches.py` to rebuild clean predictions from existing checkouts
without another model run:

```sh
uv run --no-project python benchmarks/community/swe-bench-lite/recompute_patches.py \
  benchmarks/community/swe-bench-lite/runs/smoke \
  clio-coder-example
```

When a Clio eval artifact is the source of truth, export SWE-style JSONL with:

```sh
clio eval report <evalId> --format swe-jsonl > predictions.jsonl
```

## Terminal-Bench

`terminal-bench/tb_clio_agent/` implements a Terminal-Bench installed agent. The
agent requires `CLIO_MAIN_URL` and `CLIO_WORKER_URL`; it has no endpoint
defaults. The adapter writes a scheduled-run `manifest.json` and `summary.json`
under `benchmarks/community/terminal-bench/runs/latest` unless
`CLIO_TB_RESULT_DIR` points elsewhere.

Build and serve a Clio tarball where the container can reach it, then run
Terminal-Bench with the adapter import path:

```sh
npm run build
npm pack --pack-destination /tmp/clio-pack

CLIO_TARBALL_URL=http://host.docker.internal:8899/iowarp-clio-coder-0.2.8.tgz \
CLIO_MAIN_URL=http://orchestrator.example:8080 \
CLIO_WORKER_URL=http://worker.example:1234 \
PYTHONPATH=benchmarks/community/terminal-bench \
tb run -d terminal-bench-core==0.1.1 --n-concurrent 1 \
  --agent-import-path "tb_clio_agent.clio_agent:ClioAgent" \
  --output-path benchmarks/community/terminal-bench/runs/smoke
```

## SciCode

`scicode/scicode_clio.py` generates normal `clio eval` task files and grades
generated Python. Official scoring requires the SciCode target artifact and the
upstream SciCode Python package, both supplied outside this repository.
`run-problem` writes generated-attempt manifests, and `grade-problem` rewrites
the same run directory with scored manifests.

```sh
uv run --no-project python benchmarks/community/scicode/scicode_clio.py inspect-data \
  --data /path/to/scicode/problems_all.jsonl

uv run --no-project python benchmarks/community/scicode/scicode_clio.py generate-tasks \
  --data /path/to/scicode/problems_all.jsonl \
  --h5py-file /path/to/scicode/test_data.h5 \
  --out benchmarks/community/scicode/runs/tasks.yaml \
  --limit 3

clio eval run --task-file benchmarks/community/scicode/runs/tasks.yaml
```

For CI fixtures, the SciCode grader also accepts a small JSON target manifest
through `--references`. That mode is for adapter validation, not official
SciCode scoring.

## HumanEval

`human-eval/humaneval_clio.py` runs the OpenAI HumanEval Python completion
suite. It can drive Clio directly or emit a `clio eval` task file. The public
HumanEval JSONL is not tracked; either pass `--data`, install the upstream
`human_eval` package, or download the JSONL.GZ into the adapter's ignored data
directory.

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py ensure-data
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py inspect-data

uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py run \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/smoke \
  --timeout 300

uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py generate-tasks \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/tasks.yaml \
  --run-root benchmarks/community/human-eval/runs/eval-smoke

clio eval run --task-file benchmarks/community/human-eval/runs/tasks.yaml
```

HumanEval grading executes generated Python. Use a container or other sandbox
for untrusted model outputs.
