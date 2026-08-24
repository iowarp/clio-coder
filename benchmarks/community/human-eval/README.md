# HumanEval adapter

`humaneval_clio.py` loads the 164 public HumanEval tasks, runs Clio directly in
one isolated directory per sample, extracts the completion, and applies the
HumanEval checks.

```sh
uv run --no-project python benchmarks/community/human-eval/humaneval_clio.py inspect-data

uv run --no-project --with "human-eval @ git+https://github.com/openai/human-eval.git" \
  python benchmarks/community/human-eval/humaneval_clio.py run \
  --target dynamo --model qwen3.8-27b \
  --task-id HumanEval/0 --task-id HumanEval/17 \
  --evaluator official --out benchmarks/community/human-eval/runs/sample
```

`run-task` and `grade-task` support one interactive/prepared workspace;
`regrade` scores an existing run without another model call. `--dry-run`
prepares workspaces without requiring a target.

Outputs include JSONL events, `solution.py`, `completion.py`, samples,
per-attempt metrics, grader results, `manifest.json`, and `summary.json`. They
remain under the ignored `runs/` directory.

Grading executes generated Python. Use a sandbox for untrusted output and pin
the upstream evaluator revision for reported campaigns.
