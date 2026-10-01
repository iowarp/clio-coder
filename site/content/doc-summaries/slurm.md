## Work with a scheduler

Clio connects to Slurm through the stdio MCP server shipped by [clio-kit](https://github.com/iowarp/clio-kit). The server provides job submission, listing, description, cancellation, and cluster information. A working scheduler connection is required; client binaries alone are not enough.

Use the full guide's setup commands to declare the server, then run `clio-coder doctor` to check the Slurm clients and configuration.

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

With the server declared as `slurm`, Clio classifies each tool. Listing, describing, and cluster reads run without asking. Submission and cancellation always ask for approval, in `yolo` too, and a headless run denies those asks.

A `toolActionClasses` entry in `mcp.yaml` can reclassify one tool, but submission and cancellation keep their confirmation. Review the full guide before changing a classification or enabling unattended execution. For small local changes, begin with [ordinary project checks](/docs/guide/tool-usage.html).
