# SciCode adapter

`scicode_clio.py` renders a SciCode problem's sequential sub-steps, runs Clio
directly for each step, preserves earlier implementations, and scores every
snapshot against upstream target values.

Required external data belongs in the ignored `data/` directory:

- `problems_all.jsonl`
- `test_data.h5`
- the three special step snippets and background template supplied upstream.

```sh
uv run --no-project python benchmarks/community/scicode/scicode_clio.py inspect-data

uv run --no-project python benchmarks/community/scicode/scicode_clio.py run-problem \
  --target dynamo --model qwen3.8-27b --problem-id 1 \
  --out benchmarks/community/scicode/runs/problem-1

uv run --no-project python benchmarks/community/scicode/scicode_clio.py grade-problem \
  --problem-id 1 --run benchmarks/community/scicode/runs/problem-1
```

The adapter pins the upstream SciCode source revision and the compatible
PyArrow grader release. Override `SCICODE_PIP_SPEC` only when deliberately
testing another recorded revision. `--references` is only a small deterministic
self-test path, not official scoring.

Generation success and scientific correctness are distinct. Only
`grade-problem` can mark a main problem resolved; a generated step merely
records that Clio exited and left code to score.
