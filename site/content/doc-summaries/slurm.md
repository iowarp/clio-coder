## Work with a scheduler

CLIO Coder connects to Slurm through the stdio MCP server shipped by [clio-kit](https://github.com/iowarp/clio-kit). The server provides job submission, listing, description, cancellation, and cluster information. A working scheduler connection is required; client binaries alone are not enough.

## Set up the server

Install clio-kit (for example `uv tool install clio-kit`) on a host where `sbatch`, `squeue`, `scontrol`, and `scancel` reach your cluster. Declare the server in `mcp.yaml` in your config directory, which `clio-coder paths` prints:

```yaml
version: 1
servers:
  - id: slurm
    command: clio-kit
    args: [mcp-server, slurm]
    timeoutMs: 120000
```

Keep the id `slurm`; the skill and the approval rules below expect it. Run `clio-kit mcp-server slurm` once in a terminal and stop it with Ctrl-C, because a cold first launch can exceed the 15 second initialize bound. A project declaration in `.clio-coder/mcp.yaml` needs `clio-coder mcp trust slurm` first.

## Check with doctor

`clio-coder doctor --verbose` prints three Slurm rows, none of which fails doctor.

| Row | What it reports |
| --- | --- |
| `slurm clio-kit` | `clio-kit` on `PATH` and whether it lists `slurm` |
| `slurm mcp server` | Which `mcp.yaml` declares it, its scope, and its trust |
| `slurm scheduler` | Whether `sbatch` and `squeue` answer `--version` |

An OK scheduler row does not prove a working scheduler; it never contacts the controller.

## Use a job workflow

Install the project-scoped Slurm skill:

```sh
clio-coder library install skill:slurm-jobs --project
```

Then ask it to run a specific script and report the evidence:

```text
/skill slurm-jobs Submit this script, wait for its terminal state, and report the job ID, exit code, stdout, and stderr paths.
```

The skill submits once, polls through the MCP server, and reports the outcome. It does not fall back to shell `sbatch` when the server is unavailable.

## Choose approvals deliberately

With the server declared as `slurm`, CLIO Coder classifies the `mcp_slurm__` tools by name:

| Capability | Class | At `default` | At `yolo` |
| --- | --- | --- | --- |
| `slurm_list`, `slurm_describe`, `slurm_cluster` | `read` | Runs | Runs |
| `slurm_submit`, `slurm_cancel` | `execute` | Safety judge reviews; you decide when it has no verdict | Contained, the default: the judge reviews, and a call with no verdict is refused. Unconfined: runs |

In a headless `clio-coder run` at `default`, a submission or cancellation runs only when the safety judge allows it.

A `toolActionClasses` entry in `mcp.yaml` can reclassify one tool, but submission and cancellation keep their confirmation at `default`. Review the full guide before changing a classification or enabling unattended execution. For small local changes, begin with [ordinary project checks](/docs/guide/tool-usage.html).

## Run a parameter sweep

The `hpc-sweep` skill in the `hpc` plugin runs a sweep as one job array:

```sh
clio-coder library install plugin:hpc --project
```

Run `/reload library`, then `/skill hpc-sweep dry run sweeps/decay.yaml`. The sweep file names `parameters`, a `mode` (`grid` or `sample`), a run `template`, `resources`, a `concurrency` cap, and a verify `check`. The skill submits only on your word, checks each run, and writes verdicts to `sweeps/<name>/results.md`.

For this release, this path was checked against fake Slurm clients only, not a live controller.
