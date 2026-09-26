# Slurm through the clio-kit MCP server

`slurmMcpFindings` in [doctor-slurm.ts](../../src/cli/doctor-slurm.ts) checks the local Slurm setup. The [MCP tool guide](tool-usage.md#gateway-discover-and-call-secondary-capabilities) explains capability calls.

Clio Coder reaches Slurm through the Slurm MCP server that
[clio-kit](https://github.com/iowarp/clio-kit) ships, over the same local stdio
MCP gateway every other MCP server uses. There is no Slurm transport inside
Clio and no `srun` or `sbatch` worker tier: the agent submits, polls, and
cancels jobs by calling five gateway capabilities, and the scheduler does the
rest.

## Set it up

Install clio-kit so `clio-kit` is on `PATH` (for example
`uv tool install clio-kit`), on a host where `sbatch`, `squeue`, `scontrol`,
and `scancel` reach your cluster. Then declare the server in the user file
`<Clio config directory>/mcp.yaml` (`clio-coder paths` prints the directory):

```yaml
version: 1
servers:
  - id: slurm
    command: clio-kit
    args: [mcp-server, slurm]
    timeoutMs: 120000
```

The id `slurm` is what the library skill expects. The first launch lets
clio-kit prepare its private runtime for the server, which can take longer
than the 15 second initialize bound on a cold cache; run
`clio-kit mcp-server slurm` once in a terminal first and stop it with Ctrl-C.
A project can declare the same server in `.clio-coder/mcp.yaml`; it then needs
`clio-coder mcp trust slurm` before it ever launches. See
[local stdio MCP configuration and trust](configuration-reference.md#local-stdio-mcp-configuration-and-trust).

`clio-coder doctor` reports the pieces: a `slurm clio-kit` row (the binary and
whether its build ships the Slurm server), a `slurm mcp server` row (which
`mcp.yaml` declares it, its scope, and its trust), and a `slurm scheduler` row
(`sbatch` and `squeue`). On an install with none of them there is one
informational `slurm mcp` row. None of these rows ever fails doctor.

## The five capabilities

The gateway lists them as `mcp_slurm__<tool>`. Find them with
`gateway(op="find", query="slurm")` and read a tool's parameters with
`gateway(op="describe", capability="mcp_slurm__slurm_submit")`. Both read a
recorded catalog and launch nothing. Until one exists, `find` reports the server
with `catalog: "missing"`; fill it once with
`gateway(op="find", server="slurm", refresh=true)`, or just call a tool, which
lists the server live and records the result as a side effect.

| Capability | What it does |
| --- | --- |
| `mcp_slurm__slurm_submit` | Submits one job or array from `script_path` with `cores`, `memory`, `time_limit`, and optional `job_name`, `partition`, and `array`. Returns the scheduler job id. Not idempotent. |
| `mcp_slurm__slurm_list` | Lists a bounded number of jobs, filtered by `user`, `state`, and `partition`. |
| `mcp_slurm__slurm_describe` | Describes one job: state, whether it is terminal, scheduler properties, and optional bounded stdout and stderr tails (`output`, `max_output_chars`). |
| `mcp_slurm__slurm_cluster` | One snapshot of partitions and the queue, with node details on request. |
| `mcp_slurm__slurm_cancel` | Cancels one job. `confirm_job_id` must repeat `job_id` exactly or the server refuses without calling `scancel`. |

The server also exposes its older tool names (`submit_slurm_job`,
`check_job_status`, and so on). Prefer the five above.

## How autonomy treats them

An MCP server carries one action class for all of its tools, and the server's
own annotations never choose it. A user-scope declaration gets the class
`unknown`, and `unknown` asks for one-shot approval in `default`, runs in
`yolo`, and is denied on read-only dispatched runs. So with the declaration above in `default`:

- `slurm_submit` and `slurm_cancel` always ask before they reach the
  scheduler. A denied call never launches a job.
- `slurm_list`, `slurm_describe`, and `slurm_cluster` ask too, although they
  only read. Polling a job costs one approval per poll.
- A headless `clio-coder run` in `default` answers every ask with a denial. A
  `yolo` run admits the unknown class unless a safety rule intervenes.

A project declaration can be trusted with another class:
`clio-coder mcp trust slurm --action-class read` makes all five run without
asking, submissions and cancellations included, because the class is per
server. Do that only in a workspace where an unattended `sbatch` is
acceptable. `--action-class execute` routes the server's launch command
through the bash policy and then follows the command rows of the
[autonomy table](../architecture/safety-model.md#autonomy). There is no
per-tool class today.

## The skill

`clio-coder library install skill:slurm-jobs --project`, then
`/skill slurm-jobs <script and what to report>`. It checks that the server is
declared, looks at the partition, submits once, polls
`mcp_slurm__slurm_describe` with a growing wait until the state is terminal,
fetches bounded output, and ends its answer with
`Slurm job <id>: <state>, exit <code>, stdout <path>, stderr <path>`. It never
falls back to `sbatch` through `bash`.
