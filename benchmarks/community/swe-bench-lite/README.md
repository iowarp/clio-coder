# SWE-bench Lite Clio adapter

`swebench_clio.py` generates SWE-bench Lite prediction files by cloning each
selected instance, running `clio run --json`, and extracting a source-only
patch from the checkout.

## Generate Predictions

```sh
uv run --no-project --with datasets --with swebench \
  python benchmarks/community/swe-bench-lite/swebench_clio.py \
  --instances pytest-dev__pytest-6116 \
  --out benchmarks/community/swe-bench-lite/runs/smoke \
  --timeout 1800
```

Each run directory receives:

```text
predictions.jsonl
metrics.jsonl
manifest.json
summary.json
```

The manifest is portable. It records the public dataset name, model label,
sanitized target profile, Clio version, Clio commit, aggregate counts, and
SHA-256 hashes for the prediction and metric artifacts. It does not record
private fleet URLs, local cache paths, raw event streams, or checkout paths.

## Recompute Patches

If a run already has checkouts, recompute source-only patches without another
model call:

```sh
uv run --no-project python benchmarks/community/swe-bench-lite/recompute_patches.py \
  benchmarks/community/swe-bench-lite/runs/smoke \
  clio-coder-example
```

This also refreshes `manifest.json` and `summary.json`.

## SWE JSONL From Eval Artifacts

When a task is run through `clio eval`, export SWE-style JSONL with:

```sh
clio eval report <evalId> --format swe-jsonl > predictions.jsonl
```

The JSONL records include `instance_id`, `model_name_or_path`, `model_patch`,
and pass status fields. Use this path when a benchmark suite is represented as
a Clio eval artifact rather than a direct SWE-bench adapter run.

Official SWE-bench resolution still requires the external SWE-bench harness.
The adapter manifest records generation counts and artifact hashes only.
