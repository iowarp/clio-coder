# SciCode Data Manifest

Status: local data present, scoring targets absent.

## Provenance

- Upstream benchmark: SciCode, "SciCode: A Research Coding Benchmark Curated by Scientists".
- Paper: arXiv 2407.13168.
- GitHub: https://github.com/scicode-bench/SciCode.
- GitHub license: Apache-2.0.
- Hugging Face dataset: https://huggingface.co/datasets/SciCode1/SciCode.
- Hugging Face revision checked: `4510f6a6aa27c43fad7b43da2c59602a86e88480`.
- Hugging Face card license checked: `apache-2.0`.

## Local Contents

This directory currently contains an untracked local copy of the SciCode prompt
corpus:

- `problems_all.jsonl`: 80 problems, 341 sub-steps, 1,082 visible sub-step test
  snippets, and 302 visible general test snippets.
- `background_comment_template.txt`: prompt template for stepwise solution
  generation.
- `13.6.txt`, `62.1.txt`, `76.3.txt`: upstream support snippets for no-test or
  special previous-step cases.

These data files are intentionally ignored by git through this directory's
`.gitignore`. Do not force-add them without an explicit release decision.

## Missing For Faithful Scoring

The visible test snippets mostly assert against a prebound `target` value.
Those target values are not present in this directory.

Upstream faithful scoring requires the numeric target artifact described by
SciCode as `eval/data/test_data.h5`, loaded through
`process_hdf5_to_tuple(step_id, test_count, h5py_file)`. That HDF5 file is not
committed here. It should be fetched or mounted as an external artifact and
verified by checksum before official runs.

The Clio adapter in `benchmarks/community-benchmarks/scicode/scicode_clio.py`
can generate `clio eval` task files now. It grades real runs only when supplied
with either the official HDF5 target file and SciCode Python package, or a small
JSON target manifest for smoke fixtures.
