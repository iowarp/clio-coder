# SciCode Clio Adapter

`scicode_clio.py` connects SciCode to Clio's existing `clio eval` domain. It is
a generator plus grader, not a parallel eval framework.

## Data Requirements

Prompt data:

- Local path: `benchmarks/data/science-problems/problems_all.jsonl`.
- Upstream: `SciCode1/SciCode` on Hugging Face and `scicode-bench/SciCode` on
  GitHub.
- License checked: Apache-2.0.

Scoring data:

- Required for official scoring: SciCode `eval/data/test_data.h5`.
- Also required for HDF5 scoring: the upstream SciCode Python package, which
  provides `scicode.parse.parse.process_hdf5_to_tuple`.
- Not present in this repository. Do not commit it here.

Without the scoring data, the adapter can render prompts and task files but
grading exits blocked.

## Commands

Inspect local readiness:

```sh
python benchmarks/community-benchmarks/scicode/scicode_clio.py inspect-data \
  --data benchmarks/data/science-problems/problems_all.jsonl
```

Generate a small Clio eval file once the HDF5 target artifact is mounted:

```sh
python benchmarks/community-benchmarks/scicode/scicode_clio.py generate-tasks \
  --data benchmarks/data/science-problems/problems_all.jsonl \
  --h5py-file /path/to/test_data.h5 \
  --out .clio-scicode/tasks.yaml \
  --limit 3

clio eval run --task-file .clio-scicode/tasks.yaml
```

Run or grade one problem directly:

```sh
python benchmarks/community-benchmarks/scicode/scicode_clio.py run-problem \
  --data benchmarks/data/science-problems/problems_all.jsonl \
  --problem-id 10 \
  --out .clio-scicode/scicode-10

python benchmarks/community-benchmarks/scicode/scicode_clio.py grade-problem \
  --data benchmarks/data/science-problems/problems_all.jsonl \
  --problem-id 10 \
  --run .clio-scicode/scicode-10 \
  --h5py-file /path/to/test_data.h5
```

## Scoring Rule

The grader executes each generated sub-step file with SciCode's visible test
snippets and injected target values. A main problem passes only when every
sub-step passes. Missing targets, no-test sub-steps, missing generated code, or
missing SciCode runtime dependencies are reported explicitly instead of being
counted as a pass.

For adapter smoke tests, `--references` accepts a small JSON target manifest.
That path is only for CI fixtures and should not be used for official SciCode
numbers.
