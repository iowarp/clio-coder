# Community benchmark adapters

These adapters are thin external scorers around `clio-coder run --json`. They
do not use or extend `clio-coder eval`.

| Suite | Adapter responsibility | Authoritative score |
| --- | --- | --- |
| HumanEval | Load tasks, seed `solution.py`, capture a completion | HumanEval `check(entry_point)` |
| SciCode | Render sequential scientific sub-steps and snapshot code | Upstream SciCode targets from `test_data.h5` |
| SWE-bench Lite/Verified/full | Clone `repo@base_commit` and emit a source patch | Official SWE-bench Docker harness |
| Terminal-Bench | Install the candidate tarball in the task container | Terminal-Bench runner output |
| DS-1000 | Seed a data-science workspace and capture one snippet | The problem's own `code_context`, including its surface-form check |
| LiveCodeBench | Index a dated release and seed one program per problem | The problem's own public and private test cases |
| BigCodeBench | Seed a self-contained module under a long instruction | The task's own `unittest` suite |
| MultiPL-E | Seed a C++, Rust, or Julia file and capture a completion | The translated test block, compiled and run |
| ScienceAgentBench | Stage one task's dataset and capture a program | The task's own evaluation program |
| CORE-Bench | Prepare a Code Ocean capsule at a difficulty level | Prediction interval over the capsule's gold runs |

Every model-running command requires an explicit `--target`. Pass `--model`
as well for a reproducible campaign. Set `CLIO_CODER_BIN` to the candidate
launcher when the internal harness supplies an isolated home.

Run scripts through `uv run --no-project`; generated data and output belong in
each suite's ignored `data/` and `runs/` directories.

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py run \
  --target dynamo --model qwen3.8-27b --limit 5 \
  --out benchmarks/community/human-eval/runs/smoke

uv run --no-project python benchmarks/community/scicode/scicode_clio.py run-problem \
  --target dynamo --model qwen3.8-27b --problem-id 1 \
  --out benchmarks/community/scicode/runs/problem-1

uv run --no-project python benchmarks/community/ds-1000/ds1000_clio.py run \
  --target dynamo --model qwen3.8-27b --library Pandas --limit 5 \
  --out benchmarks/community/ds-1000/runs/pandas-smoke

uv run --no-project python benchmarks/community/livecodebench/livecodebench_clio.py run \
  --target dynamo --model qwen3.8-27b --release v6 --start-date 2025-02-01 --limit 5 \
  --out benchmarks/community/livecodebench/runs/v6-smoke
```

Each suite directory carries its own README with that suite's data command,
selection flags, and scoring rule. Every suite fetches its own dataset through
`ensure-data` except two: ScienceAgentBench needs an operator-supplied
`benchmark_verified.zip` that upstream withholds to slow contamination, and
CORE-Bench needs `gpg` on PATH to decrypt its test split. Both say so precisely
rather than failing deeper in.

Raw JSONL, prompts, completions, grader reports, manifests, and summaries are
run artifacts. They are not versioned. A publishable report is derived from an
immutable internal campaign after its provenance and secrets have been audited.

HumanEval and SciCode execute model-generated Python. Use a container or other
appropriate sandbox for untrusted models or prompts.

The other execution-graded suites carry the same exposure or more. MultiPL-E
compiles and runs native binaries, and CORE-Bench at `medium` or `hard` expects
the agent to install software and run a paper's code. Run those in a container.
