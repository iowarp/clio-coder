# Config Knobs Audit (Historical Appendix)

> [!TIP]
> **Interactive Spec Available:** A source-checkout historical knobs auditor and consolidation resolver is available at [docs/html/config_knobs_audit_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/config_knobs_audit_blueprint.html) (Version: 0.2.9).

> [!IMPORTANT]
> This document is a historical record of the point-in-time configuration knob audit conducted on 2026-07-03.
> It details the pre-consolidation state of the codebase before the `v0.2.9` release.
> For the current, active, and authoritative reference of environment variables, please refer to [environment-variables.md](environment-variables.md).

> [!NOTE]
> Pane settings were introduced after this audit and are intentionally absent from its tables. In the current schema, `panes.agents` and `panes.keepFailed` are retired and refused when newly authored; `clio-coder upgrade` removes them from an older settings file before strict validation. See [configuration-and-targets.md](configuration-and-targets.md) for the active pane keys and their migration behavior.

---

Point-in-time inventory of every tunable knob outside `settings.yaml`: environment variables, the compiled-in defaults behind them, and the CLI flags that bridge into them. Gathered 2026-07-03 by sweeping `src/` for `process.env` reads and cross-checking `scripts/`, `benchmarks/`, and `docs/`. Purpose: reason about which knobs earn their keep, which belong in `settings.yaml`, and which are dead.

> **Status: findings 1-5 fixed on 2026-07-03.** Guardrail policy moved into settings, and the transitional guardrail environment overrides were removed on 2026-09-02. The run.ts/print.ts env bridges collapsed into one typed transport (`src/core/run-overrides.ts`, `CLIO_CODER_RUN_OVERRIDES`), retiring `CLIO_CODER_MAX_CONTEXT_TOKENS`, `CLIO_CODER_KV_CACHE_MODE`, and `CLIO_CODER_SAMPLING_OVERRIDES`; the dead `CLIO_CODER_NO_UPDATE_NOTIFIER` setters were deleted; and [environment-variables.md](environment-variables.md) is now the maintained reference. The tables below preserve the pre-fix state.

## The pattern, first

Most knobs come in a pair that looks redundant but is not:

- `DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET = 60` is the compiled-in default constant.
- `CLIO_CODER_ORCH_MAX_TOOL_CALLS` is the env var that overrides it at runtime.

Every runtime-tunable value needs both halves; the pair is one knob, not two. The real bloat questions are different ones: whether a knob should exist at all, whether env is the right surface for it (versus `settings.yaml` or a CLI flag), and whether its name says what it does. Those are called out in the findings at the bottom.

## 1. Operator tuning knobs (read by `src/`) (Pre-consolidated State)

| Env var | Default | Read at | Controls |
|---|---|---|---|
| `CLIO_CODER_ORCH_MAX_TOOL_CALLS` | 60 soft, hard = soft + 15 | `src/engine/loop-guard.ts` → `src/entry/orchestrator.ts` | Orchestrator per-turn tool-call budget. Soft crossing blocks further calls this turn; hard ceiling interrupts the turn. |
| `CLIO_CODER_MAX_TOOL_CALLS` | 50 | `src/engine/loop-guard.ts` → `src/engine/worker-runtime.ts` | Worker lifetime tool-call cap for a dispatched run. Different axis than the orchestrator budget despite the near-identical name. |
| `CLIO_CODER_MAX_DISPATCH_RUNS` | 1000 | `src/domains/dispatch/state.ts` | Dispatch run-ledger retention cap. |
| `CLIO_CODER_MAX_CONTEXT_TOKENS` | unset | `src/domains/providers/runtime-resolution.ts` | Context-window override for local runtimes. Also set internally by `clio-coder run --max-context-tokens` (see §6). |
| `CLIO_CODER_KV_CACHE_MODE` | unset | retired | KV-cache quantization mode. Also set internally by the former `clio-coder run --kv-cache-mode` path. |
| `CLIO_CODER_SAMPLING_OVERRIDES` | unset | `src/engine/apis/sampling-overrides.ts` | JSON sampling-parameter override. Set internally by print-mode sampling flags. |
| `CLIO_CODER_READ_MAX_BYTES` | 51200 (50 KB) | `src/tools/read.ts` | Per-call byte cap for the read tool. |
| `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES` | 196608 (192 KB) | `src/tools/observation.ts` | Shared per-turn byte pool across all observation tools. |
| `CLIO_CODER_RIGOR` | repo-derived | `src/domains/safety/rigor.ts`; read in orchestrator + dispatch | Finish-contract evidence bar (`normal`/`high`), layered over the repo-derived default. |
| `CLIO_CODER_RESIDENCY` | managed | `src/engine/apis/residency.ts` | Set to `observe`/`off` to stop Clio managing model residency on local servers. |
| `CLIO_CODER_HOOK_BUDGET_MS` | per-phase built-ins | `src/domains/middleware/budget.ts` | Global middleware hook wall-clock budget. |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | `src/domains/middleware/budget.ts` | Per-phase override, e.g. `CLIO_CODER_HOOK_BUDGET_TURN_END_MS`. Beats the global var. |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | 1 | `src/domains/middleware/budget.ts` | Hook calls exempted from budget accounting at startup. |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | 5 | `src/domains/middleware/budget.ts` | Sliding-window size for steady-state hook budget warnings. |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | 3 | `src/domains/middleware/budget.ts` | Overruns within the window before a steady-state warning. |
| `CLIO_CODER_STATUS_STUCK_MS` | 180000 | `src/interactive/status/watchdog.ts` | Stuck-turn watchdog threshold. |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | 500 | `src/core/termination.ts` | Wall-clock budget per shutdown hook. |
| `CLIO_CODER_FORCE_COMPACT` | off | `src/interactive/chat-loop.ts` | `1` forces compaction on the next turn regardless of threshold. |
| `CLIO_CODER_TRUST_PROJECT_RESOURCES` | off | `src/domains/resources/skills/loader.ts` | `1` trusts project-local compatibility resources for execution. |
| `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` | off | `src/engine/claude/subprocess-runtime.ts`, `src/engine/antigravity/subprocess-runtime.ts` | `1` lets full-auto pass through to external CLI runtimes with their own full access. |
| `CLIO_CODER_SKILL_CATALOG_DIR` | unset | `src/domains/resources/skills/marketplace.ts`, `provenance-pin.ts` | Local skill-catalog directory override. |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | unset | `src/domains/resources/skills/marketplace.ts` | Marketplace index path override. |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | unset | `src/domains/providers/knowledge-base-path.ts` | Extra model-catalog directories. |

## 2. Directory and install layout (Pre-consolidated State)

| Env var | Default | Read at | Controls |
|---|---|---|---|
| `CLIO_CODER_HOME` | unset | `src/core/xdg.ts` | Single-tree install root; per-role vars below beat it. |
| `CLIO_CODER_CONFIG_DIR` / `CLIO_CODER_DATA_DIR` / `CLIO_CODER_STATE_DIR` / `CLIO_CODER_CACHE_DIR` | XDG platform defaults | `src/core/xdg.ts` | Per-role directory overrides. |
| `CLIO_CODER_BIN_DIR` | `~/.local/bin` | `src/cli/uninstall.ts` | Where the launcher symlink lives. |
| `CLIO_CODER_PACKAGE_ROOT` | auto-detected | `src/core/package-root.ts` | Package root override for bundled-asset resolution. |

## 3. Debug and trace toggles (Pre-consolidated State)

All default off; all enabled with `1`.

| Env var | Read at | Controls |
|---|---|---|
| `CLIO_CODER_BUS_TRACE` | `src/core/bus-trace.ts`, compaction | Event-bus channel tracing to stderr. |
| `CLIO_CODER_TRACE_BOOT` | `src/core/boot-trace.ts` | Boot-phase timing trace. |
| `CLIO_CODER_TIMING` | `src/entry/orchestrator.ts` | Startup timing report to stdout. |
| `CLIO_CODER_DEBUG_SHUTDOWN` | `src/core/domain-loader.ts`, `src/core/termination.ts` | Shutdown-path diagnostics. |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | `src/domains/middleware/runtime.ts` | Per-overrun hook-budget diagnostics. |

## 4. Internal plumbing (Pre-consolidated State)

| Env var | Set by | Read at | Purpose |
|---|---|---|---|
| `CLIO_CODER_INTERACTIVE` | `src/cli/clio.ts` | orchestrator, context, dispatch, ACP adapter, bash-exec scrub list | Marks the process as the interactive TUI. Scrubbed from bash-tool child env so nested clio invocations do not inherit it. |
| `CLIO_CODER_RESUME_SESSION_ID` | restart/resume flow | `src/entry/orchestrator.ts` (consumed then deleted) | Hands the session id across a self-restart. |
| `CLIO_CODER_BOOTSTRAP_GENERATE_CHILD` | context bootstrap | `src/domains/context/extension.ts` | Marks the child process that generates CLIO-CODER.md so it skips recursion. |

## 5. Test-only (Pre-consolidated State)

| Env var | Read at | Purpose |
|---|---|---|
| `CLIO_CODER_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | `src/engine/ai.ts` | Fake worker model for tests. |
| `CLIO_CODER_TEST_UPGRADE_NO_NETWORK` | `src/cli/upgrade.ts` | Skips npm install during upgrade tests. |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | `src/core/init.ts` | Test guardrail: aborts if resolved dirs escape `CLIO_CODER_HOME`. |

## 6. CLI flags that bridge through env vars (Pre-consolidated State)

`clio-coder run --max-context-tokens` and `--kv-cache-mode` (`src/cli/run.ts:143-234`) and the print-mode sampling flags (`src/cli/modes/print.ts:306-333`) do not plumb their values through function arguments. They mutate `process.env` (`CLIO_CODER_MAX_CONTEXT_TOKENS`, `CLIO_CODER_KV_CACHE_MODE`, `CLIO_CODER_SAMPLING_OVERRIDES`), run the command, then restore the previous value in a `finally`. The env var is the transport between the CLI layer and deep engine code.

## 7. Script- and benchmark-only vars (Pre-consolidated State)

| Env var(s) | Used by |
|---|---|
| `CLIO_CODER_MAIN_TARGET/_MODEL/_URL/_RUNTIME/_THINKING`, `CLIO_CODER_WORKER_TARGET/_MODEL/_URL/_RUNTIME/_THINKING`, `CLIO_CODER_LLAMACPP_KEY`, `CLIO_CODER_LMSTUDIO_KEY` | Terminal-Bench installed agent (`benchmarks/community/terminal-bench/`), which renders its own settings.yaml inside the task container |
| `CLIO_CODER_AUTONOMY`, `CLIO_CODER_TASK_TIMEOUT` | terminal-bench agent wrapper (writes settings.yaml / its own timeout; not a Clio knob) |
| `CLIO_CODER_BIN`, `CLIO_CODER_ENTRY`, `CLIO_CODER_TARBALL_URL` | install/dev scripts |
| `CLIO_CODER_NO_UPDATE_NOTIFIER` | **Dead.** Set by four benchmark harnesses, read by nothing in `src/`. Either an update notifier was removed and the setters were left behind, or the feature was never built. |

## Findings and consolidation candidates

1. **Naming: `CLIO_CODER_MAX_TOOL_CALLS` vs `CLIO_CODER_ORCH_MAX_TOOL_CALLS`.** These sounded like the same knob but governed different axes. Both transitional names were later removed in favor of the canonical settings paths.
2. **Operator policy living in env instead of settings.** Guard budgets, tool byte caps, and run retention are durable operator policy. Their canonical version 2 paths now live under `safety.limits` and `fleet`, with no environment precedence layer.
3. **The env-bridge pattern (§6) is the real implementation bloat.** Set-env / run / restore-env in `run.ts` and `print.ts` was collapsed into `CLIO_CODER_RUN_OVERRIDES`.
4. **Undocumented knobs.** Many operator knobs were undocumented in v0.2.7. Whatever survived the audit was consolidated into [environment-variables.md](environment-variables.md).
5. **Dead reference.** `CLIO_CODER_NO_UPDATE_NOTIFIER` (§7) was removed.
6. **Resolved overlap: project resource trust.** `integrations.projectResources.trustProjectImports` is now the only trust-policy surface; the transitional environment override was removed.
7. **Healthy as-is.** Directory overrides (§2), debug toggles (§3), internal plumbing (§4), and test-only vars (§5) are all conventional env usage and cheap to keep. The hook-budget family is five vars but one subsystem with sane defaults; fold into settings only if hook tuning becomes routine.
