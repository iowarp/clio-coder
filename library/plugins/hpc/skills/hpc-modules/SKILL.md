---
name: hpc-modules
description: "Finds and loads software on an HPC system through Lmod environment modules, and finds Spack-installed packages, from bash. Not for installing software or for writing the job script's science."
---

# Software environments: Lmod and Spack

Find which compiler, MPI and library builds a cluster offers, and make a
command or job use them, so that the run names its exact environment. All of it
is local: no network is needed, and air-gapped login nodes work the same way.

## The one rule: a load lives only in its own shell

Lmod's `module` is a shell function, not a program. It runs
`$LMOD_CMD <shell> <args>`, which prints shell code, and `eval`s that code in
the current shell. So a `module load` changes only the shell it runs in. Each
`bash` tool call is a fresh shell, and a load in one call is gone in the next.
A program that runs `module load` as a child process changes nothing, whatever
it reports.

- Put the loads and the command that needs them in one call:
  `bash -lc 'module load gcc/12.2.0 openmpi/4.1.5 && mpicc --version'`.
- In a batch script, put `module purge` and the exact `module load` lines in
  the script itself, before the first command that needs them.
- Write full `name/version` names. A bare `module load gcc` takes the site
  default, which can change under you.

## Phase 0 - Find the module system

`bash -lc 'type module; echo "LMOD_CMD=$LMOD_CMD LMOD_VERSION=$LMOD_VERSION"; echo "$MODULEPATH"'`.
The `-l` login shell reads the site's profile, which defines `module`. If
`LMOD_CMD` is set, this is Lmod. If `module` exists but `LMOD_CMD` does not,
the site runs another module system (Environment Modules); `module avail` and
`module load` still work, but the Lmod-only commands below may not. If neither
exists, there is no module system: say so and look for Spack (Phase 3).

## Phase 1 - Discover

Lmod writes its listings to stderr. Add `--redirect` to send them to stdout,
and `-t` (`--terse`) for one module per line.

| Question | Command |
| --- | --- |
| What can I load now? | `module -t --redirect avail` |
| Every version of a package, loadable or not | `module -t --redirect spider <name>` |
| What must I load first to reach one version? | `module --redirect spider <name>/<version>` |
| What does a module set? | `module --redirect show <name>/<version>` |
| What is loaded? | `module -t --redirect list` |

Run each as `bash -lc '<command>'`. Without the shell function, the same
commands run as `$LMOD_CMD bash <args>` with the listing on stderr.

Sites often build a hierarchy: an MPI or library module appears in `avail`
only after its compiler is loaded. `spider` searches the whole tree, and
`spider <name>/<version>` prints "You will need to load all module(s) on any
one of the lines below" followed by the prerequisite lines. Choose one line,
and load it before the module.

## Phase 2 - Load and record

Load in one shell, check the result there, and record what you got:

```bash
bash -lc 'module purge && module load gcc/12.2.0 openmpi/4.1.5 && module -t --redirect list && which mpicc'
```

Report the exact `module -t list` output with the result. That list is the
environment another person needs to reproduce the run.

## Phase 3 - Spack-installed packages

If the site or the user installs with Spack, `spack` is on `PATH` after
`. <spack root>/share/spack/setup-env.sh`.

- `spack find -lv <spec>` lists matching installs with their hashes and
  variants. Exit 1 with "No package matches the query" means none is
  installed. That is an answer, not an error.
- `spack location -i /<hash>` prints one install's prefix. Pass a hash, so the
  answer is a single install.
- `spack load --sh /<hash>` prints the shell code that `spack load` would apply.
  As with modules, `eval` it in the same shell as the command that needs it.

`spack install` builds software. It needs network access or a configured
mirror, and it takes a long time. Run it only when the user asks for it, and
never as a side step of a lookup.

## Final answer

Name each module or Spack spec with its full version or hash, the prerequisites
you loaded, and the exact command line that ran with them.
