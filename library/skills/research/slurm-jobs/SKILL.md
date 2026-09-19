---
name: slurm-jobs
description: "Submits a batch script to Slurm through the clio-kit Slurm MCP server, polls it to a terminal state, fetches its output, and stamps the scheduler job id into the final answer. Not for writing the science inside the script or for interactive allocations."
triggers:
  - submit this job to slurm
  - run this on the cluster
  - sbatch this script
  - check my slurm job
  - cancel my slurm job
  - is the queue busy
version: 0.1.0
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/research/slurm-jobs
  audit: pass
  provenance: designed
  eval-status: smoke-checked
  model-size: any
---

# Slurm Jobs

Run one batch job end to end through the five `mcp_slurm__*` gateway
capabilities, and leave a record another person can check: the job id, the
terminal state, and where the output is. A job that was submitted but never
described to a terminal state is not a result.

Anti-trigger: if the question is what the script should compute, or why its
numbers are wrong, settle that first; use experiment-protocol or
scientific-debugging. This skill moves a finished script through the
scheduler.

## Arguments

```text
/skill slurm-jobs <script path, resources, and what to report>
```

## Phase 0 - Prerequisite check

1. `gateway(op="find", query="slurm")`. The listing must show a server with id
   `slurm` and the capabilities `mcp_slurm__slurm_submit`, `mcp_slurm__slurm_list`,
   `mcp_slurm__slurm_describe`, `mcp_slurm__slurm_cluster`, and
   `mcp_slurm__slurm_cancel`.
2. If the server is missing, stop and tell the operator to declare it (the
   entry is in the Slurm guide, `docs/guide/slurm.md`) and to run
   `clio-coder doctor`, which reports `clio-kit`, the declaration, and
   `sbatch`. If it is listed `untrusted` or `stale`, give the remedy the
   listing prints. Do not fall back to `bash` with `sbatch`: the operator chose
   the mediated path.
3. `gateway(op="describe", capability="mcp_slurm__slurm_submit")` once, and
   use the parameter names it returns. Do not guess them.

Every call to these capabilities asks the operator for approval, reads
included, because an MCP server carries one action class for all of its
tools. Poll sparingly. In a headless run the approval is denied: report that
the run needs an operator and stop.

## Phase 1 - Look before submitting

`mcp_slurm__slurm_cluster` with the target partition, no node details. Confirm
the partition exists and is up. Read the script with `read` and check that its
`#SBATCH` lines agree with the resources you are about to request; the call's
`cores`, `memory`, `time_limit`, and `partition` win over the script, so a
disagreement is a bug to fix now.

## Phase 2 - Submit

`mcp_slurm__slurm_submit` with `script_path` and explicit `cores`, `memory`,
`time_limit`, `job_name`, and `partition`. Set `array` only for an array job.
Record the returned job id verbatim at once, in your working notes and in the
`tasks` board if one is open. Submission is not idempotent: never resubmit
because a reply was slow. Look for the job with `mcp_slurm__slurm_list`
filtered by your user and the job name first.

## Phase 3 - Poll to a terminal state

`mcp_slurm__slurm_describe` with the job id and `output="none"`. The result
says whether the state is terminal. While it is not, wait before asking again:
start at 30 seconds and double up to 5 minutes. Do not spin. A job pending
for longer than the operator's patience is a finding to report with the
pending reason the scheduler gives, not something to cancel on your own.

## Phase 4 - Fetch the output

Once terminal, `mcp_slurm__slurm_describe` with `output="both"` and a
`max_output_chars` that fits the turn. The tails are bounded; for full output
read the files the description names with `read`. A `COMPLETED` state with a
nonzero exit code, or an empty stdout where output was expected, is a failure.
Say so.

## Phase 5 - Cancel only when asked

`mcp_slurm__slurm_cancel` takes `job_id` and `confirm_job_id`, which must
repeat it exactly. Cancel only a job the operator named or one you submitted
in this session and were told to stop. Describe the job afterwards to confirm
it reached `CANCELLED`.

## Final answer

End with a line in exactly this form, one per job:

```text
Slurm job <job id>: <terminal state>, exit <code>, stdout <path>, stderr <path>
```

If the job never reached a terminal state, write `Slurm job <job id>: <state>
(not terminal)` and say what the operator should check next. Never report
success without the job id.
