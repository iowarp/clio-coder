# Clio Coder benchmark reproducibility manifest

Generated 2026-06-15. Covers the SWE-bench Lite and Terminal-Bench 2.0 adapters.

## Clio under test
- repo: ~/iowarp/clio-coder
- commit: d03587766283fe82fe5e1bb4130438d06175de67 (branch v0.2.3, unpushed)
- version: Clio Coder 0.2.3
- launcher: ~/.local/bin/clio -> built dist of the checkout

## Fleet (model targets)
- orchestrator (main): target `mini`, runtime llamacpp, http://192.168.86.141:8080,
  model `Qwopus3.6-27B-Coder-MTP-Q5_K_M-262K`, thinkingLevel low
- workers (default): target `dynamo`, runtime lmstudio-native, http://192.168.86.143:1234,
  model `qwopus3.6-27b-v1-preview`, thinkingLevel low
- autonomy: full-auto; worker onPermission: deny
- sampler: server-owned defaults (Clio passes only model-family fields it owns); no
  temperature/top-p override unless `clio run --temperature/--top-p` is passed
- both endpoints probed reachable with the exact models loaded on 2026-06-15

## Host + tooling
- host: WSL2 (Linux 6.18), node v24.9.0, uv 0.9.2
- swebench 4.1.0 (uv tool), sb-cli (uv tool), terminal-bench `tb` (uv tool)
- dataset: princeton-nlp/SWE-bench_Lite, split test, 300 instances
  (django 114, sympy 77, scikit-learn 23, matplotlib 23, pytest 17, sphinx 16,
   astropy 6, pylint 6, requests 6, xarray 5, seaborn 4, flask 3)

## Docker (evaluation only)
- zbook local Docker Desktop with WSL integration, context `docker-desktop`, Docker 29.5.3,
  24 CPU, 99 GB. Everything (generation + eval) runs from zbook; mini and dynamo are used
  only as inference targets for the agent and fleet.
- Verified from inside a container: can reach the fleet (mini 192.168.86.141:8080) and the
  host tarball server (host.docker.internal:8899 and 192.168.86.235:8899), both HTTP 200.

## Adapters (this directory)
- swebench_clio.py — SWE-bench Lite patch generator. Clones repo@base_commit (full bare
  cache per repo, then a local checkout), runs `clio run --json` with the issue text,
  `git diff` -> model_patch, emits predictions.jsonl {instance_id, model_name_or_path,
  model_patch} plus metrics.jsonl {wall_s, tokens, exit, patch_bytes}. Plumbing validated
  end-to-end on psf/requests (clone -> checkout -> 76-file tree -> edit -> valid diff).
- tb_clio_agent/ — Terminal-Bench 2.0 agent. ClioAgent(AbstractInstalledAgent) installs
  Node + clio in the task container (install-clio.sh, needs CLIO_TARBALL_URL since clio is
  not on npm), writes the fleet settings.yaml, preflights fleet reachability, and runs
  `clio run` full-auto. Import path: `tb_clio_agent.clio_agent:ClioAgent`. Contract
  validated (loads, name=clio-coder, valid run command).

## Commands
SWE-bench Lite generation (host, drives fleet):
    python swebench_clio.py --instances pytest-dev__pytest-6116 --out runs/smoke --timeout 1800
SWE-bench Lite evaluation (zbook local Docker):
    uv tool run --from swebench python -m swebench.harness.run_evaluation \
      --dataset_name princeton-nlp/SWE-bench_Lite \
      --predictions_path runs/calib/predictions.jsonl --run_id clio-calib --max_workers 4
Terminal-Bench smoke (clio tarball served on the host LAN):
    python3 -m http.server 8899 --bind 0.0.0.0   # in ~/tmp/clio-bench, serves the tgz
    CLIO_TARBALL_URL=http://host.docker.internal:8899/iowarp-clio-coder-0.2.3.tgz \
    PYTHONPATH=~/tmp/clio-bench \
    tb run -d terminal-bench-core==0.1.1 --n-tasks 1 --n-concurrent 1 \
      --agent-import-path "tb_clio_agent.clio_agent:ClioAgent" \
      --output-path runs/tb-smoke

## Timing model and full-run estimate (MEASURED from the 4-instance calibration)
Per-instance generation on the fleet (clio run, sequential on mini):
- pylint-7080  183 s  22.9k tok
- pytest-6116   71 s  10.3k tok
- pytest-7432   97 s  13.3k tok
- sympy-20212  324 s  28.5k tok  (large repo, agent ran the test suite)
- mean ~169 s (~2.8 min), ~18.7k tokens/instance. All 4 produced clean single-file
  patches (367-1129 bytes) after the diff fix; none empty.

- SWE-bench Lite full (300, sequential generation): ~300 x 2.8 min ~= 14 hours wall on the
  fleet (plus one-time bare-clone of each of the 12 repos; sympy bare cache is 203 MB).
  Docker eval is separate and parallelizable on zbook (24 CPU): first image per repo is the
  cost, instances within a repo reuse it.
- Terminal-Bench 2.0: smoke was ~5 min/task end-to-end (container build + Node/clio install +
  agentic episode). A -k 5 / 5-task run is ~25-45 min wall, image and clio install dominate.

## Smoke results (measured)
- SWE-bench Lite, 4 small-patch instances: 2/4 RESOLVED (pytest-7432, sympy-20212),
  0 empty, 0 errors. Caveat: smallest-patch instances are the easy tail; the full-300
  resolve rate will be lower and selection-biased here.
- Terminal-Bench-core 0.1.1, task git-workflow-hack: 1/1 RESOLVED after the local-key fix
  (apiKeyEnvVar + dummy). Validates clio-in-container + fleet reachability + task solve.

## Go / no-go (updated with measured data)
SWE-bench Lite full 300: generation ~14h sequential on the fleet, eval a few hours on zbook
Docker. Feasible in ~1 day, but a real submission needs the full set, not the easy tail. The
2/4 here is encouraging but not projectable. Recommendation: if you want a number, run the
full 300 (overnight) rather than a blind partial; do NOT submit to any leaderboard without a
full, unbiased run. Terminal-Bench: a -k 5 run is cheap (~30-45 min); fine to run on request.
All full runs remain gated on your explicit go-ahead.

## Go / no-go
NO-GO on a blind full SWE-bench Lite run: 300 sequential local-27B episodes are multi-day,
and a 27B is unlikely to clear a meaningful resolve rate on SWE-bench Lite (strong frontier
models land ~30-50%; small local models typically land in low single digits). Spending days
of fleet time before knowing the resolve rate is not justified.
GO on a 3-5 instance calibration smoke first (smallest-patch instances across requests /
flask / pytest for fast clones and eval), to get real per-instance wall-time + token cost
and an actual resolved/failed count. That smoke is the input that decides any official run.
