# DS-1000

1000 data-science problems taken from StackOverflow across seven libraries:
Pandas (291), NumPy (220), Matplotlib (155), Scikit-learn (115), SciPy (106),
PyTorch (68), and TensorFlow (45). Every problem carries its own execution
harness in `code_context`, and 159 of them add a `test_string` surface-form
check that tokenizes the snippet and asserts a required API appears in it, so
a hardcoded answer that happens to produce the right value still fails.

The adapter loads the dataset, seeds one workspace per problem, runs
`clio-coder run --json` once per sample, and hands the snippet to the upstream
`code_context` unmodified. `code_context` is the authoritative grader.

## Data

```sh
uv run --no-project python benchmarks/community/ds-1000/ds1000_clio.py ensure-data
uv run --no-project python benchmarks/community/ds-1000/ds1000_clio.py inspect-data
```

`ensure-data` downloads `data/ds1000.jsonl.gz` from the upstream repository into
this suite's ignored `data/` directory. Set `DS1000_DATA` or pass `--data` to
point at a copy that is already on disk.

## Run

```sh
uv run --no-project python benchmarks/community/ds-1000/ds1000_clio.py run \
  --target dynamo --model qwen3.8-27b --library Pandas --limit 10 \
  --out benchmarks/community/ds-1000/runs/pandas-smoke
```

`--library` is repeatable and accepts `Pandas`, `Numpy`, `Matplotlib`, `Scipy`,
`Sklearn`, `Pytorch`, and `Tensorflow`. `--task-id` takes `DS-1000/0` or bare
`0`. `regrade` rescores a finished run directory without calling a model again,
which matters because a full 1000-task pass costs hours of a local fleet.

## Task contract

The agent gets `problem.md` with the statement and a `solution.py` seeded with
a marker line. The graded snippet is everything after that marker. The grader
inserts the snippet into a prepared namespace where the input variables already
exist, so the snippet must not redefine inputs or add a main block; the rendered
prompt says so. An agent that answers with a fenced code block instead of
editing the file still gets scored, and `snippetSource` in the results records
that it did, so those attempts can be subtracted from a headline number.

## Grading environment

Dependencies are resolved per problem from `metadata.library` plus the imports
in that task's own `code_context`, so scoring a Pandas problem does not install
TensorFlow and a NumPy task that explicitly imports `scipy.stats` still gets
SciPy. Matplotlib problems run under `MPLBACKEND=Agg` because they save a
figure.

DS-1000's published numbers came from a 2022 reference environment with pinned
library versions. A modern resolve can fail a problem for environment reasons
rather than model reasons. Pin the environment for a comparable campaign:

```sh
... run --with 'pandas==1.3.5' --with 'numpy==1.21.6' ...
```

`--with` is repeatable and replaces the derived set rather than adding to it,
so a pinned campaign cannot also resolve an unpinned copy of the same package.
`DS1000_GRADER_WITH` takes the same list as a comma-separated environment
variable.

## Safety

Grading executes model-generated Python with real numerical libraries in the
process. Run this adapter in a container or other sandbox for untrusted models
or prompts.
