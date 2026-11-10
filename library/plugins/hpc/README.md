# HPC pack

Skills for running and inspecting work on an HPC cluster from Clio Coder. The
pack joins the cluster's own tools into one workflow: the scheduler, the
software environment, the parallel I/O stack, the I/O profiler and a durable
record of what ran. It is content only. Installing it starts nothing and
declares no MCP server.

```bash
clio-coder library install skill:slurm-jobs --project
clio-coder library install plugin:hpc --project
```

The pack requires the `slurm-jobs` skill package, which submits through the
clio-kit Slurm MCP server. Run `/reload library` in a running session after
installing.

| Skill | What it does | Drives |
| --- | --- | --- |
| `slurm-jobs` (required package) | Submits a job or job array, polls each task to a terminal state, reports each task's exit and output | `mcp_slurm__*` from `clio-kit mcp-server slurm` |
| `hpc-sweep` | Plans a parameter sweep as a job array with a dry run, submits it on the operator's word, checks each run with a declared verify check, and writes a results table that keeps failed and unverified runs | `assets/scripts/sweep.py`, `mcp_slurm__*`, `verify`, `clio-coder claims` |
| `hpc-modules` | Finds and loads Lmod modules and Spack installs, keeping each load in the shell that uses it | `module`, `$LMOD_CMD`, `spack` over `bash` |
| `hpc-parallel-io` | Correctness rules and tuning for parallel HDF5 and MPI-IO, checked by readback and Darshan counters | `h5pcc`, `h5py`, `mpirun`, `lfs` |
| `hpc-darshan` | Summarizes a Darshan log and names the counters behind each I/O finding | `darshan-parser` through `assets/scripts/darshan_summary.py` |
| `hpc-chronolog` | Records run events in ChronoLog and reads them back: chrono-mcp on released 3.x, or chronolog-mcp with a completeness verdict on unreleased 4.0 builds | `chronolog-mcp`, and `chronolog` on 4.0 |

## Setup the operator owns

- **Slurm.** Declare the clio-kit Slurm server in the user file
  `<Clio config directory>/mcp.yaml` with the id `slurm`, as the
  [Slurm guide](../../../docs/guide/slurm.md) shows. A user declaration with that
  id is what makes polling run without approval prompts, so the pack does not
  declare the server itself. Give the entry an absolute `cwd`, such as your
  scratch directory. Jobs run from the server's working directory and write
  `logs/slurm_output/` there. Without `cwd`, a user entry runs in Clio's config
  directory, and the job logs land in it. Submitting and cancelling ask at
  `default`, where the safety judge reviews them against the operator's
  messages, and a headless run denies what the judge does not allow.
- **ChronoLog.** Declare ChronoLog's MCP server in the same user file, with
  its connection settings in `env` and per-tool `toolActionClasses`;
  `hpc-chronolog` shows both entries. The released line is ChronoLog 3.x
  (latest 3.4.0), whose server, chrono-mcp, ships in the ChronoLog source tree
  at `plugins/chrono-mcp`. ChronoLog 4.0 is unreleased development: it exists
  only as a source build, with its own `chronolog` launcher and `chronolog-mcp`.
- **Environment.** Clio passes an MCP server only `PATH`, `HOME`, `USER`,
  `LOGNAME`, `LANG`, `LC_ALL`, the temp and `XDG_*` directories and a few
  platform variables, plus the `env` its declaration names. A variable a server
  needs (`CHRONO_HOST` for 3.x, `CHRONOLOG_MCP_IDENTITY` for 4.0, `CLIO_KIT_CACHE_DIR`) goes
  in that `env`, never as a credential value.

## Offline behavior

The pack makes no network calls of its own. Its skills drive tools installed on
the cluster. On an air-gapped login node they work with these conditions:

- `clio-kit mcp-server slurm` runs each server from its own lock file in a uv
  environment under `$XDG_CACHE_HOME/clio-kit` or `~/.cache/clio-kit` (set
  `CLIO_KIT_CACHE_DIR` in the declaration's `env` to move it). The first
  launch downloads that environment and fails without network. Every later
  launch from the warm cache works offline. Launch it once while online, or
  copy a warm cache from a connected node.
- `spack install` needs network or a configured mirror. The skills run it only
  when the user asks. Lookups (`spack find`, `spack location`) are local.
- Lmod, Darshan, parallel HDF5, MPI-IO and ChronoLog are local or cluster-network
  tools, so they need no internet access once the site has installed them.
- The pack declares no Darshan, Spack or ChronoLog MCP server (see below), so
  nothing else needs a first online launch.

## Not yet in the pack

clio-kit also ships Darshan, Spack, Lmod and ChronoLog MCP servers. The pack
does not declare them yet. The Darshan and Spack servers wait on a live check
against a real `darshan-util` and Spack install. The Lmod server runs `module`
as a program, but `module` is a shell function, so its loads cannot reach the
caller. clio-kit is retiring its ChronoLog server in favor of ChronoLog's own
chrono-mcp (not yet in a clio-kit release). The skills drive the
command-line tools directly instead.

## Checks

`assets/scripts/darshan_summary.py` is the pack's declared check script
(stdlib Python 3.10+). It reads darshan-parser's text output and never writes
to the log. It was written against the darshan-util 3.5.0 output format.

`assets/scripts/sweep.py` (Python 3.10+) plans and tabulates sweeps. It reads
the sweep file as YAML when PyYAML is importable and as JSON otherwise, writes
only under the sweep's `sweeps/<name>/` directory in the project, and never
submits. Its per-run verdicts come from the claims Clio records when
`verify(check="<id>/<run>")` judges a run, which needs a
`.clio-coder/verifiers.yaml` check that declares `runs`; the `hpc-sweep` skill
shows the entry. Task states come from `sacct`, read-only.

## Licenses and terms

The pack itself is Apache-2.0. It bundles no third-party code or data, and it
queries no external data service, so no data terms of use apply. The tools it
drives keep their own licenses: clio-kit (BSD-3-Clause), Lmod (MIT), Spack
(Apache-2.0 or MIT), Darshan (its University of Chicago copyright notice),
ChronoLog (BSD-2-Clause), and the site's MPI and HDF5 builds.
