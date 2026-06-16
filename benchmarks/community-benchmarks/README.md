# Clio Coder community benchmarks

Adapters for running Clio Coder against popular external coding benchmarks. These are
separate from Clio's native benchmarks in the parent `benchmarks/` directory (the context
engine and model suites). Everything here is Clio's first pass at the community harnesses,
driven by a local model fleet.

```
community-benchmarks/
  MANIFEST.md                       reproducibility manifest (commit, models, params, timings)
  swe-bench-lite/
    swebench_clio.py                patch generator (clone -> clio run -> git diff -> jsonl)
    recompute_patches.py            re-derive clean patches from existing checkouts
  terminal-bench/
    tb_clio_agent/                  Terminal-Bench 2.0 agent (AbstractInstalledAgent)
```

## Fleet and machine layout

Generation runs on the host (e.g. zbook) and drives the fleet for inference only:
- main / orchestrator: `mini`, llama.cpp, `http://192.168.86.141:8080`,
  `Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K`
- workers: `dynamo`, LM Studio, `http://192.168.86.143:1234`, `qwopus3.6-27b-v1-preview`
- autonomy `full-auto`, thinking `low`

Docker (SWE-bench eval, Terminal-Bench containers) runs locally on the host. The fleet
nodes are not used for Docker. Both `192.168.86.x` endpoints must be reachable from the host
and, for Terminal-Bench, from inside task containers (verified: a container can curl the
fleet directly on the default bridge network).

## Tooling

```sh
uv tool install swebench          # swebench harness (python -m swebench.harness.run_evaluation)
uv tool install sb-cli            # optional cloud eval CLI
uv tool install terminal-bench    # tb CLI (Terminal-Bench 2.0)
```

## SWE-bench Lite

Per instance the adapter clones `repo@base_commit` into an isolated checkout, runs
`clio run --json` with the issue text, and diffs the working tree against base into
`model_patch`. It emits `predictions.jsonl` ({instance_id, model_name_or_path, model_patch})
and `metrics.jsonl` (wall_s, tokens, exit, patch_bytes).

```sh
cd swe-bench-lite
# generate (drives the fleet, sequential on mini)
uv tool run --from swebench --with datasets python swebench_clio.py \
  --instances pytest-dev__pytest-7432 sympy__sympy-20212 \
  --out runs/smoke --timeout 1800 --model-name clio-coder-qwopus3.6-27b
# or pick the smallest-patch instances: --smallest --limit 4
# evaluate (local Docker)
uv tool run --from swebench python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path runs/smoke/predictions.jsonl --run_id clio-smoke --max_workers 4
```

The model_patch is the SOURCE diff only. The adapter excludes Clio's own `.clio/` index
(codewiki.json is ~100k lines) and never stages untracked build/test artifacts, so patches
stay small. If you have checkouts from an older run with polluted patches, re-derive clean
ones without re-running the fleet:

```sh
python recompute_patches.py runs/smoke clio-coder-qwopus3.6-27b
```

## Terminal-Bench 2.0

`ClioAgent` (in `tb_clio_agent/`) subclasses Terminal-Bench's `AbstractInstalledAgent`. It
installs Node and Clio into the task container, writes a fleet `settings.yaml`, preflights
fleet reachability, and runs `clio run` full-auto.

Clio is not on npm, so serve the `npm pack` tarball where containers can reach it:

```sh
# from the clio-coder checkout: build then pack
npm run build && npm pack --pack-destination /tmp/clio-pack
# serve it on the host (host.docker.internal works on Docker Desktop)
( cd /tmp/clio-pack && python3 -m http.server 8899 --bind 0.0.0.0 & )

cd terminal-bench
CLIO_TARBALL_URL=http://host.docker.internal:8899/iowarp-clio-coder-0.2.3.tgz \
PYTHONPATH=$PWD \
tb run -d terminal-bench-core==0.1.1 -t git-workflow-hack --n-concurrent 1 \
  --agent-import-path "tb_clio_agent.clio_agent:ClioAgent" \
  --output-path runs/smoke
```

Local llama.cpp and LM Studio ignore the API key value but Clio requires one to resolve, and
a fresh in-container install has no stored credential. The rendered `settings.yaml` therefore
uses `apiKeyEnvVar` and the agent exports a dummy `CLIO_LLAMACPP_KEY` / `CLIO_LMSTUDIO_KEY`.
Override fleet endpoints, models, and the per-task timeout with `--agent-kwarg` or the
`CLIO_*` env vars documented in `clio_agent.py`.

## Status of the first pass

See `MANIFEST.md` for the measured calibration. In short: SWE-bench Lite 2/4 on a
small-patch (easy-tail, selection-biased) calibration set, and Terminal-Bench 1/1 on
`git-workflow-hack`, both with the local 27B fleet. Full runs are intentionally not part of
this first pass.
