CLIO Coder can submit and follow a Slurm job for you through the clio-kit MCP server. Each submission or cancellation is confirmed first: the safety judge reviews it against your own messages, and you decide when it has no verdict. Use this when a task needs real compute and you want the job's outcome reported back into the session.

::: note Version scope
This guide describes v0.8.0. CLIO Coder has no scheduler tier of its own: the agent calls the server's tools, and Slurm does the rest. Fleet workers do not submit through Slurm.
:::

::: needs
- A host where `sbatch`, `squeue`, `scontrol`, and `scancel` reach your cluster.
- An interactive session. A headless run submits only when the safety judge allows it.
- A job script you are willing to run under your allocation.
:::

## Install the server

```sh
uv tool install clio-kit
clio-kit mcp-server slurm
```

The second command lets clio-kit prepare its private runtime, which can take longer than the 15 seconds CLIO Coder allows a server to start on a first launch. Stop it with Ctrl-C once it is running.

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

Keep the id `slurm`. The `slurm-jobs` skill you install below expects it, and it is what switches on the confirmation for allocations.

```sh
clio-coder doctor --verbose
clio-coder mcp list
```

Plain `doctor` folds the Slurm checks into one row while none of them needs attention:

```text
OK   slurm                  ready: clio-kit, mcp server, scheduler
INFO scheduler commands     sbatch is on PATH: scheduler commands run outside the shell sandbox with approval
```

`doctor --verbose` prints the `slurm clio-kit`, `slurm mcp server` and `slurm scheduler` rows separately, and a row with a warning always keeps its own line.

The server row names the `mcp.yaml` that declares it and its trust. The scheduler row means only that `sbatch` and `squeue` answered `--version`; it does not contact the controller. None of these rows fails the check.

::: capture cli-slurm-doctor
:::

## Install the skill

```sh
clio-coder library install skill:slurm-jobs --project --dry-run
clio-coder library install skill:slurm-jobs --project
```

## Submit one job

::: prompt Example
/skill slurm-jobs Run scripts/smoke.sbatch on the debug partition with 2 cores for 5 minutes. Report the exit code and the last lines of stdout.
:::

The skill checks that the server is declared, looks at the partition, and submits once. The submission is confirmed before the job reaches the scheduler. When the safety judge has no verdict, an approval card appears, so read the script, cores, memory, and time limit before you press Enter.

The skill then polls with a growing wait until the job reaches a terminal state, and fetches bounded output.

::: result What you should see
The answer ends with a line in this form: `Slurm job <id>: <state>, exit <code>, stdout <path>, stderr <path>`. Check that job id against `squeue` or `sacct` if the result matters.
:::

To keep a job's output beside its record rather than in scratch space, ask the agent to put it into the project store, or run `clio-coder store put results <stdout path> --note "Slurm job <id>"` yourself. The store lives on the host where CLIO Coder runs, here the login node, and records where each file came from.

## Without the server

The agent can also run `sbatch`, `squeue`, `scancel` and the other Slurm, PBS, LSF and Flux clients through `bash`. They run outside the shell sandbox, because they reach the scheduler through a host daemon the sandbox blocks, and they get the same review as `ssh`.

At `default` the safety judge decides first and asks you when it has no verdict. Contained `yolo` runs one only when your own message names it, and unconfined `yolo` runs it.

A script that calls `sbatch` itself stays inside the sandbox and fails there, and so does a workspace file named like a client, such as `./sbatch`. Submit from the command line the agent runs, not from a wrapper. With `safety.sandbox: required` at unconfined `yolo`, only a one-line `sbatch`, `squeue`, `scancel`, `sacct` or `sinfo` with listed options leaves the sandbox; `srun`, `salloc` and `flux` stay inside.

## Cancel a job

Ask the agent to cancel the job by id. Cancelling is confirmed the same way, and the server refuses unless the job id is repeated exactly.

::: limits
- In a headless `clio-coder run` at `default`, a submission or cancellation runs only when the safety judge allows it. With no verdict it is denied.
- At `default`, a trust setting cannot make a submission skip the confirmation, which is attached to the tool name.
- Your site's allocation rules and data policies still apply. A login node is not a compute node.
- This repository ships no copy of the server's schema, so the installed clio-kit version is the authority on tool parameters.
:::

::: next
- [Pre-register a benchmark before you measure](/tutorials/pre-register-a-benchmark.html)
- [Slurm workflows](/docs/guide/slurm.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
- [What would make a scientist trust an agent's change?](/research/scientific-and-hpc-workflows.html)
:::
