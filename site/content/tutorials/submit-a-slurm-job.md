Clio Coder can submit and follow a Slurm job for you through the clio-kit MCP server, and it asks you before each submission or cancellation. Use this when a task needs real compute and you want the job's outcome reported back into the session.

::: note Version scope
This guide describes v0.6.8. Clio Coder has no scheduler tier of its own: the agent calls the server's tools, and Slurm does the rest. Fleet workers do not submit through Slurm.
:::

::: needs
- A host where `sbatch`, `squeue`, `scontrol`, and `scancel` reach your cluster.
- An interactive session, since a headless run denies submissions.
- A job script you are willing to run under your allocation.
:::

## Install the server

```sh
uv tool install clio-kit
clio-kit mcp-server slurm
```

The second command lets clio-kit prepare its private runtime, which can take longer than the 15-second bound on a first launch. Stop it with Ctrl-C once it is running.

## Declare it

Run `clio-coder paths` to find your config directory, then add this as `mcp.yaml` there:

```yaml title=mcp.yaml
version: 1
servers:
  - id: slurm
    command: clio-kit
    args: [mcp-server, slurm]
    timeoutMs: 120000
```

Keep the id `slurm`. The skill expects it, and it is what switches on the confirmation for allocations.

```sh
clio-coder doctor
clio-coder mcp list
```

`doctor` shows `slurm clio-kit`, `slurm mcp server`, and `slurm scheduler` rows. Those rows are informational or warnings, and they never fail the check.

## Install the skill

```sh
clio-coder library install skill:slurm-jobs --project --dry-run
clio-coder library install skill:slurm-jobs --project
```

## Submit one job

::: prompt Example
/skill slurm-jobs Run scripts/smoke.sbatch on the debug partition with 2 cores for 5 minutes. Report the exit code and the last lines of stdout.
:::

The skill checks that the server is declared, looks at the partition, and submits once. A permission card appears before the job reaches the scheduler, so read the script, cores, memory, and time limit before you press Enter. It then polls with a growing wait until the job reaches a terminal state, and fetches bounded output.

::: result What you should see
The answer ends with a line in this form: `Slurm job <id>: <state>, exit <code>, stdout <path>, stderr <path>`. Check that job id against `squeue` or `sacct` if the result matters.
:::

## Cancel a job

Ask the agent to cancel the job by id. Cancelling also asks first, and the server refuses unless the job id is repeated exactly.

::: limits
- In a headless `clio-coder run`, the ask is denied, so a submission or cancellation never runs there.
- A trust setting cannot make a submission run unasked. The confirmation is attached to the tool name.
- Your site's allocation rules and data policies still apply. A login node is not a compute node.
- This repository ships no copy of the server's schema, so the installed clio-kit version is the authority on tool parameters.
:::

::: next
- [Slurm workflows](/docs/guide/slurm.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
- [What would make a scientist trust an agent's change?](/research/scientific-and-hpc-workflows.html)
:::
