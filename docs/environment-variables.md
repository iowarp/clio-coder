# Environment Variables

> [!TIP]
> **Interactive Spec Available:** An interactive searchable env var matrix and effective path resolver is located at [docs/html/environment_blueprint.html](html/environment_blueprint.html) (Version: 0.2.8).

Every environment variable the shipped `src/` tree reads, grouped by role. Settings.yaml is the durable home for operator policy; env vars exist for per-process overrides (CI, one-off experiments), directory layout, debugging, and internal plumbing. When prose and source disagree, prefer the source; the table cites the read site.

## Guardrail overrides

Durable values live in the `guardrails:` section of settings.yaml (see [configuration-and-targets.md](configuration-and-targets.md)). These env vars override them for one process; resolution is env > settings > built-in default, and every value is a positive integer. Resolution lives in `src/core/guardrails.ts`.

| Variable | Settings key | Default | Controls |
| --- | --- | --- | --- |
| `CLIO_TURN_TOOL_CALL_BUDGET` | `guardrails.turnToolCallBudget` | 60 | Orchestrator per-turn soft tool-call budget; the hard interrupt ceiling sits 15 above it (`src/engine/loop-guard.ts`). |
| `CLIO_WORKER_TOOL_CALL_CAP` | `guardrails.workerToolCallCap` | 50 | Lifetime tool-call cap per dispatched worker run (`src/engine/loop-guard.ts`). |
| `CLIO_MAX_RUNS` | `guardrails.maxDispatchRuns` | 1000 | Dispatch run-ledger retention cap (`src/domains/dispatch/state.ts`). |
| `CLIO_READ_MAX_BYTES` | `guardrails.readMaxBytes` | 51200 | Per-call byte cap for the read tool, floored at 1024 (`src/tools/read.ts`). |
| `CLIO_OBSERVATION_TURN_BUDGET_BYTES` | `guardrails.observationTurnBudgetBytes` | 196608 | Shared per-turn byte pool across observation tools (`src/tools/observation.ts`). |

## Behavior knobs without a settings key

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_RIGOR` | repo-derived | Finish-contract evidence bar, `normal` or `high`, layered over the repo-derived default (`src/domains/safety/rigor.ts`). |
| `CLIO_RESIDENCY` | managed | `observe`/`off` stops Clio managing model residency on local servers (`src/engine/apis/residency.ts`). |
| `CLIO_TRUST_PROJECT_SKILLS` | off | `1` trusts project-local skills for execution (`src/domains/resources/skills/loader.ts`). |
| `CLIO_ALLOW_EXTERNAL_FULL_ACCESS` | off | `1` lets full-auto pass through to external CLI runtimes with their own full access (`src/engine/claude/subprocess-runtime.ts`, `src/engine/antigravity/subprocess-runtime.ts`). |
| `CLIO_FORCE_COMPACT` | off | `1` forces compaction on the next interactive turn (`src/interactive/chat-loop.ts`). |
| `CLIO_STATUS_STUCK_MS` | 180000 | Stuck-turn watchdog threshold (`src/interactive/status/watchdog.ts`). |
| `CLIO_SHUTDOWN_HOOK_MS` | 500 | Wall-clock budget per shutdown hook (`src/core/termination.ts`). |
| `CLIO_HOOK_BUDGET_MS` | per-phase built-ins | Global middleware hook wall-clock budget (`src/domains/middleware/budget.ts`). |
| `CLIO_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | Per-phase hook budget, e.g. `CLIO_HOOK_BUDGET_TURN_END_MS`; beats the global var. |
| `CLIO_HOOK_BUDGET_WARMUP_CALLS` | 1 | Hook calls exempted from budget accounting at startup. |
| `CLIO_HOOK_BUDGET_WINDOW` | 5 | Sliding-window size for steady-state hook-budget warnings. |
| `CLIO_HOOK_BUDGET_THRESHOLD` | 3 | Overruns within the window before a steady-state warning. |
| `CLIO_SKILL_CATALOG_DIR` | unset | Local skill-catalog directory override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_SKILL_MARKETPLACE_INDEX` | unset | Skill-marketplace index path override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_MODEL_CATALOG_DIRS` | unset | Extra model-catalog directories (`src/domains/providers/knowledge-base-path.ts`). |

## Directory and install layout

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_HOME` | unset | Single-tree install root; the per-role vars below beat it (`src/core/xdg.ts`). |
| `CLIO_CONFIG_DIR`, `CLIO_DATA_DIR`, `CLIO_STATE_DIR`, `CLIO_CACHE_DIR` | XDG platform defaults | Per-role directory overrides (`src/core/xdg.ts`). |
| `CLIO_BIN_DIR` | `~/.local/bin` | Launcher symlink location (`src/cli/uninstall.ts`). |
| `CLIO_PACKAGE_ROOT` | auto-detected | Package root for bundled-asset resolution (`src/core/package-root.ts`). |

## Debug and trace toggles

All default off; enable with `1`.

| Variable | Controls |
| --- | --- |
| `CLIO_BUS_TRACE` | Event-bus channel tracing to stderr (`src/core/bus-trace.ts`). |
| `CLIO_TRACE_BOOT` | Boot-phase timing trace (`src/core/boot-trace.ts`). |
| `CLIO_TIMING` | Startup timing report (`src/entry/orchestrator.ts`). |
| `CLIO_DEBUG_SHUTDOWN` | Shutdown-path diagnostics (`src/core/termination.ts`). |
| `CLIO_DEBUG_LMSTUDIO` | LM Studio wire logging (`src/domains/providers/runtimes/common/lmstudio-logger.ts`). |
| `CLIO_RUNTIME_VERBOSE` | Verbose runtime logging (`src/engine/apis/lmstudio-native.ts`). |
| `CLIO_HOOK_BUDGET_DEBUG` | Per-overrun hook-budget diagnostics (`src/domains/middleware/runtime.ts`). |

## Internal plumbing

Set by Clio for its own processes; not operator knobs.

| Variable | Purpose |
| --- | --- |
| `CLIO_INTERACTIVE` | Marks the interactive TUI process; scrubbed from bash-tool children so nested invocations do not inherit it (`src/cli/clio.ts`, `src/core/bash-exec.ts`). |
| `CLIO_RUN_OVERRIDES` | JSON envelope for run-scoped CLI options (`--max-context-tokens`, `--kv-cache-mode`, sampling flags). One typed variable instead of one env var per option; worker subprocesses inherit it (`src/core/run-overrides.ts`). |
| `CLIO_RESUME_SESSION_ID` | Session id handed across a self-restart; consumed and deleted at boot (`src/entry/orchestrator.ts`). |
| `CLIO_BOOTSTRAP_GENERATE_CHILD` | Marks the CLIO.md-generation child so it skips recursion (`src/domains/context/extension.ts`). |

## Test-only

| Variable | Purpose |
| --- | --- |
| `CLIO_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | Fake worker model for tests (`src/engine/ai.ts`). |
| `CLIO_TEST_UPGRADE_NO_NETWORK` | Skips npm install during upgrade tests (`src/cli/upgrade.ts`). |
| `CLIO_REQUIRE_HOME_PREFIX` | Test guardrail: abort if resolved directories escape `CLIO_HOME` (`src/core/init.ts`). |

Variables used only by `scripts/` and `benchmarks/` harnesses (the `CLIO_LIVE_*` smoke-test family, benchmark fleet configuration, install-script inputs) are not part of the shipped runtime and are documented inline where they are consumed.
