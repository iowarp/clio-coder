# Doctor

`runDoctorCommand` in [doctor.ts](../../src/cli/doctor.ts) runs the CLI checks. The [safety model](../architecture/safety-model.md) explains command authority.

`clio-coder doctor` diagnoses a Clio install and the workspace it runs in. It
reads, performs passive endpoint probes, and reports; plain `doctor` writes
nothing and sends no model generation request. This page covers what the checks
are, the deep checks, the in-session `/doctor`, and how to read the rows.

## Running it

| Command | What it does |
| --- | --- |
| `clio-coder doctor` | Every standard check. Read-only; quiet row families are folded in text output. |
| `clio-coder doctor --verbose` | Print every finding separately in text output. JSON always retains every finding. |
| `clio-coder doctor --fix` | Also repairs missing directories, template files, and credential permissions, rewrites retired enum values and YAML 1.1 `on`/`off` booleans in `settings.yaml` while preserving comments and formatting, and records fleet preflight results. |
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

The lifecycle rows report the detected install method, whether config, data,
state, and cache are absolute and non-overlapping (including through symlinks),
and whether `migrations.json` is trustworthy and current. Pending migrations
are a warning with the post-install command. A registered migration that is
not recorded but whose result the current valid `settings.yaml` already
satisfies (`2026-09-01-settings-v2` and `2026-09-01-retire-panes-knobs`) is
reported as satisfied, not pending. Invalid JSON, an invalid manifest
shape, duplicate IDs, or an oversized manifest is an error: doctor does not
rewrite it or guess that no migration ran. Restore or review the manifest before
running upgrade. An unknown install method is a warning because Clio cannot
safely choose a package manager for it; ordinary work remains available.

Standard checks include one `connection <id>` row for every configured target.
It says whether a credential is available, whether the runtime offers a passive
check, whether the endpoint answered, and whether a live model list was read.
A target used by chat, fleet, or memory is an error when its passive check
fails or required credentials are missing; an unused target is a warning. Successful public metadata does not prove that credentials are ready for inference. Each target’s passive probe has a 2.5-second total budget, including credential resolution and all metadata requests. Expired browser credentials are reported without refreshing or writing them. `model <id>` separately says whether each
configured role model came from a live list, a cached list from an earlier check, a list recorded in settings by configure, or
a provider catalog. A catalog match is not presented as live availability, and a model missing from an older catalog or recorded list is a warning, not proof that the endpoint rejects it. A role model absent from a live list of a target that chat, fleet, or memory uses is an error. An unknown runtime on a target is an error. ALCF’s passive probe reads its catalog; it does not verify the configured inference URL.

The `local worker capacity` row reports usable CPUs, currently available memory,
any process/cgroup memory bound, and the worker count `auto` resolves to. It
also states that Clio did not inspect GPU/VRAM or model fit.

## Core install rows

A `chat` row leads the report with the configured route, whether chat can run, and the recovery command when setup is incomplete. The core install checks follow: `Clio Coder version`, `install method`, `node version`, `platform`, `engine runtime`, `directory layout`, `config dir`, `data dir`, `state dir`, `cache dir`, `settings.yaml`, `credentials`, `state metadata`, `lifecycle migrations`, and the session store and state storage rows. A missing directory, an invalid `settings.yaml`, a `credentials.yaml` whose mode is not `600`, or stale state metadata is an error, and `clio-coder doctor --fix` repairs the directories, template files, credential mode and state metadata.

On a home Clio has never written to, plain `doctor` prints a `chat` warning explaining that no model target is configured and an `installation` warning row (`not set up yet`) and exits 0. It creates nothing. `doctor --fix` creates the directories without choosing a model.

Other rows appear when they apply: `validation contract` (valid, absent, Markdown-only or invalid; an invalid contract is an error and a valid one raises the rigor default to high), `interop <agent>` rows for detected external agents, `fleet node <id>` rows from the SSH preflight, `panes ...` rows, `external tool <id>` rows, and `naming ...` rows that count legacy `clio` history, git refs and worktree markers.

## HPC toolchain rows

The full findings include one `toolchain <name>` row for each of `cc`, `c++`, `clang`,
`gfortran`, `mpicc`, `mpicxx`, `mpirun`, `nvcc`, `cmake`, `make`, `ninja`,
`meson`, `python3`, and `sbatch`. The `cc` row accepts `gcc` when `cc` is
absent, and the `c++` row accepts `g++`.

A present tool shows its resolved path and the first line of `--version`
output that carries a version number. Each `--version` runs for at most two
seconds from a scratch directory, and all of them run at once.

- An absent tool is `INFO`. Most workspaces need none of these.
- An absent tool is `WARN` when the workspace
  [validation contract](tool-usage.md#verify-run-declared-verification-checks) names it in a
  validator command, or when the contract declares `runtime.kind: slurm` and
  `sbatch` is missing.
- An installed tool whose `--version` exits nonzero is `WARN`. An
  unconfigured Slurm client, which cannot reach its controller, shows up this
  way. Slurm client version timeouts also warn; other HPC version timeouts
  retain their informational detail on an OK row. The scheduler row reuses
  the bounded sbatch result rather than spawning a second probe.

## Task worktree rows

In a git checkout, the `task worktree root` row gives the directory
`fleet.worktrees.root` resolves to, its filesystem type, and its free space,
and warns when an off-disk setting fell back to disk. Doctor then lists every `worktree: true` task worktree that
outlived its run, one `task worktree <runId>` row each, or a single
`task worktrees` row reading `none preserved`. A `settled` row is a worktree
its run kept on purpose and is informational. An `abandoned` row is a crashed
run's worktree that restart recovery kept because it holds work, and it is a
warning, as is a claim whose owner is gone or that predates recovery. Each row
gives the branch, the age, the `git log <base>..<branch>` command to inspect
it, and the commands to drop it. A claim whose branch and worktree are both gone is reported as stale; `doctor --fix` removes that stale claim after rechecking both. Doctor never removes a surviving branch or worktree. See
[worktree per task](fleet-dispatch.md#worktree-per-task).

## Slurm MCP rows

`slurm clio-kit` names the `clio-kit` binary on `PATH` and whether its build
ships the Slurm MCP server. `slurm mcp server` names the `mcp.yaml` that
declares `clio-kit mcp-server slurm`, its scope, and its trust. `slurm
scheduler` reports `sbatch` and `squeue`. An install with none of the three
gets a single informational `slurm mcp` row. These rows never fail doctor. See
[Slurm](slurm.md).

## System One rows

Doctor reports how System One is configured and never asks a decision, so a failing row is a broken binding or an unverified target. See the [System One guide](system-one.md).

| Row | Level and meaning |
| --- | --- |
| `system one (experimental)` | `INFO` `off; no site is bound` when no site is bound. It is then the only System One row, unless recording is on or the dataset holds files. |
| `system one (experimental) off` | `INFO` when some sites are bound, listing the sites that are not. |
| `system one (experimental) <site>` | One row for each bound site. `WARN` names why a binding cannot answer (an engine `systemOne.engines` does not define, a target `targets` lacks, an unregistered runtime, or a `systemone` engine over a runtime that does not answer typed decisions) and says the site stays silent. `WARN` also appears when the binding resolves but `connection <target>` is not verified, because the site may stay silent. Otherwise the row is `OK` and shows the engine, its kind, the target, the model, any `timeoutMs` deadline, the builds whose cuts at this site are measured or operator-configured, and that any other answering build is unvalidated and only records. |
| `system one (experimental) engine <name>` | One row for each `systemone` engine a site or task route uses. It shows the engine's profile, the window one request may fill and where that window comes from (the target's `capabilities.contextWindow`, the profile ceiling or the runtime default), and whether the server answered the passive check, with the round trip and the build it serves. The check reads `/models` or `/health` and never asks a decision, so it puts no work on the processor the engine runs on. `WARN` when the server does not answer, because every site it serves then behaves as if unbound. |
| `system one dataset` | Whether `systemOne.record` is on, the number of day files with their date range, their total size, and the retention and size cap. Shown when a site is bound, recording is on or the dataset holds files. `INFO` with no files, `WARN` when the dataset directory cannot be read or is over the cap (the next write prunes the oldest days). |

A site row that is `OK` says the binding is well formed. Doctor cannot know which build will answer, so it names the builds a site's cuts cover; the build that actually answered each call is in the session ledger and `clio-coder systemone status`.

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
| An available runtime has no live probe | `INFO`, with the credential source |
| The target is a decision engine without chat, such as a System One target | `INFO`, not applicable |
| Credentials are missing or the target did not answer its health probe | `WARN`, with the actual error |

The probe generates tokens and can load a cold model on a local server. It
unloads afterwards only the model it loaded itself, on the server it probed.
A model that was already resident stays, and so does a model a chat turn
loads while an in-session probe runs.

### Validation contract dry run: `validator <n>`

For each command under `validators:` in the workspace validation contract,
doctor resolves the program (the first word after any `NAME=value`
assignments) on PATH, or relative to the workspace when it contains a `/`.
Then it evaluates the command as a bash call the way tool admission does, at
the configured `safety.autonomy` or at the session's level for `/doctor deep`.
The safety policy engine decides under that level's posture, so yolo clears
the ordinary rails, and the autonomy mapping at that level decides the rest.
Nothing is executed.

The row is `OK` when the program resolves and the command would run without an
approval ask at that level. Otherwise it is `WARN`. The verdict says what
really happens:

| Verdict | What happens |
| --- | --- |
| `runs without approval at <level>` | The command runs at the evaluated level. |
| `asks for approval at default and runs at yolo` | An ordinary rail, such as `$(...)` command substitution or an unrecognized command. Default asks and yolo runs it. |
| `asks for confirmation at default and yolo` | A damage-control confirmation rule matched. It asks at both levels. |
| `blocked by the safety policy` | A block. It holds at both levels. |

A verdict that comes from a safety rule names the rule's reason code in
parentheses. A command that asks only because it is unrecognized gets a hint
instead: declare it in `.clio-coder/safety.yaml` to run it unattended at
default. The project safety file takes effect only after you approve it with
`clio-coder config trust safety`.

With no contract, or a contract with no validators, the dry run adds no rows.

## In the session

`/doctor` runs the same checks as the CLI and shows them as one notice headed
by a tally, for example `doctor: 58 checks, 0 error(s), 3 warning(s)`. The
notice takes the level of the worst row. `/doctor` never repairs anything;
run `clio-coder doctor --fix` from a shell for that.

Deep tool-probe rows report INFO when an available runtime has no live probe, naming the credential source. A failed health probe remains WARN and reports its last error.

If the managed Yazi cache cannot be written, profile generation returns a profile error. Its diagnostic failure marker is best-effort; a cache failure does not crash either launcher.
