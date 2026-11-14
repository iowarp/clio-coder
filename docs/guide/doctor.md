# Doctor

`clio-coder doctor` ([doctor.ts](../../src/cli/doctor.ts), [doctor.ts](../../src/domains/lifecycle/doctor.ts)) diagnoses a CLIO Coder install and current workspace. Plain `doctor` is read-only and sends no model generation request (passive endpoint probes use a 2.5s budget per target). See [First problems](troubleshooting.md#first-problems) to interpret common errors.

## Invocations

| Invocation | Behavior |
| --- | --- |
| `clio-coder doctor` | Standard checks; quiet `OK`/`INFO` families with `>= 2` rows fold in text output (`N rows folded; \`clio-coder doctor --verbose\` prints each one`). |
| `clio-coder doctor --verbose` | Unfolded text output. |
| `clio-coder doctor --json` | Emits `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }` on stdout (never folded). |
| `clio-coder doctor --fix` | Repairs missing dirs, templates, `settings.yaml`/`credentials.yaml` mode (`0600` POSIX), state/data root mode (`0700` when ownership verifies), YAML 1.1 `on`/`off` booleans, retired keys/enum values (preserving comments unless aliases/anchors prevent it), fleet preflight cache, stale task worktree claims, stale Yazi profile, GUI background service/launchers, and missing source checkout build outputs. Wrong model IDs update only on interactive confirmation. Does not run lifecycle migrations (`clio-coder upgrade` does). |
| `clio-coder doctor --deep [--tools-timeout <s>]` | Adds live streamed tool-call probes (`tools <target>`, default `120`s timeout) and validation contract dry run (`validator <n>`). Composes with `--json` and `--fix`. |
| `/doctor [--deep]` | In-session summary notice (`doctor: <N> checks, <E> error(s), <W> warning(s)`) with worst-row level; read-only (never repairs). |

`--tools-timeout` without `--deep`, non-positive `--tools-timeout`, or unknown flags print help to stderr and exit `2`. `--help` prints to stdout and exits `0`.

## Levels, folding, and exit codes

| `level` | Badge | Meaning | Exit code |
| --- | --- | --- | --- |
| `ok` | `OK` | Healthy. | `0` |
| `info` | `INFO` | Informational (e.g., absent optional tool). | `0` |
| `warn` | `WARN` | Degraded or advisory; CLIO Coder still runs. | `0` |
| `error` | `!!` | Broken requirement (`ok: false`). | `1` |

- Text folding applies only to `interop` (except `interop skills`), `toolchain`, `slurm`, and `naming` when all rows in the family are `ok`/`info` and count `>= 2`. Any `warn`/`error` row stays expanded.
- `warn` and `error` findings that do not already contain a backticked `clio-coder`, `pnpm`, or `chmod` command get `; next: \`<command>\`` appended automatically (`withDoctorCommand`).

## First rows and target checks

- **`chat`**: Leads the report with configured route and reachability/setup command. On an uninitialized home, plain `doctor` warns on `chat` and `installation` (`not set up yet`), writes nothing, and exits `0` (`--fix` creates directories without configuring a model).
- **`connection <id>`**: Per-target credential status, passive probe result (2.5s budget; expired OAuth reported without refreshing), and model-list state. Missing credentials/failed probe is `error` for targets used by `chat`/`fleet`/`memory`, else `warn`. `alcf` passive check reads catalog only (does not probe inference URL).
- **`model <id>`**: Checks configured role models against live, cached, configured, or catalog model lists. Missing from live list on `chat`/`fleet`/`memory` target is `error` (except `copilot-sdk`, which reports `INFO` and sends model ID as typed).
- **`copilot sign-in` / `copilot tier <id>`**: When a `copilot-sdk` target and SDK component exist, probes Copilot login with system keychain closed (`run`/worker behavior); in a TTY, falls back to keychain open and emits `WARN` with headless fix instructions if login exists only there (`no terminal` notes keychain was skipped). Missing login is `error` if active in `chat`/`memory`/`fleet`, else `warn`. Targets with `contextTier: long_context` emit an `INFO` `copilot tier <id>` row.
- **`local worker capacity`**: Reports usable CPUs, available memory, cgroup/process limit, and resolved `auto` worker count (explicitly notes GPU/VRAM fit is not inspected).

## Core install rows

| Row(s) | Checks and failure conditions |
| --- | --- |
| `repair` | `!!` if `--fix` threw while repairing directories. |
| `Clio Coder version`, `node version`, `platform`, `engine runtime` | CLI version, Node `>= 22.19.0`, OS/arch, bundled/SDK runtime presence. |
| `install method` | Kind (`installer`, `npm`, `pnpm`, `bun`, `homebrew`, `winget`, `source`, `local`, `unknown`), tracking/pin state, `autoUpdate` blocker (`env`\|`setting`\|`installer`\|`pin`), last background update / waiting `pid@host` holds. `WARN` on launcher/Node mismatch, failed/waiting update, or `unknown` layout. |
| `directory layout`, `config dir`, `data dir`, `state dir`, `cache dir` | Absolute, distinct, non-nesting paths (including symlinks). |
| `settings.yaml*` | `settings.yaml` (`OK` or `!!` invalid keys), `settings.yaml mode` (`WARN` > `0600` POSIX; `--fix` -> `0600`), `settings.yaml booleans` (`WARN` YAML 1.1 `on`/`off`), `settings.yaml retired keys` / `retired values`, `settings.yaml repair` / `repair skipped` (`WARN` when aliases/anchors block rewrite). |
| `credentials` | `!!` if `credentials.yaml` missing, unreadable, or mode != `0600` on POSIX (Windows checks content only). |
| `state metadata` | `!!` if `home.json` missing/unreadable/older version (`dev` build skips stamp check), or if a newer CLIO Coder wrote the home (lists newer version, `PATH` binaries, `CLIO_CODER_ALLOW_OLDER=1` override for headless/ACP). |
| `state dir mode`, `data dir mode` | `WARN` if group/other bits set on POSIX (`--fix` sets `0700` if ownership verifies). |
| `lifecycle migrations` | Status of `migrations.json` (`2026-09-01-settings-v2` and `2026-09-01-retire-panes-knobs` auto-satisfy if `settings.yaml` already matches; `!!` on corrupt/oversized manifest). |
| `installation files`, `running <surface> <pid>` | Source checkouts and packages with `dist/build.json` verify build outputs (`--fix` rebuilds checkout); stale live processes emit `WARN`. |
| `GUI background`, `GUI running version` | Shown when `state/gui/background` exists; `WARN` on broken/foreign service/launchers (`--fix` repairs) or stale running GUI version. |
| `session store` | Readable session ledger count; `!!` on unreadable ledgers/dirs. |
| `telemetry`, `cache telemetry` | Effective capture mode, workspace consent count/grant (`WARN` on unreadable settings/consent), and latest session prompt-cache stats (`INFO` if no cached calls, `WARN` if journal unreadable; `clio-coder telemetry doctor` checks seals). |
| `state storage`, `home storage`, `install root` | Disk footprint of state (with top subdir), config/data/cache, and installer root (`WARN` when binary runs outside an existing installer root; remove with `clio-coder uninstall --inactive`). |
| `target <id>`, `cache <id>` | `WARN` if OpenAI/Anthropic-compat target behaves like native LM Studio/Ollama (suggests `clio-coder targets convert`) or has cache advisories; `!!` on unknown runtime. |
| `proxy`, `scheduler commands` | `proxy` shown when `HTTP_PROXY`/`HTTPS_PROXY` set; `scheduler commands` shown when sandbox active and Slurm/PBS/LSF/Flux CLI found on `PATH`. |

Conditional rows:
- `validation contract`: valid (raises rigor default to `high`), absent, `WARN` Markdown-only, or `!!` invalid ([doctor-validation-contract.ts](../../src/cli/doctor-validation-contract.ts)).
- `interop <agent>`, `fleet node <id>` (SSH preflight cache), `harness` / `harness <file>` (`!!` per unresolved custom agent/skill/settings ref), `playbook <name>` (`WARN` on shadowed name), `reports` (`INFO` when reports submitted).
- `naming immutable history`, `naming git refs`, `naming worktree markers`: `WARN` on retained legacy `clio` IDs/`clio/task/*`/`clio/compete/*` refs/worktree markers (always read-only, never modified by `--fix`; [doctor-naming.ts](../../src/cli/doctor-naming.ts)).
- `store backend`, `store root`, `store <check>`: active store (`local` default or `clio-core` probes; [doctor-store.ts](../../src/cli/doctor-store.ts), [store.md](store.md)).

## External tools, PDFs, and panes

`external tool <id>` covers pinned binaries (`asciinema`, `herdr`, `yazi`, `croc`, `cliamp`; never `error`) ([doctor-toolchain.ts](../../src/cli/doctor-toolchain.ts), [resolve.ts](../../src/domains/toolchain/resolve.ts)):
- `herdr` never uses `PATH` (`OK` pinned copy, `WARN` missing -> `clio-coder panes install`, `INFO` unsupported platform).
- Other pinned tools prefer `PATH` if version `>= minimumVersion`, else vendored copy (`WARN` on missing `yazi` while files pane enabled; `OK` disabled detail when off; `INFO` on missing optional `croc`/`cliamp`/`asciinema`). Superseded vendored versions list update command `clio-coder tools install <id>`.
- `files pane profile`: managed Yazi profile state (`OK`/`INFO`/`WARN`; `--fix` regenerates when `yazi` + `ya` resolve and validate).
- `panes ...` ([doctor-panes.ts](../../src/cli/doctor-panes.ts)): Outside `HERDR_ENV=1`, emits only `panes mode` and `panes layout`. Inside `HERDR_ENV=1`, emits 7 non-error rows: `panes mode`, `panes socket`, `panes protocol`, `panes binary`, `panes layout`, `naming panes`, `panes journal dir`.
- `pdf attachments`: Checks `pdftotext` and `pdfinfo` on `PATH` (`OK` with version, else `INFO` with `brew install poppler` / `scoop install poppler` / `poppler-utils`; runs even on uninitialized home).

## HPC toolchain rows

Probes `cc` (falls back to `gcc`), `c++` (falls back to `g++`), `clang`, `gfortran`, `mpicc`, `mpicxx`, `mpirun`, `nvcc`, `cmake`, `make`, `ninja`, `meson`, `python3`, and `sbatch` concurrently with a 2s `--version` timeout from a scratch dir ([doctor-hpc.ts](../../src/cli/doctor-hpc.ts)):
- Absent tool: `INFO`, or `WARN` if referenced by workspace validation contract validators (or missing `sbatch` when `runtime.kind: slurm`).
- Non-zero `--version`: `WARN` (e.g., unconfigured Slurm client). Slurm timeout emits `WARN`; non-Slurm version timeout keeps `OK` with timeout note.

## Task worktrees

In a Git repo ([doctor-task-worktrees.ts](../../src/cli/doctor-task-worktrees.ts)):
- `task worktree root`: Resolved directory, filesystem type, free space (`WARN` if `tmpfs`/`ram`/`auto` fell back to disk).
- `task worktree <runId>` (or single `task worktrees` `none preserved`): `INFO` for intentionally settled worktrees; `WARN` for `abandoned` crashed-run worktrees or orphaned/stale claims (`--fix` deletes claims whose branch and worktree are both gone, never deletes surviving branches/worktrees).

## Shell sandbox rows

`shell sandbox` summarizes host containment from [main-session.ts](../../src/core/sandbox/main-session.ts):
- Contained (`safety.sandbox` != `off` and backend available): `OK` (or `WARN` if secret discovery hit limit, `safety.sandboxUnixSockets` fell back to masks, or unconfined yolo refused), reporting `<backend>`, writable roots, masked secret-file count, socket enforcement (`seccomp`/`Seatbelt`/allow/masked), and yolo behavior (`contained-sandbox` vs `unconfined` variants).
- Uncontained (`safety.sandbox: off` or no backend): `WARN`, formatted as `<reason>; <yoloState>; default-autonomy shell commands run uncontained and keep the approval rails`.
- `safety.scratchRoots`: One `WARN` row per invalid/excluded configured scratch root.

See [Containment at default](../architecture/safety-model.md#containment-at-default).

## Slurm MCP and System One

- **Slurm MCP** ([doctor-slurm.ts](../../src/cli/doctor-slurm.ts)): Emits `slurm clio-kit`, `slurm mcp server`, and `slurm scheduler` (5s timeout), or single `INFO` `slurm mcp` row if none exist. Never fails doctor.
- **System One** ([doctor.ts](../../src/domains/lifecycle/doctor.ts)): Never asks for a decision during checks. `system one (experimental)` is `INFO` `off` if unconfigured, else `OK`/`WARN` per route. `system one (experimental) engine <name>` reports profile, context window provenance, and passive server health (`WARN` if unreachable; use `clio-coder systemone check <engine> --live` to test a decision).

## Deep checks

Enabled via `clio-coder doctor --deep` or `/doctor --deep` ([doctor-deep.ts](../../src/cli/doctor-deep.ts)):
- **`tools <target>`**: Runs live streamed tool-call probe (`--tools-timeout`, default `120`s) per target (`OK` valid call + latency; `WARN` failed health/credentials or malformed/missing tool call; `INFO` no model, non-streaming runtime, no live probe, or non-chat decision target). Unloads only a local model that the probe itself loaded.
- **`validator <n>`**: Evaluates each validator command in the workspace validation contract against tool admission at configured `safety.autonomy` (or live session autonomy under `/doctor --deep`) without executing it. `OK` if executable resolves (`PATH` or workspace-relative) and runs without ask; `WARN` with reason code when it would ask (`runs ...` / `asks for approval ...` / `blocked by the safety policy`). Unrecognized commands suggest adding to `.clio-coder/safety.yaml` + `clio-coder config trust safety`.
