# Community benchmark adapter manifest

This manifest documents the public adapters in this directory. It intentionally
does not record private endpoints, workstation paths, local cache locations, or
raw run outputs.

## Current adapter set

1. `swe-bench-lite/swebench_clio.py` generates SWE-bench Lite predictions. It
   clones `repo@base_commit`, runs `clio-coder run --json`, extracts a source diff,
   and writes prediction and metric files in the selected run directory.
2. `terminal-bench/tb_clio_coder/` provides a Terminal-Bench 2.0 installed
   agent. It installs Clio in the task container, renders settings from
   `CLIO_CODER_*` environment variables, and runs one headless episode per task.
3. `scicode/scicode_clio.py` generates v1 `clio-coder eval` task files for SciCode
   and grades generated Python with an externally supplied target artifact.
4. `human-eval/humaneval_clio.py` runs OpenAI HumanEval completions directly or
   through generated v1 `clio-coder eval` tasks, then grades generated Python against
   the public HumanEval checks.

## Data and fleet policy

External datasets are not tracked here. Mount or download them into an
untracked location and pass their paths on the command line.

Fleet configuration is private. Use an untracked
`benchmarks/community/fleet.json`, or set `CLIO_CODER_FLEET` to a private file with
the same shape as `fleet.example.json`. Terminal-Bench endpoint variables must
be supplied through the environment for each run.

## Result policy

Raw adapter output belongs under an untracked `runs/` directory or another
operator-selected scratch path. Shareable summaries go under
`benchmarks/results/<suite>/<run-id>/` as `manifest.json` and `summary.json`.

## Historical note

The original adapter calibration recorded private machine details. Those
details are no longer tracked. Public results should be regenerated as
sanitized manifests before they are committed.
