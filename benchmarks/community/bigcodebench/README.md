# BigCodeBench

1140 tasks that each call several libraries under a long natural-language
instruction, graded by the task's own `unittest` suite rather than by a handful
of assertions. The `hard` variant is the 148-task subset the authors curated as
the discriminating slice. It is the successor to HumanEval for general Python:
longer instructions, a much wider library surface, and real test cases with
mocks and edge cases.

The adapter loads the dataset, seeds one workspace per task, runs
`clio-coder run --json` once per sample, and runs the task's `test` against the
generated module. The upstream test suite is the authoritative grader.

## Data

```sh
uv run --no-project python benchmarks/community/bigcodebench/bigcodebench_clio.py \
  ensure-data --variant hard
uv run --no-project python benchmarks/community/bigcodebench/bigcodebench_clio.py \
  inspect-data --variant hard
```

`--variant full` is all 1140 tasks; `--variant hard` is the 148-task subset.
`--split` selects the dataset version and defaults to `v0.1.4`. `ensure-data`
pages the public rows API and writes JSONL into this suite's ignored `data/`
directory, so the adapter needs no parquet or datasets dependency.

## Run

```sh
uv run --no-project python benchmarks/community/bigcodebench/bigcodebench_clio.py run \
  --target dynamo --model qwen3.8-27b --variant hard --limit 10 \
  --out benchmarks/community/bigcodebench/runs/hard-smoke
```

`--setting instruct` is the default and gives the agent the natural-language
instruction, which is the setting that matches an agent. `--setting complete`
gives the docstring-style prompt instead. `--lib` keeps only tasks that use a
named library, which is useful for scoping a run to the parts of the library
surface a target machine actually has. `regrade` rescores a finished run
directory without calling a model again.

## Grading environment

Dependencies are resolved per task from its `libs` field plus imports in that
task's code prompt and upstream tests, so a test-only `faker` or `PIL` import is
present without installing the whole BigCodeBench environment. Standard-library
modules are dropped, and import names that differ from their distribution names
are mapped explicitly (`sklearn` to `scikit-learn`, `Crypto` to `pycryptodome`,
`bs4` to `beautifulsoup4`, `PIL` to `pillow`, `cv2` to
`opencv-python-headless`, removed `cgi` to `legacy-cgi`, and `keras` to its
TensorFlow backend, among others). The hard subset spans 41 distinct
third-party distributions.

`--with` pins the environment for a comparable campaign and replaces the
derived set rather than adding to it. `BIGCODEBENCH_GRADER_WITH` takes the same
list as a comma-separated environment variable. `--grade-timeout` defaults to
120 seconds because it covers dependency resolution as well as the tests.

## Safety

Grading executes model-generated Python. Some tasks touch the filesystem and
some exercise network client code behind mocks. The grader runs inside a
throwaway directory so a task that writes beside its module cannot reach the
run directory or the repository, but that is containment, not a sandbox. Run
this adapter in a container for untrusted models or prompts.
