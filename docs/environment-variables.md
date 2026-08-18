# Environment Variables

Every environment variable the shipped `src/` tree reads, grouped by role. Settings.yaml is the durable home for operator policy; env vars exist for per-process overrides (CI, one-off experiments), directory layout, debugging, and internal plumbing. When prose and source disagree, prefer the source; the table cites the read site.

This page is the complete inventory, and `tests/contracts/environment-variable-inventory.test.ts` fails if `src/` reads a variable that has no row here.

> [!TIP]
> [docs/html/environment_blueprint.html](html/environment_blueprint.html) is a browsable walkthrough of the most commonly set variables with an effective-path resolver. It covers a curated subset, so use the tables below when you need the full list.

## Guardrail overrides

Durable values live in the `guardrails:` section of settings.yaml (see [configuration-and-targets.md](configuration-and-targets.md)). These env vars override them for one process; resolution is env > settings > built-in default, and every value is a positive integer. Resolution lives in `src/core/guardrails.ts`.

| Variable | Settings key | Default | Controls |
| --- | --- | --- | --- |
| `CLIO_CODER_TURN_TOOL_CALL_BUDGET` | `guardrails.turnToolCallBudget` | 60 | Orchestrator per-turn soft tool-call budget; the hard interrupt ceiling sits 15 above it (`src/engine/loop-guard.ts`). |
| `CLIO_CODER_WORKER_TOOL_CALL_CAP` | `guardrails.workerToolCallCap` | 150 | Lifetime ceiling on tool calls one dispatched worker may execute. Calls the harness refused (reserve steering, synthesis-lockout denials) never spend it. Agent recipe budgets may narrow but never widen it (`src/engine/loop-guard.ts`). |
| `CLIO_CODER_MAX_DISPATCH_RUNS` | `guardrails.maxDispatchRuns` | 1000 | Dispatch run-ledger retention cap (`src/domains/dispatch/state.ts`). The older `CLIO_CODER_MAX_RUNS` spelling still reads when the canonical name is unset. |
| `CLIO_CODER_READ_MAX_BYTES` | `guardrails.readMaxBytes` | 51200 | Per-call byte cap for the read tool, floored at 1024 (`src/tools/read.ts`). |
| `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES` | `guardrails.observationTurnBudgetBytes` | 196608 | Shared per-turn byte pool across observation tools (`src/tools/observation.ts`). |
| `CLIO_CODER_INTERNAL_DISPATCH_TIMEOUT_MS` | `guardrails.internalDispatchTimeoutMs` | 900000 | Wall-clock cap for one internal generator dispatch: the wiki documenter and the bootstrap scout (`src/cli/internal-dispatch.ts`). |

## Behavior knobs without a settings key

| Variable | Default | Controls |
| --- | --- | --- |
| `NO_COLOR` | unset | Set to any non-empty value to drop every foreground and background color. Bold, dim, italic, and underline stay, because they are what is left to read the interface by (`src/interactive/theme/tokens.ts`). |
| `CLIO_CODER_RIGOR` | repo-derived | Finish-contract evidence bar, `normal` or `high`, layered over the repo-derived default (`src/domains/safety/rigor.ts`). |
| `CLIO_CODER_RESIDENCY` | managed | `observe`/`off` stops Clio managing model residency on every local runtime path, llama.cpp routers included; per-target opt-out via `lifecycle: user-managed` (`src/engine/apis/residency.ts`). |
| `CLIO_CODER_TRUST_PROJECT_SKILLS` | off | `1` trusts project-local skills for execution (`src/domains/resources/skills/loader.ts`). |
| `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` | off | `1` lets full-auto pass through to external CLI runtimes with their own full access (`src/engine/claude/subprocess-runtime.ts`, `src/engine/antigravity/subprocess-runtime.ts`). |
| `CLIO_CODER_FORCE_COMPACT` | off | `1` forces compaction on the next interactive turn (`src/interactive/chat-loop.ts`). |
| `CLIO_CODER_STATUS_STUCK_MS` | 180000 | Stuck-turn watchdog threshold (`src/interactive/status/watchdog.ts`). |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | 500 | Wall-clock budget per shutdown hook (`src/core/termination.ts`). |
| `CLIO_CODER_HOOK_BUDGET_MS` | per-phase built-ins | Global middleware hook wall-clock budget (`src/domains/middleware/budget.ts`). |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | Per-phase hook budget, e.g. `CLIO_CODER_HOOK_BUDGET_TURN_END_MS`; beats the global var. |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | 1 | Hook calls exempted from budget accounting at startup. |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | 5 | Sliding-window size for steady-state hook-budget warnings. |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | 3 | Overruns within the window before a steady-state warning. |
| `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` | 131072 | Largest context length Clio requests when it loads an LM Studio model while another model is resident on the same server. LM Studio reports no VRAM and caps GPU offload instead of refusing an oversized load, so a KV cache that does not fit is served from CPU at a crawl; the ceiling bounds that by evidence. `off` or `0` disables clamping (`src/engine/apis/lmstudio-residency.ts`). |
| `CLIO_CODER_SKILL_CATALOG_DIR` | unset | Local skill-catalog directory override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | unset | Skill-marketplace index path override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | unset | Extra model-catalog directories (`src/domains/providers/knowledge-base-path.ts`). |
| `CLIO_CODER_NO_NETWORK_TOOLS` | off | `1` strips network tools from every registry in the process; the skills-eval harness sets it for hermetic arms; `--allow-network` clears it (`src/tools/network-policy.ts`). |

## Directory and install layout

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_CODER_HOME` | unset | Single-tree install root; the per-role vars below beat it (`src/core/xdg.ts`). |
| `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, `CLIO_CODER_CACHE_DIR` | XDG platform defaults | Per-role directory overrides (`src/core/xdg.ts`). |
| `CLIO_CODER_BIN_DIR` | `~/.local/bin` | Launcher symlink location (`src/cli/uninstall.ts`). |
| `CLIO_CODER_PACKAGE_ROOT` | auto-detected | Package root for bundled-asset resolution (`src/core/package-root.ts`). |

## Debug and trace toggles

All default off; enable with `1`.

| Variable | Controls |
| --- | --- |
| `CLIO_CODER_BUS_TRACE` | Event-bus channel tracing to stderr (`src/core/bus-trace.ts`). |
| `CLIO_CODER_TRACE_BOOT` | Boot-phase timing trace (`src/core/boot-trace.ts`). |
| `CLIO_CODER_TIMING` | Startup timing report (`src/entry/orchestrator.ts`). |
| `CLIO_CODER_DEBUG_SHUTDOWN` | Shutdown-path diagnostics (`src/core/termination.ts`). |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | Per-overrun hook-budget diagnostics (`src/domains/middleware/runtime.ts`). |

### File-writing traces

These two take a path, not `1`. Setting either to `1` writes a file named `1` in the working directory. Both are off when unset or empty, and both create parent directories.

| Variable | Contents | Controls |
| --- | --- | --- |
| `CLIO_CODER_RENDER_TRACE` | timing only | Per-frame render timing for the interactive TUI, truncated on open so one file is one session. Records frame durations and counts and no conversation text, which makes it the instrument for reproducing a frame-cost claim at a given terminal size (`src/interactive/render-trace.ts`). |
| `CLIO_CODER_MEMORY_TRACE` | conversation text | Proactive task-memory step envelopes, including up to 8000 characters of the text each step saw. This is content-bearing by construction, so the file carries whatever the session carried. Do not enable it on work you would not paste, and do not attach the file to a bug report without reading it first (`src/domains/memory/task-memory-trace.ts`). |

Example:

```bash
CLIO_CODER_RENDER_TRACE=/tmp/clio-render.jsonl clio-coder
```

## Internal plumbing

Set by Clio for its own processes; not operator knobs.

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_INTERACTIVE` | Marks the interactive TUI process; scrubbed from bash-tool children so nested invocations do not inherit it (`src/cli/clio.ts`, `src/core/bash-exec.ts`). |
| `CLIO_CODER_RUN_OVERRIDES` | JSON envelope for run-scoped CLI options (`--max-context-tokens`, `--kv-cache-mode`, sampling flags). One typed variable instead of one env var per option; worker subprocesses inherit it (`src/core/run-overrides.ts`). |
| `CLIO_CODER_RESUME_SESSION_ID` | Session id handed across a self-restart; consumed and deleted at boot (`src/entry/orchestrator.ts`). |
| `CLIO_CODER_BOOTSTRAP_GENERATE_CHILD` | Marks the CLIO-CODER.md-generation child so it skips recursion (`src/domains/context/extension.ts`). |
| `CLIO_CODER_WORKER_LABELS` | Comma-separated labels a dispatched worker reports as its own (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_PGID` | Process-group id the transport assigns a worker so its whole tree can be signalled (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_RUN` | Marks a dispatched worker process; a skill install run inside it is stamped `installed-by: worker` (`src/worker/entry.ts`, `src/domains/resources/skills/install.ts`). |

## Test-only

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | Fake worker model for tests (`src/engine/ai.ts`). |
| `CLIO_CODER_TEST_UPGRADE_NO_NETWORK` | Skips npm install during upgrade tests (`src/cli/upgrade.ts`). |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | Test guardrail: abort if resolved directories escape `CLIO_CODER_HOME` (`src/core/init.ts`). |

Variables used only by `scripts/` and `benchmarks/` harnesses (the `CLIO_CODER_LIVE_*` smoke-test family, benchmark fleet configuration, install-script inputs) are not part of the shipped runtime and are documented inline where they are consumed.
