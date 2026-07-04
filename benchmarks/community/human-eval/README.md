# OpenAI HumanEval adapter

`humaneval_clio.py` runs the public OpenAI HumanEval tasks with Clio Coder and
scores generated Python against the HumanEval checks. It supports direct suite
runs and `clio eval` task-file generation for exercising the Clio eval harness.

External data is not tracked. The adapter can load HumanEval from one of:

1. `--data /path/to/HumanEval.jsonl.gz` or `.jsonl`.
2. `benchmarks/community/human-eval/data/HumanEval.jsonl.gz` after
   `ensure-data`.
3. The upstream `human_eval` Python package.

> Grading executes model-generated Python. Run in a container or sandbox when
> benchmarking untrusted models.

## Setup

```sh
# Download only the public JSONL.GZ into the untracked adapter data dir.
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py ensure-data

# Optional: run with the official package/evaluator available to uv.
uv run --no-project --with "human-eval @ git+https://github.com/openai/human-eval.git" \
  python benchmarks/community/human-eval/humaneval_clio.py inspect-data
```

Check readiness:

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py inspect-data
```

## Direct run

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py run \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/smoke \
  --timeout 300
```

Useful options:

- `--task-id HumanEval/0` (or `--task-id 0`) selects explicit tasks.
- `--all` runs all 164 tasks.
- `--samples-per-task N --pass-at 1 --pass-at 10` records multiple samples and
  reports pass@k estimates.
- `--target` and `--model` are forwarded to `clio run`.
- `--evaluator auto|official|subprocess` defaults to the official evaluator when
  installed and otherwise uses the adapter's subprocess fallback.

Outputs include `samples.jsonl` (official-compatible completions),
`metrics.jsonl`, `results.jsonl`, `manifest.json`, and `summary.json`.

## Clio eval harness run

Generate a normal v1 task file, then run it with Clio eval:

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py generate-tasks \
  --limit 5 \
  --out benchmarks/community/human-eval/runs/tasks.yaml \
  --run-root benchmarks/community/human-eval/runs/eval-smoke

clio eval run --task-file benchmarks/community/human-eval/runs/tasks.yaml
```

Each generated task runs `run-task` during setup and `grade-task` as verifier.
The per-task run directories are under the selected `--run-root`.

## Result policy

Keep raw outputs under `benchmarks/community/human-eval/runs/` or another
untracked scratch directory. Commit only sanitized community benchmark manifests
under `benchmarks/results/human-eval/<run-id>/` when publishing results.
