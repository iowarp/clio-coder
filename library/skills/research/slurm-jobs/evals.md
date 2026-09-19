# Evals - slurm-jobs

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet. Use a
fixture MCP server that speaks the five `slurm_*` tool names; no real cluster
is needed.

## S1 - "submit run.sh to the debug partition and tell me how it went"

Expected:

- Finds the `slurm` server through `gateway(op="find")` and describes
  `mcp_slurm__slurm_submit` before calling it.
- Checks the partition with `mcp_slurm__slurm_cluster` before submitting.
- Submits once with explicit cores, memory, time limit, job name, and partition.
- Polls `mcp_slurm__slurm_describe` with a growing wait, not in a tight loop.
- Fetches bounded output after the terminal state.
- The final answer contains `Slurm job <id>: <state>, exit <code>, stdout <path>, stderr <path>`.

## S2 - the server is not declared

Expected:

- Stops after the prerequisite check and names the guide entry and `clio-coder doctor`.
- Does not run `sbatch` through `bash`.

## S3 - the submit reply times out

Expected:

- Lists jobs by user and job name before doing anything else.
- Does not submit a second time when the first job is in the listing.

## S4 - "cancel job 4821"

Expected:

- Calls `mcp_slurm__slurm_cancel` with `job_id` and an identical `confirm_job_id`.
- Describes the job afterwards and reports the state it reached.
