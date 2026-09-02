# Environment Variables

Every environment variable the shipped `src/` tree reads, grouped by role. Settings.yaml is the durable home for operator policy; env vars exist for per-process overrides (CI, one-off experiments), directory layout, debugging, and internal plumbing. When prose and source disagree, prefer the source; the table cites the read site.

This page is the complete inventory, and the `environment-variable-inventory` check in `scripts/check-hygiene.ts` (run by `npm run lint`) fails if `src/` reads a variable that has no row here.

> [!TIP]
> [docs/html/environment_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/environment_blueprint.html) is a source-checkout walkthrough of the most commonly set variables with an effective-path resolver. It covers a curated subset, so use the tables below when you need the full list.

## Guardrail overrides

Durable values live under `safety.limits` or `fleet.limits` in `settings.yaml`
(see [Configuration and Targets](configuration-and-targets.md)). These
environment variables override them for one process; resolution is environment,
then settings, then the built-in default. Resolution lives in
`src/core/guardrails.ts`.

| Variable | Settings key | Default | Controls |
| --- | --- | --- | --- |
| `CLIO_CODER_TURN_TOOL_CALL_BUDGET` | `safety.limits.chatToolCallsPerTurn` | 60 | Orchestrator per-turn soft tool-call budget; the hard interrupt ceiling sits 15 above it (`src/engine/loop-guard.ts`). |
| `CLIO_CODER_WORKER_TOOL_CALL_CAP` | `fleet.limits.toolCallsPerRun` | 150 | Lifetime ceiling on tool calls one dispatched worker may execute. Calls the harness refused (reserve steering, synthesis-lockout denials) never spend it. Agent recipe budgets may narrow but never widen it (`src/engine/loop-guard.ts`). |
| `CLIO_CODER_MAX_DISPATCH_RUNS` | `fleet.history.maxRuns` | 1000 | Dispatch run-ledger retention cap (`src/domains/dispatch/state.ts`). |
| `CLIO_CODER_READ_MAX_BYTES` | `safety.limits.readBytesPerCall` | 51200 | Per-call byte cap for the read tool, floored at 1024 (`src/tools/read.ts`). |
| `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES` | `safety.limits.observationBytesPerTurn` | 196608 | Shared per-turn byte pool across observation tools (`src/tools/observation.ts`). |
| `CLIO_CODER_INTERNAL_DISPATCH_TIMEOUT_MS` | `fleet.limits.internalRunTimeoutMs` | 900000 | Wall-clock cap for one internal generator dispatch: the wiki documenter and the bootstrap scout (`src/cli/internal-dispatch.ts`). |

## Behavior knobs without a settings key

| Variable | Default | Controls |
| --- | --- | --- |
| `NO_COLOR` | unset | Set to any non-empty value to drop every foreground and background color. Bold, dim, italic, and underline stay, because they are what is left to read the interface by (`src/interactive/theme/tokens.ts`). |
| `CLIO_CODER_SYNTHESIS_LOCK` | strip | How a synthesis-locked worker round is enforced on OpenAI-family runtimes: `strip` removes the tool schemas from the request, `tool-choice` keeps them and sends `tool_choice: none`, which preserves the prompt prefix but relies on the model honoring the knob (`src/engine/provider-payload.ts`). |
| `CLIO_CODER_RIGOR` | repo-derived | Finish-contract evidence bar, `normal` or `high`, layered over the repo-derived default (`src/domains/safety/rigor.ts`). |
| `CLIO_CODER_RESIDENCY` | managed | `observe`, `off`, `0`, `false`, `user`, or `user-managed` stops Clio managing model residency on every local runtime path, llama.cpp routers included; per-target opt-out via `lifecycle: user-managed`. The dispatch transport also exports it to SSH workers as the node's `residency` (`src/engine/apis/residency.ts`, `src/domains/dispatch/transport.ts`). |
| `CLIO_CODER_TRUST_PROJECT_RESOURCES` | settings value | `1` trusts third-party project resource imports for this process when `integrations.projectResources.trustProjectImports` is false; the variable can only enable trust, never revoke a setting that already grants it (`src/domains/resources/skills/loader.ts`). |
| `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` | off | `1` lets full-auto pass through to external CLI runtimes with their own full access (`src/engine/claude/subprocess-runtime.ts`, `src/engine/antigravity/subprocess-runtime.ts`). |
| `CLIO_CODER_FORCE_COMPACT` | off | `1` forces compaction before every interactive turn for as long as it is set (`src/interactive/chat-loop.ts`). |
| `CLIO_CODER_LEGACY_MASK` | off | `1` temporarily restores the destructive stale-observation mask before summary compaction; remove it after compatibility diagnosis. |
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
| `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS` | 86400000 | How long a persisted endpoint slot count answers for an endpoint nothing has probed in this process. A record past the bound is ignored and pruned rather than allowed to over-admit (`src/domains/providers/endpoint-slots-store.ts`). |
| `CLIO_CODER_NO_NETWORK_TOOLS` | off | `1` strips network tools from every registry in the process; the skills-eval harness sets it for hermetic arms; `--allow-network` clears it (`src/tools/network-policy.ts`). |
| `CLIO_CODER_RUN_JOURNAL` | settings value | `1`/`0` overrides `fleet.history.journal` for one process: whether every dispatched run writes its append-only event journal under the state directory (`src/domains/dispatch/run-event-journal.ts`). |
| `CLIO_CODER_SMOOTH_STREAM` | settings value | Per-process override for `interface.smoothStreaming`: `0`/`off`/`false`, `auto`, or `1`/`on`/`true`. A valid value wins over settings; an invalid value fails safely to `off`. |
| `CLIO_CODER_REDUCE_MOTION` | off | `1` makes smooth-streaming `auto` use the immediate coalescer. Explicit `on` remains an operator request, while stdout backpressure still pauses frame production. |
| `CLIO_CODER_SCREEN_READER` | off | `1` makes smooth-streaming `auto` use the immediate coalescer so a screen reader receives the existing low-motion update behavior. |
| `CLIO_CODER_INSTANT_SHELL` | on | `0` disables the single-owner Stage 0 interactive shell for immediate rollback. Unset or `1` mounts one terminal/editor owner before service hydration; ACP, headless, ordinary non-TTY, and subcommand paths never mount it. An explicit `CLIO_CODER_INTERACTIVE=1` keeps its force-interactive non-TTY behavior. |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | 30 | Maximum age in days for terminal rows in the rebuildable SQLite trace mirror. The value is an integer of at least 1 (`src/domains/observability/trace-store.ts`). |
| `CLIO_CODER_TRACE_MAX_BYTES` | 134217728 | Maximum allocated size for the SQLite trace mirror before the oldest terminal runs are pruned. The value is an integer of at least 1,048,576 (`src/domains/observability/trace-store.ts`). |

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
| `CLIO_CODER_TIMING` | Startup timing report, printed only on the bannered non-interactive boot (`src/entry/orchestrator.ts`). |
| `CLIO_CODER_DEBUG_SHUTDOWN` | Shutdown-path diagnostics (`src/core/termination.ts`). |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | Per-overrun hook-budget diagnostics (`src/domains/middleware/runtime.ts`). |

### File-writing traces

These two take a path, not `1`. Setting either to `1` writes a file named `1` in the working directory. Both are off when unset or empty, and both create parent directories.

| Variable | Contents | Controls |
| --- | --- | --- |
| `CLIO_CODER_RENDER_TRACE` | timing only | Versioned JSONL for the full interactive render pipeline, truncated on open so one file is one session. Records event/input sequence ranges, queue and panel high-water marks, explicit frames, grouped stdout commits, write return values, backpressure, and drain—but no conversation text. Output is bounded and asynchronous after the initial pre-TUI file open; trace failure is nonfatal. See [performance-methodology.md](performance-methodology.md) for endpoint definitions (`src/interactive/render-trace.ts`). |
| `CLIO_CODER_MEMORY_TRACE` | conversation text | Proactive task-memory step envelopes, including up to 8000 characters of the text each step saw. This is content-bearing by construction, so the file carries whatever the session carried. Do not enable it on work you would not paste, and do not attach the file to a bug report without reading it first (`src/domains/memory/task-memory-trace.ts`). |

Example:

```bash
CLIO_CODER_RENDER_TRACE=/tmp/clio-render.jsonl clio-coder
```

## Internal plumbing

Set by Clio for its own processes; not operator knobs.

| Variable | Purpose |
| --- | --- |
| `AI_AGENT` | Clio sets this generic child-process attribution marker to `clio-coder` at both shipped entry points and reinforces it for bash tools, fleet workers, registered code steps, and command hooks. Child tooling may read it to identify the agent that launched it (`src/cli/index.ts`, `src/worker/entry.ts`, `src/core/bash-exec.ts`). |
| `CLIO_CODER_GIT_COMMITS_ENABLED` | Carries the effective `integrations.git.commitAttribution` setting to Clio-controlled child-process seams. It is set from validated settings and is not an operator override (`src/core/git-commit-attribution.ts`). |
| `CLIO_CODER_COMMIT_ASSISTED`, `CLIO_CODER_COMMIT_AUTHORED` | Per-spawn inputs to the managed `prepare-commit-msg` hook, which also requires `AI_AGENT=clio-coder` and `CLIO_CODER_GIT_COMMITS_ENABLED=1`; normal external shells never receive this set. Only assistance and authorship cross the environment. Testing, review, and receipt trailers are composed in process by the fleet seam, so a child shell cannot forge them by exporting a variable (`src/core/git-commit-attribution.ts`). |
| `CLIO_CODER_GIT_CONFIG_BASE_COUNT`, `CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT` | Bookkeeping that lets each managed hook wrapper remove only Clio's command-scope `core.hooksPath` pair before chaining the repository's own hook of the same name. Existing `GIT_CONFIG_COUNT` entries remain in force; an explicit `core.hooksPath` is treated as composable only when it resolves exactly to the repository's default hooks directory (`src/core/git-commit-attribution.ts`). |
| `CLIO_CODER_INTERACTIVE` | Marks the interactive TUI process; scrubbed from bash-tool children so nested invocations do not inherit it (`src/cli/clio.ts`, `src/core/bash-exec.ts`). |
| `CLIO_CODER_RUN_OVERRIDES` | JSON envelope for run-scoped CLI options (`--max-context-tokens`, `--kv-cache-mode`, sampling flags). One typed variable instead of one env var per option; worker subprocesses inherit it (`src/core/run-overrides.ts`). |
| `CLIO_CODER_EVAL_RUNNER_STDOUT_FILE` | Set by the eval runner for the `clio-coder run` child it spawns; the child appends its stdout to that path so the runner can read it after exit (`src/domains/eval/suites/run.ts`). |
| `CLIO_CODER_YAZI_PICK_TOKEN` | Per-session token the yazi file-pane integration hands its yazi child and expects back on a pick, so a pick from another session is ignored (`src/domains/mux/yazi/session.ts`, `src/domains/mux/yazi/profile.ts`). |
| `CLIO_CODER_WORKER_LABELS` | Comma-separated labels a dispatched worker reports as its own (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_PGID` | Process-group id the transport assigns a worker so its whole tree can be signalled (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_RUN` | Marks a dispatched worker process; a skill install run inside it is stamped `installed-by: worker` (`src/worker/entry.ts`, `src/domains/resources/skills/install.ts`). |
| `CLIO_CODER_INJECTED_COMPILE_CACHE` | Marks a `NODE_COMPILE_CACHE` value Clio injected into a native worker's environment so its module graph compiles from Clio's V8 compile cache. The worker entry consumes the pair from its own environment immediately after Node reads it, so no worker child of any kind inherits it, and the spawn path never lets the marker travel beside an operator-supplied `NODE_COMPILE_CACHE` (`src/core/compile-cache.ts`, `src/domains/dispatch/worker-spawn.ts`, `src/worker/entry.ts`). |

## Test-only

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | Fake worker model for tests (`src/engine/ai.ts`). |
| `CLIO_CODER_TEST_UPGRADE_NO_NETWORK` | Skips npm install during upgrade tests (`src/cli/upgrade.ts`). |
| `CLIO_CODER_TEST_STAGE1_DELAY_MS`, `CLIO_CODER_TEST_STAGE1_FAIL` | `NODE_ENV=test`-only, bounded instant-shell interleaving and injected hydration failure seams for the built PTY acceptance suite (`src/cli/clio.ts`). |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | Test guardrail: abort if resolved directories escape `CLIO_CODER_HOME` (`src/core/init.ts`). |

Variables used only by external benchmark harnesses or install scripts are not
part of the shipped runtime and should be documented with those harnesses. The
reviewable reference suites under `evals/` use the ordinary eval runner and a
configured `--target <id>` when a model is required.
