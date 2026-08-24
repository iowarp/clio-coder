# LiveCodeBench

Competitive-programming problems from LeetCode, AtCoder, and Codeforces with
their contest dates attached. The dates are the reason to run it: restricting a
run to contests published after a model's training cutoff is the cheapest
contamination-resistant number available for a local model.

The adapter loads a release index, seeds one workspace per problem, runs
`clio-coder run --json` once per sample, and executes the resulting program
against the problem's own test cases. LeetCode problems are `functional`, so
the program defines `class Solution` and the grader calls one method with
decoded JSON arguments. AtCoder and Codeforces problems are `stdin`, so the
program is run as a script and its stdout is compared line by line.

## Data

The release files are large. `test.jsonl` alone is about 1.2 GB and the full
cumulative `release_v6` is about 4.3 GB, nearly all of it compressed test
cases.

```sh
# 128 MB: only the problems release v6 added, the newest window
uv run --no-project python benchmarks/community/livecodebench/livecodebench_clio.py \
  ensure-data --release v6

# 4.3 GB: every problem through release v6
uv run --no-project python benchmarks/community/livecodebench/livecodebench_clio.py \
  ensure-data --release release_v6
```

A bare `vN` is the single file that release added. `release_vN` is cumulative.
`ensure-data` streams each file once and writes `index-<release>.jsonl` holding
every field except the compressed test cases, recording the byte offset of the
source line instead. Selection, inspection, and prompting run off the index; a
task's test cases are decoded only when that task is graded.

```sh
uv run --no-project python benchmarks/community/livecodebench/livecodebench_clio.py \
  inspect-data --release v6
```

## Run

```sh
uv run --no-project python benchmarks/community/livecodebench/livecodebench_clio.py run \
  --target dynamo --model qwen3.8-27b --release v6 \
  --start-date 2025-02-01 --difficulty easy --limit 10 \
  --out benchmarks/community/livecodebench/runs/v6-feb-easy
```

`--start-date` and `--end-date` filter on `contest_date` and are what make a
number defensible: set the start after the candidate model's training cutoff
and say so in the report. `--platform` and `--difficulty` are repeatable.
`regrade` rescores a finished run directory without calling a model again.

## Grading

A task passes when the program passes every selected test case. Grading stops
at the first failing test, because the verdict cannot change after that.

`--tests public` grades only the visible example cases. That is a much weaker
claim than the upstream score and it is recorded as `testSet` in the summary
and the results, so it can never be mistaken for one. `--tests all` is the
default and matches upstream.

`--test-timeout` defaults to 10 seconds per case, so an accepted answer has to
be fast enough rather than merely correct. The graded program is prepended with
the same standard-library import block upstream assumes, and `sortedcontainers`
and `numpy` are available; `--with` replaces that dependency set.

## Compressed test cases

Upstream stores private test cases as base64 of zlib of a pickle, and decodes
them with a plain `pickle.loads`. That is arbitrary code execution against a
downloaded file. The pickled object is only ever a JSON string, so this adapter
decodes it with an unpickler that refuses every global. A payload that needs
one is refused rather than executed.

## Safety

Grading executes model-generated Python. Run this adapter in a container or
other sandbox for untrusted models or prompts.
