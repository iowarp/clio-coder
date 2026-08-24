# Terminal-Bench adapter

This custom installed agent gives Terminal-Bench one blocking
`clio-coder run` episode. Terminal-Bench continues to own task setup, timeout,
container logs, tests, and reward.

Prerequisites are Terminal-Bench 0.2.18+, a running Docker daemon, a candidate
tarball reachable from task containers, and a model endpoint reachable from
those containers. The adapter refuses registry installs and refuses implicit
target, model, runtime, thinking, URL, or tarball values.

```sh
npm pack --pack-destination benchmarks/internal/runs/<campaign>/terminal-bench/candidate

PYTHONPATH=benchmarks/community/terminal-bench \
CLIO_CODER_TARBALL_URL=http://<docker-host>:<port>/iowarp-clio-coder-0.3.6.tgz \
CLIO_CODER_MAIN_URL=http://<model-host>:<port> \
tb run \
  --dataset terminal-bench-core==0.1.1 \
  --task-id hello-world \
  --agent-import-path tb_clio_coder.clio_coder:ClioCoder \
  --agent-kwarg main_target=dynamo \
  --agent-kwarg main_model=qwen3.8-27b \
  --agent-kwarg main_runtime=lmstudio \
  --agent-kwarg main_thinking=off \
  --output-path benchmarks/internal/runs/<campaign>/terminal-bench/output \
  --run-id hello-world-attempt-1 \
  --n-concurrent 1 --n-attempts 1 --no-upload-results
```

Record the dataset version, task ID, Terminal-Bench version, tarball SHA-256,
container reachability check, and final reward. A missing Docker daemon,
unreachable tarball/model endpoint, install failure, or missing scorer output is
`harnessStatus=blocked` or `invalid`; it is not a failed model task.
