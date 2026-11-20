# Doctor

`clio-coder doctor` ([doctor.ts](../../src/cli/doctor.ts), [doctor.ts](../../src/domains/lifecycle/doctor.ts)) diagnoses a CLIO Coder install and current workspace. Plain `doctor` is read-only and sends no model generation request (passive endpoint probes use a 2.5s budget per target). See [First problems](troubleshooting.md#first-problems) to interpret common errors.

## Invocations

| Invocation | Behavior |
| --- | --- |
| `clio-coder doctor` | Standard checks; quiet `ok`/`info` families with `>= 2` quiet rows fold in text output (``N rows folded; `clio-coder doctor --verbose` prints each one``). |
| `clio-coder doctor --verbose` | Unfolded text output. |
| `clio-coder doctor --json` | Emits `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }` on stdout (never folded). |
| `clio-coder doctor --fix` | Repairs missing dirs, templates, `settings.yaml`/`credentials.yaml` mode (`0600` POSIX), state/data root mode (`0700` when ownership verifies), YAML 1.1 `on`/`off` booleans, retired keys/enum values (preserving comments unless aliases/anchors prevent it), fleet preflight cache, stale task worktree claims, stale Yazi profile, GUI background service/launchers, and missing source checkout build outputs. Wrong model IDs update only on interactive confirmation. Does not run lifecycle migrations (`clio-coder upgrade` does). |
| `clio-coder doctor --deep [--tools-timeout <s>]` | Adds live streamed tool-call probes (`tools <target>`, default `120`s timeout) and validation contract dry run (`validator <n>`). Composes with `--json` and `--fix`. |
| `/doctor [--deep]` | In-session summary notice (e.g. `doctor: 58 checks, 0 error(s), 3 warning(s)`) with worst-row level; read-only (never repairs). |

`--tools-timeout` without `--deep`, non-positive `--tools-timeout`, or unknown flags print help to stderr and exit `2`. `--help` prints to stdout and exits `0`.

## Levels, folding, and exit codes

| `level` | Badge | Meaning | Exit code |
| --- | --- | --- | --- |
| `ok` | `OK` | Healthy. | `0` |
| `info` | `INFO` | Informational (e.g., absent optional tool). | `0` |
| `warn` | `WARN` | Degraded or advisory; CLIO Coder still runs. | `0` |
| `error` | `!!` | Broken requirement (`ok: false`). | `1` |

- Text folding applies to `interop` (except `interop skills`), `toolchain`, `slurm`, and `naming` whenever a family has `>= 2` quiet (`ok`/`info`) rows, even if sibling rows in that family are `warn` or `error` (the `warn`/`error` rows print expanded beside the folded summary row) ([doctor.ts](../../src/cli/doctor.ts)):
  - Summary format `<ok-word>: a, b; <info-word>: c`: `interop` (`on PATH` / `noted`; `` `clio-coder configure --interop` reviews them ``), `toolchain` (`found` / `not on PATH`), `slurm` (`ready` / `not set up`), `naming` (`clean` / `noted`).
- `warn` and `error` findings that do not already contain a backticked `clio-coder`, `pnpm`, or `chmod` command get `` ; next: `<command>` `` appended automatically (`withDoctorCommand`).

## First run: which rows to read first

1. **`chat`**: Leads the report; names the configured route and `endpoint reachable` or the missing piece with its recovery command. Fix `!!` rows first.
2. **`connection <id>`**: One per configured target; reports credential availability, passive probe answer, and any failure detail.
3. **`shell sandbox`**: `OK` when contained in an OS sandbox; `WARN` when uncontained (more commands ask for approval).

## Target and capacity rows

- **`chat`**: On an uninitialized home, plain `doctor` warns on `chat` and `installation` (`not set up yet`), writes nothing, and exits `0` (`--fix` creates directories without configuring a model).
- **`connection <id>`**: Per-target credential check and 2.5s passive probe (expired browser OAuth is reported without refreshing). Missing credentials/failed probe is `error` for targets used by `chat`/`fleet`/`memory`, else `warn`. Successful public metadata does not prove credentials are ready for inference. `alcf` passive check reads catalog only (does not probe inference URL).
- **`model <id>`**: Checks configured role models against live, cached, configured, or provider catalog lists. A catalog match is not live availability (and absence from a catalog/recorded list is `WARN`). Absence from a live list on a `chat`/`fleet`/`memory` target is `error` (except `copilot-sdk`, which emits `INFO` and sends model ID as typed).
- **`copilot sign-in` / `copilot tier <id>`**: When a `copilot-sdk` target and SDK component exist, probes Copilot login with system keychain closed (`run`/worker behavior); in a TTY, falls back to keychain open and emits `WARN` with headless fix instructions if login exists only there (`no terminal` notes keychain was skipped). Missing login is `error` if active in `chat`/`memory`/`fleet`, else `warn`. CLIO Coder reads no token; only the runtime answers. `contextTier: long_context` emits an `INFO` `copilot tier <id>` row.
- **`local worker capacity`**: Reports usable CPUs, available memory, cgroup/process limit, and resolved `auto` worker count (explicitly notes GPU/VRAM fit is not inspected).

## Core install rows

| Row(s) | Checks and failure conditions |
| --- | --- |
| `repair` | `!!` (`--fix could not finish: <reason>`) if `--fix` threw while repairing directories. |
| `Clio Coder version`, `node version`, `platform`, `engine runtime` | CLI version, Node `>= 22.19.0`, OS/arch, bundled/SDK runtime presence. |
| `install method` | Kind (`installer`, `npm`, `pnpm`, `bun`, `homebrew`, `winget`, `source`, `local`, `unknown`), tracking/pin state (`follows <channel>; background updates on` or `off (<blocker>)` where blocker is `env`\|`setting`\|`installer`; `pinned to <version> since <date> (<origin>); release with clio-coder upgrade --channel <channel>`; npm/pnpm/bun `<kind> global; follows latest through <kind>; update after exit on\|off (<reason>)`), last background update / waiting `pid@host` holds. `WARN` on launcher/Node mismatch, failed/waiting update, or `unknown` layout. |
| `directory layout`, `config dir`, `data dir`, `state dir`, `cache dir` | Absolute, distinct, non-nesting paths (including symlinks). |
| `settings.yaml*` | `settings.yaml` (`OK` or `!!` invalid keys), `settings.yaml mode` (`WARN` > `0600` POSIX; `--fix` prints `tightened <old> -> 600`; skipped on Windows), `settings.yaml booleans` (`WARN` YAML 1.1 `on`/`off`), `settings.yaml retired keys` / `retired values`, `settings.yaml repair` / `repair skipped` (`WARN` when aliases/anchors/tags block rewrite). |
| `credentials` | `!!` if `credentials.yaml` missing, unreadable, or mode != `0600` on POSIX; on Windows `WARN` names any ACL principal beyond the owner, SYSTEM and Administrators, and `--fix` makes the file owner-only. |
| `state metadata` | `!!` if `home.json` missing/unreadable/older version (`dev` build skips stamp check), or if a newer CLIO Coder wrote the home (lists newer version, `PATH` binaries, `CLIO_CODER_ALLOW_OLDER=1` override for headless/ACP). |
| `state dir mode`, `data dir mode` | `WARN` if group/other bits set on POSIX (`--fix` tightens when ownership verifies -> `tightened to 700`; otherwise `chmod 700` it yourself when not CLIO Coder's alone). |
| `lifecycle migrations` | Status of `migrations.json`: `2026-09-01-settings-v2` and `2026-09-01-retire-panes-knobs` auto-satisfy if `settings.yaml` already matches; pending migrations emit `WARN` naming the post-install command; `!!` on corrupt/oversized manifest (restore or review before `upgrade`). |
| `installation files`, `running <surface> <pid>` | Release builds/checkouts verify outputs (`!!` remedies: `pnpm --dir <checkout> run build` for source, which `--fix` runs, or `clio-coder upgrade` for packages); stale live processes emit `WARN`. |
| `GUI background`, `GUI running version` | Shown when `state/gui/background` exists; `WARN` on broken/foreign service/launchers (`--fix` repairs) or stale running GUI version. |
| `session store` | Readable session ledger count; `!!` on unreadable ledgers/dirs. |
| `telemetry`, `cache telemetry` | Effective capture mode, workspace consent count/grant (`WARN` on unreadable settings/consent), and latest session prompt-cache stats (`INFO` if no cached calls, `WARN` if journal unreadable; `clio-coder telemetry doctor` checks seals). |
| `state storage`, `home storage`, `install root` | Disk footprint of state (with top subdir), config/data/cache, and installer root (`WARN` when binary runs outside an existing installer root; remove with `clio-coder uninstall --inactive`). |
| `target <id>`, `cache <id>` | `WARN` if OpenAI/Anthropic-compat target behaves like native LM Studio/Ollama (suggests `clio-coder targets convert`) or has cache advisories; `!!` on unknown runtime. |
| `proxy`, `scheduler commands` | `proxy` shown when `HTTP_PROXY`/`HTTPS_PROXY` set; `scheduler commands` shown when sandbox active and Slurm/PBS/LSF/Flux CLI found on `PATH`. |

Conditional rows:
- `validation contract`: valid (raises rigor default to `high`), absent, `WARN` Markdown-only, or `!!` invalid ([doctor-validation-contract.ts](../../src/cli/doctor-validation-contract.ts)).
- `interop <agent>`, `fleet node <id>` (SSH preflight cache), `harness` / `harness <file>` (`!!` per unresolved custom agent/skill/settings ref), `playbook <name>` (`WARN` on shadowed name), `reports` (`INFO` `<N> sent, <M> fixed`, listing fixed issues with release).
- `naming immutable history`, `naming git refs`, `naming worktree markers`: `WARN` on retained legacy `clio` IDs/`clio/task/*`/`clio/compete/*` refs/worktree markers (always read-only, never modified by `--fix`; [doctor-naming.ts](../../src/cli/doctor-naming.ts)).
- `store backend`, `store root`, `store <check>`: `local (no selection; the default)` unless overridden (`WARN` on unusable selection record), store dir + free space, or `clio-core` probes ([doctor-store.ts](../../src/cli/doctor-store.ts), [store.md](store.md)).

## External tools, PDFs, and panes

`external tool <id>` covers `asciinema`, `herdr`, `yazi`, `croc`, `cliamp` (never `error`) ([doctor-toolchain.ts](../../src/cli/doctor-toolchain.ts), [resolve.ts](../../src/domains/toolchain/resolve.ts)):
- `herdr` uses CLIO Coder's pinned copy only: ``pane host <pin> (Clio's pinned copy) at <path>`` (`OK`), `` pane host <pin> is not installed; run `clio-coder panes install` `` (`WARN`), or `no pinned pane host for this platform; Clio runs without panes` (`INFO`).
- Other tools prefer `PATH` when version `>= minimumVersion`, else vendored copy (`WARN` on missing `yazi` while files pane enabled; `INFO` on missing `croc`/`cliamp`/`asciinema`):

| Detail | Meaning |
| --- | --- |
| `PATH <path> (<version>, pin <pin>)` | `PATH` binary met minimum floor and is used. |
| `vendored <path> (<pin>)` | Bundled/installed binary used (names any rejected `PATH` binary and floor). |
| ``vendored <versions> is superseded by the <pin> pin (update with `clio-coder tools install <id>`)`` | Only older vendored copies exist on disk; nothing resolves. |
| `PATH copy <path> is <version>, below the <floor> floor, and nothing is vendored (install with ...)` | `PATH` binary is too old and no vendored binary exists. |
| ``not found (install with `clio-coder tools install <id>`)`` | Neither `PATH` nor vendored copy resolves. |
| `not installed and no pinned asset for this platform (<platform>)` | No upstream pinned asset for host platform. |
| `experimental integration disabled by settings` | `yazi` when files pane is disabled (`OK`). |

- `files pane profile`: managed Yazi profile (`OK`/`INFO`/`WARN`; `--fix` regenerates when `yazi` + `ya` resolve and Yazi validates it; cache write errors return a profile error without crashing launchers).
- `panes ...` ([doctor-panes.ts](../../src/cli/doctor-panes.ts)): Outside `HERDR_ENV=1`, emits only `panes mode` and `panes layout`. Inside `HERDR_ENV=1`, emits 7 non-error rows (`panes mode`, `panes socket`, `panes protocol`, `panes binary`, `panes layout`, `naming panes`, `panes journal dir`).
- `pdf attachments`: checks `pdftotext` + `pdfinfo` on `PATH` (`OK` with version, else `INFO` with `brew install poppler` / `scoop install poppler` / `poppler-utils`; runs on uninitialized homes too).

## HPC toolchain rows

Probes `cc` (`gcc`), `c++` (`g++`), `clang`, `gfortran`, `mpicc`, `mpicxx`, `mpirun`, `nvcc`, `cmake`, `make`, `ninja`, `meson`, `python3`, `sbatch` concurrently (2s `--version` timeout from a scratch dir; [doctor-hpc.ts](../../src/cli/doctor-hpc.ts)). Absent = `INFO` (or `WARN` if referenced by validation contract or missing `sbatch` with `runtime.kind: slurm`); non-zero exit = `WARN`; Slurm timeout = `WARN` (other timeouts stay `OK` with timeout note).

## Task worktrees

In a Git repo ([doctor-task-worktrees.ts](../../src/cli/doctor-task-worktrees.ts)):
- `task worktree root`: resolved dir, filesystem type, free space (`WARN` if `tmpfs`/`ram`/`auto` fell back to disk).
- `task worktree <runId>` (or `task worktrees`: `none preserved`): prints `<branch> (<state>, <age>, <reason>): inspect with git log <base>..<branch>; drop with ...`. `INFO` for `settled`, `WARN` for `abandoned` or orphaned claims (`--fix` removes stale claims whose branch and worktree are both gone, never deletes surviving branches or worktrees).

## Shell sandbox rows

`shell sandbox` summarizes host containment ([main-session.ts](../../src/core/sandbox/main-session.ts)):
- Contained (`safety.sandbox` != `off` and backend available): `OK` (or `WARN` if secret discovery hit limit, sockets fell back to masks, or unconfined yolo refused): `default-autonomy shell commands run in the <backend> sandbox; writable roots: ...`, masked secret count, Unix socket enforcement (`seccomp`/`Seatbelt`/allow/masked), plus yolo line.
- Uncontained (`safety.sandbox: off` or no backend): `WARN`: `<reason>; <yoloState>; default-autonomy shell commands run uncontained and keep the approval rails`.
- Yolo state texts: `yolo runs contained in the same sandbox`, `contained yolo runs commands as default does and refuses what would ask`, `unconfined yolo commands run sandboxed too (safety.sandbox is required)`, `unconfined yolo refuses commands: safety.sandbox is required and no sandbox is available (...)`, `unconfined yolo runs unsandboxed`.
- `safety.scratchRoots`: one `WARN` row per invalid/excluded configured scratch root.

See [Containment at default](../architecture/safety-model.md#containment-at-default).

## Slurm MCP and System One

- **Slurm MCP** ([doctor-slurm.ts](../../src/cli/doctor-slurm.ts)): `slurm clio-kit`, `slurm mcp server`, `slurm scheduler` (5s timeout), or single `INFO` `slurm mcp` row if absent. Never fails doctor.
- **System One** ([doctor.ts](../../src/domains/lifecycle/doctor.ts)): `INFO` `off` if unconfigured, else `OK`/`WARN` per route plus `system one (experimental) engine <name>` (profile, context window provenance, passive health; use `clio-coder systemone check <engine> --live` to test decisions).

## Deep checks

Enabled via `clio-coder doctor --deep` or `/doctor --deep` ([doctor-deep.ts](../../src/cli/doctor-deep.ts)):
- **`tools <target>`**: Live streamed tool-call probe (`--tools-timeout`, default `120`s) per target (`OK` valid call + latency; `WARN` failed health/credentials or malformed/missing call; `INFO` no model, non-streaming runtime, no live probe, or non-chat decision engine). Unloads only a cold local model loaded by the probe itself.
- **`validator <n>`**: Resolves each contract validator executable (`PATH` or workspace-relative when containing `/`) and evaluates bash admission at configured `safety.autonomy` (or live session autonomy for `/doctor --deep`) without execution (`OK` if resolved + runs without ask, else `WARN`):

| Verdict | Meaning |
| --- | --- |
| `runs without approval at default` / `at yolo in the operator's session` | Admitted without approval prompt at evaluated level. |
| `asks for approval at default and runs at yolo in the operator's session` | Prompts (or judge-reviewed) at `default`; runs at `yolo`. If unrecognized, declare in `.clio-coder/safety.yaml` + `clio-coder config trust safety`. |
| `asks for confirmation at default and at yolo in the operator's session` | Explicit confirmation required even at `yolo` (with rule reason code). |
| `blocked by the safety policy (<reasonCode \| classification>)` | Blocked at the evaluated level. |
