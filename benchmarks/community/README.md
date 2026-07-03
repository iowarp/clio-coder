# Clio community benchmarks

This directory contains public adapters for external coding benchmarks. The
adapters are wrappers around Clio, not a second eval engine.

## Contents

```text
community/
  fleet.example.json
  clio_fleet.py
  swe-bench-lite/
  terminal-bench/
  scicode/
```

`fleet.json` is intentionally gitignored. Keep real endpoints in that file or
point `CLIO_FLEET` at another private file.

## Fleet setup

Inspect a private fleet file with:

```sh
CLIO_FLEET=/path/to/private/fleet.json python benchmarks/community/clio_fleet.py
```

The same file shape is shown in `fleet.example.json`. Per-run environment
overrides still work:

```sh
CLIO_MAIN_URL=http://orchestrator.example:8080 \
CLIO_MAIN_MODEL=example-orchestrator-model \
CLIO_WORKER_URL=http://worker.example:1234 \
CLIO_WORKER_MODEL=example-worker-model \
npm run bench:tb
```

Do not commit real fleet URLs, private hostnames, credentials, or local machine
paths.

## SWE-bench Lite

The SWE-bench adapter clones each selected instance, runs `clio run --json`
with the issue text, and writes a source-only patch to `predictions.jsonl`.
Evaluation with the official harness is a separate Docker workflow.

```sh
npm run bench:swe -- \
  --instances pytest-dev__pytest-6116 \
  --out benchmarks/community/swe-bench-lite/runs/smoke \
  --timeout 1800
```

Use `recompute_patches.py` to rebuild clean predictions from existing checkouts
without another model run:

```sh
python benchmarks/community/swe-bench-lite/recompute_patches.py \
  benchmarks/community/swe-bench-lite/runs/smoke \
  clio-coder-example
```

## Terminal-Bench

`terminal-bench/tb_clio_agent/` implements a Terminal-Bench installed agent. The
agent requires `CLIO_MAIN_URL` and `CLIO_WORKER_URL`; it has no endpoint
defaults.

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

```sh
npm run bench:scicode -- inspect-data \
  --data /path/to/scicode/problems_all.jsonl

npm run bench:scicode -- generate-tasks \
  --data /path/to/scicode/problems_all.jsonl \
  --h5py-file /path/to/scicode/test_data.h5 \
  --out benchmarks/community/scicode/runs/tasks.yaml \
  --limit 3

clio eval run --task-file benchmarks/community/scicode/runs/tasks.yaml
```

For CI fixtures, the SciCode grader also accepts a small JSON target manifest
through `--references`. That mode is for adapter validation, not official
SciCode scoring.
