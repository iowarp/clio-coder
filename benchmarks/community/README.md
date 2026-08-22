# Clio community benchmarks

This directory contains public adapters for external coding benchmarks. The
adapters are wrappers around Clio, not a second eval engine.

## Contents

```text
community/
  clio_usage.py        fold `clio-coder run --json` usage for a parent `clio-coder eval`
  result_manifest.py   the manifest.json and summary.json shape results/ tracks
  uv_command.py        portable `uv run` command prefixes for generated tasks
  requirements.txt     per-adapter Python dependencies, for operators who want a venv
  swe-bench-lite/      SWE-bench Lite prediction generation
  terminal-bench/      Terminal-Bench installed agent
  scicode/             SciCode task generation and grading
  human-eval/          HumanEval completion generation and grading
```

Each adapter exists for what Clio cannot do on its own: fetch an external
dataset, render its prompts, and score the output against the upstream grader.
The agent work itself is one `clio-coder run --json` or `clio-coder eval run`
per task; nothing here reimplements dispatch, accounting, or receipts.

## Python runner

Run Python adapters with `uv run --no-project ...` so benchmark commands do not
capture a local interpreter path. Generated `clio-coder eval` task files also use uv.
Set `UV_BIN` to pin a uv executable, or `CLIO_CODER_BENCH_UV_WITH` to inject extra
comma-separated `uv --with` packages into generated verifier commands.

## Targets

SWE-bench, SciCode, and HumanEval require an explicit `--target <id>` before a
command can start a Clio model run, and pass that selection to `clio-coder
run`. They do not silently inherit the operator's default target. The target
comes from the operator's configured targets (`clio-coder targets`); `--model
<id>` remains an optional explicit override. Generated eval task files carry
the same selection in their setup commands. Offline inspection, grading,
recomputation, and `--dry-run` paths do not start a model run and do not require
a target.

The Terminal-Bench agent is the endpoint-based exception. It runs inside a
container with no operator Clio config, so the harness must supply its main and
worker endpoints through `CLIO_CODER_MAIN_URL` and `CLIO_CODER_WORKER_URL`; the
adapter writes those selections into its own container-local `settings.yaml`.
Do not commit real endpoints, hostnames, credentials, or machine paths.

## SWE-bench Lite

The SWE-bench adapter clones each selected instance, runs `clio-coder run --json`
with the issue text, and writes a source-only patch to `predictions.jsonl`.
It also writes `manifest.json` and `summary.json` in the run directory.
Evaluation with the official harness is a separate Docker workflow.

```sh
uv run --no-project --with datasets --with swebench \
  python benchmarks/community/swe-bench-lite/swebench_clio.py \
  --target <id> \
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
clio-coder eval report <evalId> --format swe-jsonl > predictions.jsonl
```

## Terminal-Bench

`terminal-bench/tb_clio_coder/` implements a Terminal-Bench installed agent. The
agent requires `CLIO_CODER_MAIN_URL` and `CLIO_CODER_WORKER_URL`; it has no endpoint
defaults. The adapter writes a scheduled-run `manifest.json` and `summary.json`
under `benchmarks/community/terminal-bench/runs/latest` unless
`CLIO_CODER_TB_RESULT_DIR` points elsewhere.

Build and serve a Clio tarball where the container can reach it, then run
Terminal-Bench with the adapter import path:

```sh
npm run build
# `npm pack` names the tarball after the current package version, so read the
# name it printed rather than pinning one that goes stale on every release.
CLIO_CODER_TARBALL=$(npm pack --pack-destination /tmp/clio-pack | tail -1)

CLIO_CODER_TARBALL_URL=http://host.docker.internal:8899/"$CLIO_CODER_TARBALL" \
CLIO_CODER_MAIN_URL=http://orchestrator.example:8080 \
CLIO_CODER_WORKER_URL=http://worker.example:1234 \
PYTHONPATH=benchmarks/community/terminal-bench \
tb run -d terminal-bench-core==0.1.1 --n-concurrent 1 \
  --agent-import-path "tb_clio_coder.clio_coder:ClioCoder" \
  --output-path benchmarks/community/terminal-bench/runs/smoke
```

Terminal-Bench reports no token usage, and the manifest says so rather than
printing a zero. The other adapters run `clio-coder run --json` as their own child,
keep the event stream in a file, and republish the usage they folded on their
own stdout. This one hands the harness a `TerminalCommand` that runs inside the
task container, so the harness owns the process and its terminal: no `--json`,
no event stream this process can read, and no parent `clio-coder eval` reading this
adapter's stdout. Measuring usage here requires changing what terminal-bench
executes and where it deposits the stream, which is a harness-integration
change rather than an accounting fix.

## SciCode

`scicode/scicode_clio.py` generates normal `clio-coder eval` task files and grades
generated Python. Official scoring requires the SciCode target artifact and the
upstream SciCode Python package, both supplied outside this repository.
`run-problem` writes generated-attempt manifests, and `grade-problem` rewrites
the same run directory with scored manifests.

```sh
uv run --no-project python benchmarks/community/scicode/scicode_clio.py inspect-data \
  --data /path/to/scicode/problems_all.jsonl

uv run --no-project python benchmarks/community/scicode/scicode_clio.py generate-tasks \
  --target <id> \
  --data /path/to/scicode/problems_all.jsonl \
  --h5py-file /path/to/scicode/test_data.h5 \
  --out benchmarks/community/scicode/runs/tasks.yaml \
  --limit 3

clio-coder eval run --task-file benchmarks/community/scicode/runs/tasks.yaml
```

For CI fixtures, the SciCode grader also accepts a small JSON target manifest
through `--references`. That mode is for adapter validation, not official
SciCode scoring.

## HumanEval

`human-eval/humaneval_clio.py` runs the OpenAI HumanEval Python completion
suite. It can drive Clio directly or emit a `clio-coder eval` task file. The public
HumanEval JSONL is not tracked; either pass `--data`, install the upstream
`human_eval` package, or download the JSONL.GZ into the adapter's ignored data
directory.

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py ensure-data
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py inspect-data

uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py run \
  --target <id> \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/smoke \
  --timeout 300

uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py generate-tasks \
  --target <id> \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/tasks.yaml \
  --run-root benchmarks/community/human-eval/runs/eval-smoke

clio-coder eval run --task-file benchmarks/community/human-eval/runs/tasks.yaml
```

HumanEval grading executes generated Python. Use a container or other sandbox
for untrusted model outputs.
