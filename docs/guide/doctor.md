# Doctor

`clio-coder doctor` diagnoses a Clio install and the workspace it runs in. It
reads, probes, and reports; plain `doctor` writes nothing. This page covers
what the checks are, the deep checks, the in-session `/doctor`, and how to
read the rows.

## Running it

| Command | What it does |
| --- | --- |
| `clio-coder doctor` | Every standard check. Read-only. |
| `clio-coder doctor --fix` | Also repairs missing directories, template files, and credential permissions, and records fleet preflight results. |
| `clio-coder doctor --json` | The same findings as JSON on stdout: `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }`. |
| `clio-coder doctor --deep` | The standard checks plus the live tool probe on every configured target and a dry run of the validation contract. |
| `clio-coder doctor --deep --tools-timeout <seconds>` | Bounds each tool probe's generation. The default is 120 seconds, enough for a cold load of a large local model. |
| `/doctor` | The standard checks, rendered in the session as one notice. |
| `/doctor deep` | The deep checks against the session's targets and autonomy. |

`--deep` composes with `--json` and `--fix`. `--tools-timeout` without
`--deep` is a usage error (exit 2).

## Reading a row

Each row has a level:

| Level | Badge | Meaning | Affects exit code |
| --- | --- | --- | --- |
| `ok` | `OK` | Healthy. | No |
| `info` | `INFO` | A fact that needs no action, such as an optional tool that is not installed. | No |
| `warn` | `WARN` | Worth attention; Clio still works. | No |
| `error` | `!!` | Broken. | Yes: doctor exits 1 |

Doctor exits 0 when no row is an error. See
[Exit Codes and Output](exit-codes-and-output.md).

## HPC toolchain rows

Every run reports one `toolchain <name>` row for each of `cc`, `c++`, `clang`,
`gfortran`, `mpicc`, `mpicxx`, `mpirun`, `nvcc`, `cmake`, `make`, `ninja`,
`meson`, `python3`, and `sbatch`. The `cc` row accepts `gcc` when `cc` is
absent, and the `c++` row accepts `g++`.

A present tool shows its resolved path and the first line of `--version`
output that carries a version number. Each `--version` runs for at most two
seconds from a scratch directory, and all of them run at once.

- An absent tool is `INFO`. Most workspaces need none of these.
- An absent tool is `WARN` when the workspace
  [validation contract](../process/scientific-validation.md) names it in a
  validator command, or when the contract declares `runtime.kind: slurm` and
  `sbatch` is missing.
- An installed tool whose `--version` exits nonzero is `WARN`. An
  unconfigured Slurm client, which cannot reach its controller, shows up this
  way.

## Deep checks

`--deep` and `/doctor deep` add two groups of rows.

### Tool probe: `tools <target>`

The same streamed tool-call probe as `clio-coder targets --probe --tools` runs
on every configured target. It checks that the target's chat model, or its
default model when chat uses another target, streams a schema-valid tool call
through the path a real turn uses.

| Result | Level |
| --- | --- |
| The model streamed a valid tool call | `OK`, with the model and latency |
| The probe ran and the call was missing or malformed | `WARN`, with the reason |
| The probe could not run: no model is set, or the runtime does not stream through the engine | `INFO` |
| The target did not answer its health probe | `WARN` |

The probe generates tokens and can load a cold model on a local server. It
unloads afterwards only the model it loaded itself, on the server it probed.
A model that was already resident stays, and so does a model a chat turn
loads while an in-session probe runs.

### Validation contract dry run: `validator <n>`

For each command under `validators:` in the workspace validation contract,
doctor resolves the program (the first word after any `NAME=value`
assignments) on PATH, or relative to the workspace when it contains a `/`.
Then it asks the safety policy engine what it would decide for that command as
a bash call, and applies the autonomy mapping at the configured
`safety.autonomy`, or at the session's level for `/doctor deep`. Nothing is
executed.

The row is `OK` when the program resolves and the command would run without an
approval ask. It is `WARN` when the program is missing, when the policy blocks
the command, when a safety rule asks for approval at every level, or when the
configured autonomy asks for or denies it. A command that asks only because
it is unrecognized can be declared in `.clio-coder/safety.yaml` to run
unattended.

With no contract, or a contract with no validators, the dry run adds no rows.

## In the session

`/doctor` runs the same checks as the CLI and shows them as one notice headed
by a tally, for example `doctor: 58 checks, 0 error(s), 3 warning(s)`. The
notice takes the level of the worst row. `/doctor` never repairs anything;
run `clio-coder doctor --fix` from a shell for that.
