# Benchmark result manifests

This directory is the committed home for sanitized benchmark result records.

Only this shape is tracked:

```text
benchmarks/results/<suite>/<run-id>/manifest.json
benchmarks/results/<suite>/<run-id>/summary.json
```

`manifest.json` records provenance and run metadata. `summary.json` records the
compact aggregate result for the same run. Raw logs, model streams, cloned
repositories, event JSONL, private fleet configs, and dataset mirrors are
generated outside tracked results.

Internal eval suites and private calibration artifacts are not tracked in this
repository. Use `clio-coder eval report` or the community adapters to produce public
manifests when a result is ready to share.
