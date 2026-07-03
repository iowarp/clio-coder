# SciCode Clio adapter

`scicode_clio.py` connects SciCode to Clio's `clio eval` command. It is a task
generator and grader, not a parallel eval framework.

## Data requirements

Prompt data and scoring data are external:

1. `problems_all.jsonl` from the public SciCode dataset.
2. `test_data.h5` from the official SciCode eval artifact for faithful scoring.
3. The upstream SciCode Python package when HDF5 scoring is used.

Do not commit those artifacts here. Pass their locations with `--data`,
`--h5py-file`, or `--references`.

## Commands

Inspect readiness:

```sh
python benchmarks/community/scicode/scicode_clio.py inspect-data \
  --data /path/to/scicode/problems_all.jsonl
```

Generate a small Clio eval file once the target artifact is available:

```sh
python benchmarks/community/scicode/scicode_clio.py generate-tasks \
  --data /path/to/scicode/problems_all.jsonl \
  --h5py-file /path/to/scicode/test_data.h5 \
  --out benchmarks/community/scicode/runs/tasks.yaml \
  --limit 3

clio eval run --task-file benchmarks/community/scicode/runs/tasks.yaml
```

Run or grade one problem directly:

```sh
python benchmarks/community/scicode/scicode_clio.py run-problem \
  --data /path/to/scicode/problems_all.jsonl \
  --problem-id 10 \
  --out benchmarks/community/scicode/runs/scicode-10

python benchmarks/community/scicode/scicode_clio.py grade-problem \
  --data /path/to/scicode/problems_all.jsonl \
  --problem-id 10 \
  --run benchmarks/community/scicode/runs/scicode-10 \
  --h5py-file /path/to/scicode/test_data.h5
```

`run-problem` writes `manifest.json` and `summary.json` with generated step
attempt counts and hashes for produced artifacts. `grade-problem` rewrites
those files with scored counts after target-based validation completes.

## Scoring rule

The grader executes each generated sub-step file with SciCode's visible test
snippets and injected target values. A main problem passes only when every
sub-step passes. Missing targets, no-test sub-steps, missing generated code, or
missing SciCode runtime dependencies are reported explicitly.

For adapter smoke tests, `--references` accepts a small JSON target manifest.
That path is only for CI fixtures and should not be used for official SciCode
numbers.
