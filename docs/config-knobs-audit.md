# Config knobs audit

Point-in-time inventory of every tunable knob outside `settings.yaml`: environment variables, the compiled-in defaults behind them, and the CLI flags that bridge into them. Gathered 2026-07-03 by sweeping `src/` for `process.env` reads and cross-checking `scripts/`, `benchmarks/`, and `docs/`. Purpose: reason about which knobs earn their keep, which belong in `settings.yaml`, and which are dead.

> **Status: findings 1–5 fixed on 2026-07-03.** The tool-call budget vars were renamed (`CLIO_TURN_TOOL_CALL_BUDGET`, `CLIO_WORKER_TOOL_CALL_CAP`); guardrail policy moved into a `guardrails:` settings section with env as emergency override (`src/core/guardrails.ts`); the run.ts/print.ts env bridges collapsed into one typed transport (`src/core/run-overrides.ts`, `CLIO_RUN_OVERRIDES`), retiring `CLIO_MAX_CONTEXT_TOKENS`, `CLIO_KV_CACHE_MODE`, and `CLIO_SAMPLING_OVERRIDES`; the dead `CLIO_NO_UPDATE_NOTIFIER` setters were deleted; and [environment-variables.md](environment-variables.md) is now the maintained reference. The tables below describe the pre-fix state and are kept for the remaining findings (6–7).

## The pattern, first

Most knobs come in a pair that looks redundant but is not:

- `DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET = 60` is the compiled-in default constant.
- `CLIO_ORCH_MAX_TOOL_CALLS` is the env var that overrides it at runtime.

Every runtime-tunable value needs both halves; the pair is one knob, not two. The real bloat questions are different ones: whether a knob should exist at all, whether env is the right surface for it (versus `settings.yaml` or a CLI flag), and whether its name says what it does. Those are called out in the findings at the bottom.

## 1. Operator tuning knobs (read by `src/`)

| Env var | Default | Read at | Controls |
|---|---|---|---|
| `CLIO_ORCH_MAX_TOOL_CALLS` | 60 soft, hard = soft + 15 | `src/engine/loop-guard.ts` → `src/entry/orchestrator.ts` | Orchestrator per-turn tool-call budget. Soft crossing blocks further calls this turn; hard ceiling interrupts the turn. |
| `CLIO_MAX_TOOL_CALLS` | 50 | `src/engine/loop-guard.ts` → `src/engine/worker-runtime.ts` | Worker lifetime tool-call cap for a dispatched run. Different axis than the orchestrator budget despite the near-identical name. |
| `CLIO_MAX_RUNS` | 1000 | `src/domains/dispatch/state.ts` | Dispatch run-ledger retention cap. |
| `CLIO_MAX_CONTEXT_TOKENS` | unset | `src/domains/providers/runtime-resolution.ts` | Context-window override for local runtimes. Also set internally by `clio run --max-context-tokens` (see §6). |
| `CLIO_KV_CACHE_MODE` | unset | `src/engine/apis/lmstudio-native.ts` | KV-cache quantization mode. Also set internally by `clio run --kv-cache-mode`. |
| `CLIO_SAMPLING_OVERRIDES` | unset | `src/engine/apis/sampling-overrides.ts` | JSON sampling-parameter override. Set internally by print-mode sampling flags. |
| `CLIO_READ_MAX_BYTES` | 51200 (50 KB) | `src/tools/read.ts` | Per-call byte cap for the read tool. |
| `CLIO_OBSERVATION_TURN_BUDGET_BYTES` | 196608 (192 KB) | `src/tools/observation.ts` | Shared per-turn byte pool across all observation tools. |
| `CLIO_RIGOR` | repo-derived | `src/domains/safety/rigor.ts`; read in orchestrator + dispatch | Finish-contract evidence bar (`normal`/`high`), layered over the repo-derived default. |
| `CLIO_RESIDENCY` | managed | `src/engine/apis/residency.ts` | Set to `observe`/`off` to stop Clio managing model residency on local servers. |
| `CLIO_HOOK_BUDGET_MS` | per-phase built-ins | `src/domains/middleware/budget.ts` | Global middleware hook wall-clock budget. |
| `CLIO_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | `src/domains/middleware/budget.ts` | Per-phase override, e.g. `CLIO_HOOK_BUDGET_TURN_END_MS`. Beats the global var. |
| `CLIO_HOOK_BUDGET_WARMUP_CALLS` | 1 | `src/domains/middleware/budget.ts` | Hook calls exempted from budget accounting at startup. |
| `CLIO_HOOK_BUDGET_WINDOW` | 5 | `src/domains/middleware/budget.ts` | Sliding-window size for steady-state hook budget warnings. |
| `CLIO_HOOK_BUDGET_THRESHOLD` | 3 | `src/domains/middleware/budget.ts` | Overruns within the window before a steady-state warning. |
| `CLIO_STATUS_STUCK_MS` | 180000 | `src/interactive/status/watchdog.ts` | Stuck-turn watchdog threshold. |
| `CLIO_SHUTDOWN_HOOK_MS` | 500 | `src/core/termination.ts` | Wall-clock budget per shutdown hook. |
| `CLIO_FORCE_COMPACT` | off | `src/interactive/chat-loop.ts` | `1` forces compaction on the next turn regardless of threshold. |
| `CLIO_TRUST_PROJECT_SKILLS` | off | `src/domains/resources/skills/loader.ts` | `1` trusts project-local skills for execution. |
| `CLIO_ALLOW_EXTERNAL_FULL_ACCESS` | off | `src/engine/claude/subprocess-runtime.ts`, `src/engine/antigravity/subprocess-runtime.ts` | `1` lets full-auto pass through to external CLI runtimes with their own full access. |
| `CLIO_SKILL_CATALOG_DIR` | unset | `src/domains/resources/skills/marketplace.ts`, `provenance-pin.ts` | Local skill-catalog directory override. |
| `CLIO_SKILL_MARKETPLACE_INDEX` | unset | `src/domains/resources/skills/marketplace.ts` | Marketplace index path override. |
| `CLIO_MODEL_CATALOG_DIRS` | unset | `src/domains/providers/knowledge-base-path.ts` | Extra model-catalog directories. |

## 2. Directory and install layout

| Env var | Default | Read at | Controls |
|---|---|---|---|
| `CLIO_HOME` | unset | `src/core/xdg.ts` | Single-tree install root; per-role vars below beat it. |
| `CLIO_CONFIG_DIR` / `CLIO_DATA_DIR` / `CLIO_STATE_DIR` / `CLIO_CACHE_DIR` | XDG platform defaults | `src/core/xdg.ts` | Per-role directory overrides. |
| `CLIO_BIN_DIR` | `~/.local/bin` | `src/cli/uninstall.ts` | Where the launcher symlink lives. |
| `CLIO_PACKAGE_ROOT` | auto-detected | `src/core/package-root.ts` | Package root override for bundled-asset resolution. |

## 3. Debug and trace toggles

All default off; all enabled with `1`.

| Env var | Read at | Controls |
|---|---|---|
| `CLIO_BUS_TRACE` | `src/core/bus-trace.ts`, compaction | Event-bus channel tracing to stderr. |
| `CLIO_TRACE_BOOT` | `src/core/boot-trace.ts` | Boot-phase timing trace. |
| `CLIO_TIMING` | `src/entry/orchestrator.ts` | Startup timing report to stdout. |
| `CLIO_DEBUG_SHUTDOWN` | `src/core/domain-loader.ts`, `src/core/termination.ts` | Shutdown-path diagnostics. |
| `CLIO_DEBUG_LMSTUDIO` | `src/domains/providers/runtimes/common/lmstudio-logger.ts` | LM Studio wire logging. |
| `CLIO_RUNTIME_VERBOSE` | `src/engine/apis/lmstudio-native.ts` | Verbose runtime logging. |
| `CLIO_HOOK_BUDGET_DEBUG` | `src/domains/middleware/runtime.ts` | Per-overrun hook-budget diagnostics. |

## 4. Internal plumbing (set by Clio for itself; not operator knobs)

| Env var | Set by | Read at | Purpose |
|---|---|---|---|
| `CLIO_INTERACTIVE` | `src/cli/clio.ts` | orchestrator, context, dispatch, ACP adapter, bash-exec scrub list | Marks the process as the interactive TUI. Scrubbed from bash-tool child env so nested clio invocations do not inherit it. |
| `CLIO_RESUME_SESSION_ID` | restart/resume flow | `src/entry/orchestrator.ts` (consumed then deleted) | Hands the session id across a self-restart. |
| `CLIO_BOOTSTRAP_GENERATE_CHILD` | context bootstrap | `src/domains/context/extension.ts` | Marks the child process that generates CLIO.md so it skips recursion. |

## 5. Test-only

| Env var | Read at | Purpose |
|---|---|---|
| `CLIO_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | `src/engine/ai.ts` | Fake worker model for tests. |
| `CLIO_TEST_UPGRADE_NO_NETWORK` | `src/cli/upgrade.ts` | Skips npm install during upgrade tests. |
| `CLIO_REQUIRE_HOME_PREFIX` | `src/core/init.ts` | Test guardrail: aborts if resolved dirs escape `CLIO_HOME`. |

## 6. CLI flags that bridge through env vars

`clio run --max-context-tokens` and `--kv-cache-mode` (`src/cli/run.ts:143-234`) and the print-mode sampling flags (`src/cli/modes/print.ts:306-333`) do not plumb their values through function arguments. They mutate `process.env` (`CLIO_MAX_CONTEXT_TOKENS`, `CLIO_KV_CACHE_MODE`, `CLIO_SAMPLING_OVERRIDES`), run the command, then restore the previous value in a `finally`. The env var is the transport between the CLI layer and deep engine code.

## 7. Script- and benchmark-only vars (never read by `src/`)

| Env var(s) | Used by |
|---|---|
| `CLIO_LIVE_SMOKE`, `CLIO_LIVE_TARGET`, `CLIO_LIVE_RUNTIME`, `CLIO_LIVE_BASE_URL`, `CLIO_LIVE_MODEL`, `CLIO_LIVE_API_KEY`, `CLIO_LIVE_KEEP` | `scripts/live-smoke.mjs` |
| `CLIO_MAIN_TARGET/_MODEL/_URL/_THINKING`, `CLIO_WORKER_TARGET/_MODEL/_URL/_THINKING`, `CLIO_FLEET_PROFILE`, `CLIO_PRED_MODEL`, `CLIO_LLAMACPP_KEY`, `CLIO_LMSTUDIO_KEY` | benchmark fleet config (`benchmarks/community-benchmarks/`) |
| `CLIO_AUTONOMY`, `CLIO_TASK_TIMEOUT` | terminal-bench agent wrapper (writes settings.yaml / its own timeout; not a Clio knob) |
| `CLIO_BIN`, `CLIO_ENTRY`, `CLIO_TARBALL_URL` | install/dev scripts |
| `CLIO_NO_UPDATE_NOTIFIER` | **Dead.** Set by four benchmark harnesses, read by nothing in `src/`. Either an update notifier was removed and the setters were left behind, or the feature was never built. |

## Findings and consolidation candidates

1. **Naming: `CLIO_MAX_TOOL_CALLS` vs `CLIO_ORCH_MAX_TOOL_CALLS`.** These sound like the same knob but govern different axes (worker lifetime cap vs orchestrator per-turn budget). If touched, rename toward what they bound: `CLIO_WORKER_TOOL_CALL_CAP` and `CLIO_TURN_TOOL_CALL_BUDGET`.
2. **Operator policy living in env instead of settings.** The guard budgets (`CLIO_ORCH_MAX_TOOL_CALLS`, `CLIO_MAX_TOOL_CALLS`), tool byte caps (`CLIO_READ_MAX_BYTES`, `CLIO_OBSERVATION_TURN_BUDGET_BYTES`), and `CLIO_MAX_RUNS` are durable operator policy, the same species as `compaction.threshold` or `budget.sessionCeilingUsd`, which live in `settings.yaml`. Candidates for a `guardrails:` settings section, keeping env as an emergency override at most. Env should be for per-invocation and CI overrides, not for the primary home of policy.
3. **The env-bridge pattern (§6) is the real implementation bloat.** Set-env / run / restore-env in `run.ts` and `print.ts` is process-global mutation standing in for parameter passing, and it is the pattern that multiplies env vars: every new run-scoped option gets a new `CLIO_*` var by default. New run-scoped options should plumb through options objects instead.
4. **Undocumented knobs.** `docs/` mentions roughly half the operator knobs. Undocumented today: both tool-call budgets, `CLIO_MAX_RUNS`, `CLIO_MAX_CONTEXT_TOKENS`, `CLIO_KV_CACHE_MODE`, `CLIO_SAMPLING_OVERRIDES`, `CLIO_RESIDENCY`, all five hook-budget vars, `CLIO_STATUS_STUCK_MS`, `CLIO_SHUTDOWN_HOOK_MS`, `CLIO_SKILL_MARKETPLACE_INDEX`, and every debug toggle. Whatever survives this audit should land in one reference table in `docs/`.
5. **Dead reference.** `CLIO_NO_UPDATE_NOTIFIER` (§7): delete the setters or implement the notifier suppression.
6. **Overlap to check: skills trust.** `CLIO_TRUST_PROJECT_SKILLS` (env) and `skills.trustProjectCompatRoots` (settings) are adjacent trust decisions with different surfaces and different names. They govern different roots today, but one `skills.trust*` settings block with both switches would be easier to reason about.
7. **Healthy as-is.** Directory overrides (§2), debug toggles (§3), internal plumbing (§4), and test-only vars (§5) are all conventional env usage and cheap to keep. The hook-budget family is five vars but one subsystem with sane defaults; fold into settings only if hook tuning becomes routine.
