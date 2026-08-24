# SWE-bench Clio adapter

`swebench_clio.py` generates SWE-bench Lite, Verified, or full prediction files
by cloning each selected instance, running `clio-coder run --json`, and
extracting a source-only patch from the checkout. `--dataset` accepts `lite`,
`verified`, or `full`; omitting it continues to select Lite. `--split` defaults
to `test`.

## Generate Predictions

```sh
uv run --no-project --with datasets --with swebench \
  python benchmarks/community/swe-bench-lite/swebench_clio.py \
  --target <id> \
  --instances pytest-dev__pytest-6116 \
  --out benchmarks/community/swe-bench-lite/runs/smoke \
  --timeout 1800
```

For the 500 human-validated instances commonly used in published reports, add
`--dataset verified`. `--all` still selects every row in the chosen dataset;
it has no new environment-variable gate.

`--target` is required and is forwarded to every `clio-coder run`; the adapter
never inherits the operator's default target. Pass `--model <id>` as an
optional explicit model override.

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

Official SWE-bench resolution still requires the external SWE-bench harness.
The adapter manifest records generation counts and artifact hashes only.
