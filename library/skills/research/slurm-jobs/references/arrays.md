# Job arrays through the Slurm MCP server

Read this before setting `array` on `mcp_slurm__slurm_submit`.

## The array expression

`array` takes a Slurm task expression: a range `0-31`, a stepped range
`1-100:2`, a list `2,5,9`, and an optional `%N` suffix that caps how many tasks
run at once (`0-99%8`). The server rejects anything else before calling
`sbatch`.

## What the server submits

In array mode the server does not submit your script as written. It writes a
new temporary script with its own header, then your script's body without its
shebang:

```text
#!/bin/bash
#SBATCH --array=<array>
#SBATCH --cpus-per-task=<cores>
#SBATCH --job-name=<job_name, default array_job>
#SBATCH --output=logs/slurm_output/slurm_%A_%a.out
#SBATCH --error=logs/slurm_output/slurm_%A_%a.err
#SBATCH --mem=<memory>  --time=<time_limit>  --partition=<partition>
echo "Array job ${SLURM_ARRAY_JOB_ID}, task ${SLURM_ARRAY_TASK_ID}"
echo "Running on node: $(hostname)"
<your script body>
```

`sbatch` stops reading `#SBATCH` directives at the first command, and the two
`echo` lines come before your body. So none of your script's own directives
apply to an array: not `--ntasks`, `--nodes`, `--gres`, `--account`,
`--constraint` or `--mail-type`. Each task gets one task with `cores` CPUs. If a
task needs more ranks, nodes or GPUs, do not use `array`: submit one ordinary
job per parameter set, where the script's directives do apply.

Each task starts in the server's working directory, not the script's directory,
and runs from a temporary copy of the script. Use absolute paths for inputs and
outputs. Its stdout and stderr land in
`logs/slurm_output/slurm_<array job id>_<task id>.out` and `.err` under that
working directory. A user `mcp.yaml` entry without `cwd` runs the server in
Clio's config directory, so the logs land there; `slurm_describe` returns the
actual paths.

Inside a task, Slurm sets `SLURM_ARRAY_JOB_ID`, `SLURM_ARRAY_TASK_ID`,
`SLURM_ARRAY_TASK_COUNT`, `SLURM_ARRAY_TASK_MIN` and `SLURM_ARRAY_TASK_MAX`.

## Polling and output

The submission returns the array job id with `kind: "array"`. Poll and fetch
each task by its own id, `<array job id>_<task id>`, with
`mcp_slurm__slurm_describe`. Never read the bare array id as the array's state:
the server folds every task record that `scontrol show job <id>` prints into one
description, so the bare id reports a single task's state and output.

`mcp_slurm__slurm_list` may fail on a queue that holds pending array tasks,
because squeue can print them in the compact form `<id>_[4-31%8]`, which the
server's job id check rejects. If it does, describe the task ids the array
expression names instead.

The array is done when every task is terminal. Report each task's line, then
one tally: how many tasks `COMPLETED` with exit 0, and which failed. A failed
task is a finding. Resubmit only the failed ids, as a new array such as `2,5,9`,
and only when the operator asks.

## Sweep hook

A parameter sweep is an array plus a manifest. This skill submits the array and
reports each task; a sweep playbook owns the manifest and the comparison. The
contract between them:

- The manifest is one file with an absolute path and one parameter set per line,
  with no header. Task `N` reads line `N + 1`
  (`sed -n "$((SLURM_ARRAY_TASK_ID + 1))p" /abs/params.tsv`).
- The array expression is `0-<lines - 1>`, with an optional `%N` cap.
- Each task writes its results under `<absolute results dir>/<task id>/`.
- The final answer records the manifest path and its sha256 next to the array
  job id, so each task line maps back to the exact parameters it ran.
