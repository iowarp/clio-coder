# Slurm through the clio-kit MCP server

`slurmMcpFindings` in [doctor-slurm.ts](../../src/cli/doctor-slurm.ts) checks the local Slurm setup. The [MCP tool guide](tool-usage.md) explains capability calls.

Clio Coder reaches Slurm through the Slurm MCP server that
[clio-kit](https://github.com/iowarp/clio-kit) ships, over the same local stdio
MCP gateway every other MCP server uses. There is no Slurm transport inside
Clio Coder and no `srun` or `sbatch` worker tier: the agent submits, polls, and
cancels jobs by calling five gateway capabilities, and the scheduler does the
rest. Fleet nodes are SSH hosts and do not submit through Slurm; see
[HPC clusters](hpc-clusters.md) for cluster hosts.

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

The id `slurm` is what the library skill expects, and it is also the id that
switches on the per-tool classification and the allocation confirmation
described below. A server entry takes `id`, `command`, `args`, `cwd`, `env`,
`timeoutMs` (at most 900000, bounding one tool call), `actionClass`, and
`toolActionClasses`. The first launch lets
clio-kit prepare its private runtime for the server, which can take longer
than the 15 second initialize bound on a cold cache; run
`clio-kit mcp-server slurm` once in a terminal first and stop it with Ctrl-C.
A user-scope declaration is trusted by authorship. A project can declare the
same server in `.clio-coder/mcp.yaml`; it then needs
`clio-coder mcp trust slurm` before it ever launches, and `clio-coder mcp list`
shows every declaration with its scope, trust, and action class. See
[local stdio MCP configuration and trust](configuration-reference.md).

`clio-coder doctor` reports the pieces. See [Doctor rows](#doctor-rows).

## The five capabilities

The gateway lists them as `mcp_slurm__<tool>`. Find them with
`gateway(op="find", query="slurm")` and read a tool's parameters with
`gateway(op="describe", capability="mcp_slurm__slurm_submit")`. Both read a
recorded catalog and launch nothing. Until one exists, `find` reports the server
with `catalog: "missing"`; fill it once with
`gateway(op="find", server="slurm", refresh=true)`, or just call a tool, which
lists the server live and records the result as a side effect. A tool result
is bounded to 16 KiB in the model's context, and the full text is offloaded to
a file the model can read in windows.

| Capability | What it does |
| --- | --- |
| `mcp_slurm__slurm_submit` | Submits one job or array from `script_path` with `cores`, `memory`, `time_limit`, and optional `job_name`, `partition`, and `array`. Returns the scheduler job id. Not idempotent. |
| `mcp_slurm__slurm_list` | Lists a bounded number of jobs, filtered by `user`, `state`, and `partition`. |
| `mcp_slurm__slurm_describe` | Describes one job: state, whether it is terminal, scheduler properties, and optional bounded stdout and stderr tails (`output`, `max_output_chars`). |
| `mcp_slurm__slurm_cluster` | One snapshot of partitions and the queue, with node details on request. |
| `mcp_slurm__slurm_cancel` | Cancels one job. `confirm_job_id` must repeat `job_id` exactly or the server refuses without calling `scancel`. |

The parameter names above are the ones the `slurm-jobs` skill uses. This
repository ships no copy of the server's schema, so a `describe` call is the
authority for the installed clio-kit version.

The server also exposes its older tool names (`submit_slurm_job`,
`check_job_status`, and so on). Prefer the five above. Clio Coder classifies the
older names the same way, as listed below.

## How autonomy treats them

An MCP server has a default action class (`read`, `execute`, or `unknown`),
with optional `toolActionClasses` overrides for named tools. The server's own
annotations never choose either. A user-scope declaration without an
`actionClass` gets the class `unknown`, and `unknown` asks for one-shot approval
in `default`, runs in `yolo`, and is denied on read-only dispatched runs.

For a server declared with the id `slurm`, Clio Coder classifies tools by name
before applying that default, unless `toolActionClasses` names the tool:

| Tools | Class | Behavior |
| --- | --- | --- |
| `slurm_list`, `slurm_describe`, `slurm_cluster`, and the older `check_job_status`, `list_slurm_jobs`, `get_slurm_info`, `get_job_details`, `get_job_output`, `get_queue_info`, `get_node_info`, `get_allocation_status` | `read` | Run without asking at `default` and `yolo`. Polling a job costs no approval. |
| `slurm_submit`, `slurm_cancel`, and the older `submit_slurm_job`, `cancel_slurm_job`, `submit_array_job`, `allocate_slurm_nodes`, `deallocate_slurm_nodes` | `execute` | Always ask the operator before they reach the scheduler, at every autonomy level including `yolo`. Approving resumes only that call. |
| Any other tool name | the server's class | The `toolActionClasses` entry for the tool, else the declared or trusted class (`unknown` for a user declaration with none). |

The confirmation is attached to the tool name and does not depend on the class.
A `toolActionClasses` override or `clio-coder mcp trust slurm --action-class read`
cannot make a submission or cancellation run unasked. A denied call never
launches a job. In a headless `clio-coder run` the ask is denied, so a
submission or cancellation never runs there. A read-only dispatched run denies
both allocation tools outright and still allows the read tools. In a server
with a different id none of this applies: every tool takes the `toolActionClasses`
entry or the server's class.

The server class matters for tool names Clio does not know. A project
declaration can be trusted with another class:
`clio-coder mcp trust <id> --action-class read` makes those tools run without
asking. `--action-class execute` routes the server's launch command through the
bash policy and then follows the command rows of the
[autonomy table](../architecture/safety-model.md). In `mcp.yaml`,
`toolActionClasses` (up to 128 entries) classifies named tools individually.

## The skill

`clio-coder library install skill:slurm-jobs --project`, then
`/skill slurm-jobs <script and what to report>`. It checks that the server is
declared, looks at the partition, submits once, polls
`mcp_slurm__slurm_describe` with a growing wait until the state is terminal,
fetches bounded output, and ends its answer with
`Slurm job <id>: <state>, exit <code>, stdout <path>, stderr <path>`. It never
falls back to `sbatch` through `bash`.

## Doctor rows

`clio-coder doctor` runs `slurmMcpFindings` and never fails because of it: every
row is informational, OK, or a warning. On an install with none of `clio-kit`,
`sbatch`, `squeue`, or a Slurm declaration there is one informational
`slurm mcp` row that says nothing is set up. Otherwise there are three rows:

| Row | What it reports |
| --- | --- |
| `slurm clio-kit` | The `clio-kit` binary on `PATH`, its version line (`clio-kit` has shipped without `--version`, in which case the row says so), and whether `clio-kit mcp-servers` lists a `slurm` server. Informational when `clio-kit` is not on `PATH`. |
| `slurm mcp server` | Which `mcp.yaml` declares `clio-kit mcp-server slurm`, its scope, and its trust. OK when every matching declaration is trusted, informational otherwise, with the `clio-coder mcp trust <id>` remedy. |
| `slurm scheduler` | `sbatch` and `squeue` on `PATH`. |

The probes run in a scratch working directory with a 5 second timeout and a
16 KiB output cap. Doctor checks the installed Slurm clients with bounded
version probes before marking the scheduler row OK. A client that cannot
discover its configuration or controller reports a warning with "host has no
Slurm configuration or controller to reach"; installing client binaries alone
does not establish a working scheduler.

The scheduler row reuses the HPC toolchain row's `sbatch --version` result, so
each doctor run probes that client once.
