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
`toolActionClasses`. A user-scope `cwd` is absolute or relative to the Clio
config directory, and a user server with no `cwd` runs from the config
directory itself. A project-scope `cwd` must be repository-relative and stay
inside the repository, symbolic links included; an absolute project `cwd` is
refused. The first launch lets
clio-kit prepare its private runtime for the server, which can take longer
than the 15 second initialize bound on a cold cache; run
`clio-kit mcp-server slurm` once in a terminal first and stop it with Ctrl-C.
A user-scope declaration is trusted by authorship. A project can declare the
same server in `.clio-coder/mcp.yaml`; it then needs
`clio-coder mcp trust slurm` before it ever launches, and `clio-coder mcp list`
shows every declaration with its scope, trust, and action class. See
[local stdio MCP configuration and trust](configuration-reference.md).

`clio-coder doctor --verbose` reports the pieces. See [Doctor rows](#doctor-rows).

## The five capabilities

The gateway lists them as `mcp_slurm__<tool>`. Find them with
`gateway(op="find", query="slurm")` and read a tool's parameters with
`gateway(op="describe", capability="mcp_slurm__slurm_submit")`. Both read a
recorded catalog and launch nothing. Until one exists, `find` reports the server
with `catalog: "missing"`; fill it once with
`gateway(op="find", server="slurm", refresh=true)`, or just call a tool, which
lists the server live and records the result as a side effect. The MCP client
first bounds a tool result's text at 1 MiB, cutting anything longer and
appending a `[mcp result text truncated at 1048576 bytes]` marker. The model
then sees at most 16 KiB of that text in its context, and the rest of the
bounded text is offloaded to a file the model can read in windows.

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

An MCP server has a default action class (`read`, `execute`, `destructive` or `unknown`),
with optional `toolActionClasses` overrides for named tools. Launch trust comes
first. For a trusted user-scope server with no explicit class, a server's
`readOnlyHint` or `destructiveHint` supplies an advisory default when no
Clio-defined tool class applies. A read-only ceiling does not accept a server's
read-only hint as authority. Only user declarations may set the server-wide
`actionClass`; project and plugin declarations use the class recorded by operator
trust as their default. Every declaration scope accepts operator-approved
`toolActionClasses`; once launch trust is established, a per-tool entry overrides
the trust-record class in every scope. The entries are covered by the declaration's
trust digest, so changing them in a project or plugin declaration requires
re-approval. `unknown` asks for one-shot approval
in `default`, runs in `yolo`, and is denied on read-only dispatched runs.
See [MCP configuration](configuration-reference.md).

For a trusted user-scope server declared with the id `slurm`, Clio Coder
classifies tools by name before applying that default, unless
`toolActionClasses` names the tool:

| Tools | Class | Behavior |
| --- | --- | --- |
| `slurm_list`, `slurm_describe`, `slurm_cluster`, and the older `check_job_status`, `list_slurm_jobs`, `get_slurm_info`, `get_job_details`, `get_job_output`, `get_queue_info`, `get_node_info`, `get_allocation_status` | `read` | Run without asking at `default` and `yolo`. Polling a job costs no approval. |
| `slurm_submit`, `slurm_cancel`, and the older `submit_slurm_job`, `cancel_slurm_job`, `submit_array_job`, `allocate_slurm_nodes`, `deallocate_slurm_nodes` | `execute` | Ask before they reach the scheduler under rule `slurm-allocation`. At `default` the safety judge reviews the call first against the operator's messages and the operator decides when it gives no verdict; approving resumes only that call. At `yolo` they run without asking. |
| Any other tool name | the server's class | The `toolActionClasses` entry for the tool, else the declared or trusted class, or an advisory annotation for an implicit user class. |

The confirmation is attached to the tool name and does not depend on the class.
At `default`, a `toolActionClasses` override or
`clio-coder mcp trust slurm --action-class read` cannot make a submission or
cancellation skip the confirmation; `yolo` skips it whatever the class. A
denied call never launches a job. In a headless `clio-coder run` at `default`
the safety judge still reviews the call: when it allows the call, the
submission or cancellation runs, and when it refuses or gives no verdict the
call is denied, because nobody is there to answer. A headless
`clio-coder run --autonomy yolo` runs them without asking. A read-only dispatched run denies
both allocation tools outright and still allows the read tools. In a server
with a different id the Slurm name rules do not apply: tools use the normal
MCP classifier described above.

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

## Parameter sweeps

A parameter sweep runs as a Slurm job array that Clio Coder plans, checks and
tabulates as one experiment. The `hpc-sweep` skill in the `hpc` plugin drives
it on top of `slurm-jobs`:

```bash
clio-coder library install skill:slurm-jobs --project
clio-coder library install plugin:hpc --project
```

Then run `/library reload` in the session and ask for the sweep, for example
`/skill hpc-sweep dry run sweeps/decay.yaml`.

The sweep file (YAML, or JSON when PyYAML is absent) names the sweep and lists
its `parameters`, a `mode` of `grid` or `sample`, the run `template` script,
the Slurm `resources`, a `concurrency` cap that becomes the array's `%N`, the
verify `check` that judges one run and an optional `metrics` file. The plugin's
`sweep.py` helper plans and tabulates under `sweeps/<name>/` in the project. It
never submits, polls or cancels; those go through the five capabilities above.

1. **Plan and dry run.** The default. The helper writes `manifest.tsv`, the
   array script, `plan.json` and one `runs/<task>/params.json` per run, and the
   skill shows the run table, the script and the exact
   `mcp_slurm__slurm_submit` call. Without an explicit request to submit, the
   skill stops here and asks with `Don't submit` as the recommended option.
2. **Submit.** Only on the operator's word, exactly as `plan.json` names it,
   with the `%N` concurrency suffix kept. The submission is an execute-class
   call and follows [How autonomy treats them](#how-autonomy-treats-them).
3. **Monitor.** Each array task is polled by `<array id>_<task>` until every
   task is terminal.
4. **Check each run.** For every task that completed with exit 0, the skill
   calls `verify(check="<check>/<task>")`, one call per run. The check is a
   `.clio-coder/verifiers.yaml` entry with `runs: <directory>`; verify appends
   the run directory to its command and refuses a bare call or a run outside
   that directory. See [Project verifier catalog](tool-usage.md#project-verifier-catalog).
5. **Tabulate.** `clio-coder claims list --check <check> --json` feeds the
   helper's `aggregate`, which writes `results.tsv` and `results.md`. Every
   run gets a verdict: `agrees`, `disagrees`, `unverified`, `run failed`,
   `not terminal` or `unknown`. Failed and unverified runs stay in the table.
6. **Refine.** A refinement is a new sweep with a new name and its own `runs`
   check entry; a finished sweep's directory is never overwritten.

The verdicts say whether each run agreed with its reference within the check's
declared tolerance, not that the simulation is right.

For this release, the Slurm path (the server, the skills and the doctor rows)
was checked against fake Slurm client binaries only, not against a live
cluster controller.

## Doctor rows

`clio-coder doctor` runs `slurmMcpFindings` and never fails because of it: every
row is informational, OK, or a warning. On an install with none of `clio-kit`,
`sbatch`, `squeue`, or a Slurm declaration there is one informational
`slurm mcp` row that says nothing is set up. Otherwise there are three rows. The
text report folds them into one while none of them needs attention, and a row
with a warning keeps its own line; `clio-coder doctor --verbose` prints all three:

| Row | What it reports |
| --- | --- |
| `slurm clio-kit` | The `clio-kit` binary on `PATH`, its version line (`clio-kit` has shipped without `--version`, in which case the row says so), and whether `clio-kit mcp-servers` lists a `slurm` server. Informational when `clio-kit` is not on `PATH`. |
| `slurm mcp server` | Which `mcp.yaml` declares `clio-kit mcp-server slurm`, its scope, and its trust. OK when every matching declaration is trusted, informational otherwise, with the `clio-coder mcp trust <id>` remedy. |
| `slurm scheduler` | `sbatch` and `squeue` on `PATH`, and whether each one found answered `--version`. |

Every probe runs in a scratch working directory. The two `clio-kit` probes
(`--version` and `mcp-servers`) each get a 5 second timeout and a 16 KiB
output cap. The scheduler row reuses the HPC toolchain row's `sbatch --version`
result, which has a 2 second timeout and a 4 KiB output cap, so each doctor
run probes `sbatch` once. `squeue --version` gets a 5 second timeout and the
same 4 KiB output cap.

An OK scheduler row means only that each client on `PATH` answered
`--version` with exit status 0. It does not submit a job, query the queue or
contact the controller, so it does not prove a working scheduler. A client
whose `--version` times out or exits non-zero turns the row into a warning;
when its output shows that it could not find its configuration or controller,
the warning says "host has no Slurm configuration or controller to reach".
