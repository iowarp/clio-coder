# Knob Simplification Plan

## Scope and Method

This plan classifies every entry in the version 1 knob registry at the branch baseline. Each row chooses one of four outcomes: keep; delete and hardcode the default; delete and fold into an existing key; or reshape with a migration plan. The classification separates durable operator intent from implementation calibration, research seams, compatibility aliases, task payload, and provenance.

Changes marked `yes` are applied and validated in this branch. Higher-risk schema reductions remain recommendations because they need compatibility windows, telemetry, or broader behavioral evidence.

Operator-facing totals exclude `--help`, `-h`, and `--json` boilerplate, code constants, explicit test seams, and model-knowledge fields whose registry narrative identifies them as provenance-only or unconsumed. Parent-child process contracts remain counted unless they are explicit test seams.

## Count Summary

| Kind | Before | After applied changes | Removed | Operator-facing before | Operator-facing after | Operator-facing removed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Environment Variables | 115 | 103 | 12 | 104 | 92 | 12 |
| Settings | 158 | 158 | 0 | 158 | 158 | 0 |
| CLI Flags | 321 | 310 | 11 | 233 | 222 | 11 |
| Project Files | 60 | 60 | 0 | 60 | 60 | 0 |
| Tool Arguments | 97 | 97 | 0 | 97 | 97 | 0 |
| Recipe Keys | 22 | 22 | 0 | 22 | 22 | 0 |
| Fragment Keys | 4 | 4 | 0 | 4 | 4 | 0 |
| Model Knowledge Tags | 82 | 77 | 5 | 45 | 40 | 5 |
| Constants | 62 | 62 | 0 | 0 | 0 | 0 |
| **Total** | **921** | **893** | **28** | **723** | **695** | **28** |

The branch removes 28 registry entries. The larger recommendations below deliberately remain unapplied until their migration and validation requirements are met.

## Environment Variables

### Recommended Shape

- Typed settings become the only policy surface for guardrails, journal retention, streaming, project-resource trust, and lifecycle ownership.
- Environment variables remain for platform paths, standard terminal and scheduler integration, diagnostics, tests, and parent-child process contracts.
- A later compatibility release should hardcode implementation calibration such as hook budgets, slot TTL, and single-process feature toggles.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `AI_AGENT` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `APPDATA` | keep | ~\AppData\Roaming | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CI` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_BIN_DIR` | keep | ~/.local/bin | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_BUS_TRACE` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_CACHE_DIR` | keep | platform default (`$XDG_CACHE_HOME/clio-coder`, else `~/.cache/clio-coder`) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_COMMIT_ASSISTED` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_COMMIT_AUTHORED` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_CONFIG_DIR` | keep | platform default (`$XDG_CONFIG_HOME/clio-coder`, else `~/.config/clio-coder`) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_DATA_DIR` | keep | platform default (`$XDG_DATA_HOME/clio-coder`, else `~/.local/share/clio-coder`) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_DEBUG_SHUTDOWN` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS` | delete, hardcode default | 24 hours | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_EVAL_RUNNER_STDOUT_FILE` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_FORCE_COMPACT` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_GIT_COMMITS_ENABLED` | keep | unset (in-process reads treat it as enabled; the hook requires exactly `1`) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_GIT_CONFIG_BASE_COUNT` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_HOME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | delete, hardcode default | Use the measured per-phase limits and fixed breaker window | These process-only tuning controls expose implementation calibration without a supported operator workflow. | Medium: maintainers lose emergency tuning without a rebuild | no |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_HOOK_BUDGET_MS` | delete, hardcode default | Use the measured per-phase limits and fixed breaker window | These process-only tuning controls expose implementation calibration without a supported operator workflow. | Medium: maintainers lose emergency tuning without a rebuild | no |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | delete, hardcode default | Use the measured per-phase limits and fixed breaker window | These process-only tuning controls expose implementation calibration without a supported operator workflow. | Medium: maintainers lose emergency tuning without a rebuild | no |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | delete, hardcode default | Use the measured per-phase limits and fixed breaker window | These process-only tuning controls expose implementation calibration without a supported operator workflow. | Medium: maintainers lose emergency tuning without a rebuild | no |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | delete, hardcode default | Use the measured per-phase limits and fixed breaker window | These process-only tuning controls expose implementation calibration without a supported operator workflow. | Medium: maintainers lose emergency tuning without a rebuild | no |
| `CLIO_CODER_INJECTED_COMPILE_CACHE` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_INSTANT_SHELL` | delete, hardcode default | on | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_INTERACTIVE` | keep | unset (Clio sets `1` itself when stdin is a TTY) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_INTERNAL_DISPATCH_TIMEOUT_MS` | delete, fold into fleet.limits.internalRunTimeoutMs | Use fleet.limits.internalRunTimeoutMs; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_LEGACY_MASK` | delete, hardcode default | off | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` | delete, hardcode default | 131072 tokens | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_MAX_DISPATCH_RUNS` | delete, fold into fleet.history.maxRuns | Use fleet.history.maxRuns; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_MAX_RUNS` | delete, fold into fleet.history.maxRuns | Use fleet.history.maxRuns; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_MEMORY_TRACE` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_NO_NETWORK_TOOLS` | keep | off | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES` | delete, fold into safety.limits.observationBytesPerTurn | Use safety.limits.observationBytesPerTurn; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_PACKAGE_ROOT` | keep | auto-detected | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_READ_MAX_BYTES` | delete, fold into safety.limits.readBytesPerCall | Use safety.limits.readBytesPerCall; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_REDUCE_MOTION` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_RENDER_TRACE` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | keep | off | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_RESIDENCY` | delete, fold into targets[].lifecycle and fleet.nodes[].residency | Use targets[].lifecycle and fleet.nodes[].residency; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_RIGOR` | keep | repo-derived | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_RUN_JOURNAL` | delete, fold into fleet.history.journal | Use fleet.history.journal; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_RUN_OVERRIDES` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_SCREEN_READER` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | delete, hardcode default | 500 ms | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_SKILL_CATALOG_DIR` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_SMOOTH_STREAM` | delete, fold into interface.smoothStreaming | Use interface.smoothStreaming; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_STATE_DIR` | keep | platform default (`$XDG_STATE_HOME/clio-coder`, else `~/.local/state/clio-coder`) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_STATUS_STUCK_MS` | delete, hardcode default | 180000 ms | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_SYNTHESIS_LOCK` | delete, hardcode default | strip | This is a one-process implementation toggle or timeout with no durable configuration model. | Medium: undocumented troubleshooting workflows may rely on the override | no |
| `CLIO_CODER_TEST_STAGE1_DELAY_MS` | keep | 0 | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_TEST_STAGE1_FAIL` | keep | off | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_TEST_UPGRADE_NO_NETWORK` | keep | off | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_TIMING` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_TRACE_BOOT` | keep | off | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_TRACE_MAX_BYTES` | keep | 134217728 | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | keep | 30 | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_TRUST_PROJECT_RESOURCES` | delete, fold into integrations.projectResources.trustProjectImports | Use integrations.projectResources.trustProjectImports; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_TRUST_PROJECT_SKILLS` | delete, fold into integrations.projectResources.trustProjectImports | Use integrations.projectResources.trustProjectImports; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_TURN_TOOL_CALL_BUDGET` | delete, fold into safety.limits.chatToolCallsPerTurn | Use safety.limits.chatToolCallsPerTurn; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_WORKER_FAUX` | keep | off | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_WORKER_FAUX_ERROR_MESSAGE` | keep | unset | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_WORKER_FAUX_MODEL` | keep | faux-model | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_WORKER_FAUX_STOP_REASON` | keep | stop | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_WORKER_FAUX_TEXT` | keep | ok | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `CLIO_CODER_WORKER_LABELS` | keep | unset (no labels) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_WORKER_PGID` | keep | worker's own pid (null on Windows) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_WORKER_RUN` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `CLIO_CODER_WORKER_TOOL_CALL_CAP` | delete, fold into fleet.limits.toolCallsPerRun | Use fleet.limits.toolCallsPerRun; its existing default remains authoritative | The environment surface duplicates a typed setting and creates two precedence paths for one policy. | Low: the canonical setting already exists; environment-only deployments must migrate | yes |
| `CLIO_CODER_YAZI_PICK_TOKEN` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `COLORTERM` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `COLUMNS` | keep | 80 | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `EDITOR` | keep | first of `nano`, `vi` on PATH | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `GIT_CONFIG_COUNT` | keep | unset (treated as 0) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `HERDR_ENV` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `HERDR_SESSION` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `HERDR_SOCKET_PATH` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `HOME` | keep | unset (os.homedir() where a fallback exists) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `LOCALAPPDATA` | keep | ~\AppData\Local | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `LOGNAME` | keep | unknown | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `LSB_JOBID` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `LSB_JOBNAME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `LSF_CLUSTER_NAME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `NO_COLOR` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `NODE_COMPILE_CACHE` | keep | unset (Clio uses `<cache>/v8-compile-cache` once the cache root exists) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `NODE_DISABLE_COMPILE_CACHE` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `NODE_ENV` | keep | unset | Keep as an explicit test or harness seam; it is excluded from operator-facing totals. | Low: no migration | no |
| `NODE_OPTIONS` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `OLLAMA_NUM_PARALLEL` | keep | 1 | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `PATH` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `PBS_JOBID` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `PBS_JOBNAME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `PBS_O_HOST` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SHELL` | keep | /bin/sh | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SLURM_CLUSTER_NAME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SLURM_JOB_ID` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SLURM_JOB_NAME` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SSH_CONNECTION` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `SSH_TTY` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `STY` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `TERM` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `TERM_PROGRAM` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `TMUX` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `TZ` | keep | unset (system zone) | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `USER` | keep | unknown | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `VISUAL` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `WT_SESSION` | keep | unset | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `XDG_CACHE_HOME` | keep | ~/.cache | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `XDG_CONFIG_HOME` | keep | ~/.config | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `XDG_DATA_HOME` | keep | ~/.local/share | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |
| `XDG_STATE_HOME` | keep | ~/.local/state | Keep because it represents process environment, platform integration, diagnostics, or child-process plumbing rather than duplicate product policy. | Low: no migration | no |

## Settings

### Recommended Shape

- Keep settings that express durable user intent, integration contracts, target capabilities, safety posture, and named fleet topology.
- Reduce retry, memory, working-set, and pane tuning to one intent selector or preset per family.
- Remove adaptive-routing configuration only with a versioned migration and a demonstrated replacement router.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `chat.maxOutputTokens` | keep | 32768 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.model` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.modelPicker.cycleSet` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.modelPicker.favorites` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.modelPicker.recentLimit` | keep | 12 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.prewarm` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.retry.baseDelayMs` | delete, hardcode default | 2000 | Keep retry as an on or off policy and own the backoff calibration in code. | Medium: installations with provider-specific retry tuning must migrate | no |
| `chat.retry.enabled` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.retry.maxDelayMs` | delete, hardcode default | 60000 | Keep retry as an on or off policy and own the backoff calibration in code. | Medium: installations with provider-specific retry tuning must migrate | no |
| `chat.retry.maxRetries` | delete, hardcode default | 3 | Keep retry as an on or off policy and own the backoff calibration in code. | Medium: installations with provider-specific retry tuning must migrate | no |
| `chat.retry.streamStallMs` | delete, hardcode default | 180000 | Keep retry as an on or off policy and own the backoff calibration in code. | Medium: installations with provider-specific retry tuning must migrate | no |
| `chat.target` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `chat.thinkingLevel` | keep | off | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.compaction.auto` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.compaction.model` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.compaction.systemPrompt` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.compaction.threshold` | keep | 0.8 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.memory.cadenceToolCalls` | delete, hardcode default | 10 | The intervention cadence and bounds are implementation calibration, not distinct user intent. | Medium: experimental memory schedules lose direct configuration | no |
| `context.memory.enabled` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.memory.maxOutputTokens` | delete, hardcode default | 2000 | The intervention cadence and bounds are implementation calibration, not distinct user intent. | Medium: experimental memory schedules lose direct configuration | no |
| `context.memory.model` | delete, fold into context.memory.target | Use the selected target's default model | A separate model selector creates an unnecessary partial target override. | Medium: users pinning a model on a shared target must create a dedicated target | no |
| `context.memory.target` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.memory.timeoutMs` | delete, hardcode default | 60000 | The intervention cadence and bounds are implementation calibration, not distinct user intent. | Medium: experimental memory schedules lose direct configuration | no |
| `context.memory.trajectorySteps` | delete, hardcode default | 8 | The intervention cadence and bounds are implementation calibration, not distinct user intent. | Medium: experimental memory schedules lose direct configuration | no |
| `context.workingSet.enabled` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `context.workingSet.minEvictableTokens` | delete, hardcode default | 200 | Expose whether working-set management runs, not its low-level eviction calibration. | High: context quality may depend on repository-specific tuning | no |
| `context.workingSet.policy` | delete, hardcode default | structural-v1 | Expose whether working-set management runs, not its low-level eviction calibration. | High: context quality may depend on repository-specific tuning | no |
| `context.workingSet.protectLastTurns` | delete, hardcode default | 6 | Expose whether working-set management runs, not its low-level eviction calibration. | High: context quality may depend on repository-specific tuning | no |
| `context.workingSet.target` | delete, hardcode default | 0.6 | Expose whether working-set management runs, not its low-level eviction calibration. | High: context quality may depend on repository-specific tuning | no |
| `fleet.adaptiveRouting.agentRoles` | reshape | Remove public adaptive-routing configuration until a demonstrated automatic router ships | The repository does not activate this surface, while the nested role and posture schema multiplies policy choices. | High: active external configurations and routing experiments may depend on it | no |
| `fleet.adaptiveRouting.agentRoles[].agentId` | reshape | Remove public adaptive-routing configuration until a demonstrated automatic router ships | The repository does not activate this surface, while the nested role and posture schema multiplies policy choices. | High: active external configurations and routing experiments may depend on it | no |
| `fleet.adaptiveRouting.agentRoles[].executionRole` | reshape | Remove public adaptive-routing configuration until a demonstrated automatic router ships | The repository does not activate this surface, while the nested role and posture schema multiplies policy choices. | High: active external configurations and routing experiments may depend on it | no |
| `fleet.adaptiveRouting.postures` | reshape | Remove public adaptive-routing configuration until a demonstrated automatic router ships | The repository does not activate this surface, while the nested role and posture schema multiplies policy choices. | High: active external configurations and routing experiments may depend on it | no |
| `fleet.adaptiveRouting.roles` | reshape | Remove public adaptive-routing configuration until a demonstrated automatic router ships | The repository does not activate this surface, while the nested role and posture schema multiplies policy choices. | High: active external configurations and routing experiments may depend on it | no |
| `fleet.agentProfiles` | keep | {} | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.agentProfiles.<key>` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.concurrency` | keep | auto | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.default.model` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.default.target` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.default.thinkingLevel` | keep | off | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.history.journal` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.history.maxRuns` | keep | 1000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.limits.internalRunTimeoutMs` | keep | 900000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.limits.toolCallsPerRun` | keep | 150 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].clioCoderEntry` | keep | clio-coder worker | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].host` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].id` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].identityFile` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].labels` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].maxWorkers` | keep | 2 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].port` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].residency` | keep | observe | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.nodes[].user` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.permissions.escalation.fallback` | keep | deny | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.permissions.escalation.timeoutMs` | keep | 120000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.permissions.mode` | keep | deny | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.profiles` | keep | {} | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.profiles.<key>.model` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.profiles.<key>.node` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.profiles.<key>.target` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.profiles.<key>.thinkingLevel` | keep | off | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.retry.maxRetries` | keep | 2 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.retry.routeCooldownMs` | keep | 15000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters` | keep | {} | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters.<key>.members[].color` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters.<key>.members[].label` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters.<key>.members[].model` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters.<key>.members[].target` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `fleet.rosters.<key>.members[].thinkingLevel` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.defaults.connectTimeoutMs` | keep | 30000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | keep | 120000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.defaults.toolGovernance` | keep | clio-coder-policy | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.defaults.turnTimeoutMs` | keep | 300000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].args` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].command` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].connectTimeoutMs` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].cwd` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].env.<key>` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].id` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].labels.<key>` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].permissionTimeoutMs` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].projectContext` | keep | none | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].stallTimeoutMs` | keep | 300000 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].toolGovernance` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.externalAgents.entries[].turnTimeoutMs` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.git.commitAttribution` | keep | true | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.library.catalog` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.library.confirmedRemote` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.library.remote` | keep | null | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.library.sync` | keep | false | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.projectResources.trustProjectImports` | keep | false | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `integrations.runtimePlugins` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.desktopNotifications` | keep | false | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.fullscreenScrollbar` | keep | auto | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.keybindings` | keep | {} | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.keybindings.<key>` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.mode` | keep | regular | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.outputDetail` | keep | default | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.panes.enabled` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.files.enabled` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.files.followCwd` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.files.mode` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.files.profile` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.files.ratio` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.layout` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.notifications` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.panes.workers.ratio` | reshape | One interface.panes.layout preset with off as the default | A preset can derive enablement, companion mode, profile, ratios, following, and notification behavior. | High: existing pane layouts need a versioned settings migration | no |
| `interface.smoothStreaming` | keep | off | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `interface.terminalProgress` | keep | false | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.autonomy` | keep | auto-edit | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.limits.chatToolCallsPerTurn` | keep | 60 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.limits.observationBytesPerTurn` | keep | 196608 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.limits.readBytesPerCall` | keep | 51200 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.limits.sessionCostUsd` | keep | 5 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.review.cadenceToolCalls` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.review.enabled` | keep | false | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `safety.review.target` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets` | keep | [] | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].auth.apiKeyEnvVar` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].auth.apiKeyRef` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].auth.headers.<key>` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].auth.oauthProfile` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.audio` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.chat` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.contextWindow` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.embeddings` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.fim` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.maxTokens` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.reasoning` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.rerank` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.structuredOutputs` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.thinkingFormat` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.toolCallFormat` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.tools` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].capabilities.vision` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].defaultModel` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].gateway` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].id` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lifecycle` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.load.contextLength` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.load.evalBatchSize` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.load.flashAttention` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.load.numExperts` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.load.offloadKvCacheToGpu` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.request.draftModel` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.request.reasoning` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].lmstudio.request.ttlSeconds` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].maxConcurrentRequests` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].pricing.cacheRead` | keep | 0 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].pricing.cacheWrite` | keep | 0 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].pricing.input` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].pricing.output` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].runtime` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].url` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `targets[].wireModels` | keep | current shape | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |
| `version` | keep | 2 | Keep as durable typed configuration with a distinct operator intent or integration contract. | Low: no migration | no |

## CLI Flags

### Recommended Shape

- Remove deprecated spellings now and preserve one canonical flag for each action.
- Move research and maintainer workflows out of the installed operator command tree after publishing script replacements.
- Prefer named profiles and canonical settings over per-run sampler, runtime, and layout tuning.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `acp --acp` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `acp --cwd` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `acp --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `acp --permission-timeout` | keep | 120000 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `acp -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `agents --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `agents --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `agents --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `agents -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `auth --api-key` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `auth --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `auth -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `components --from` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `components --help` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `components --json` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `components --out` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `components --to` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `components -h` | reshape | Move components workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `config --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `config --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `config -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --agent-profile` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --agent-profile-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --api-key` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --api-key-env` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --background-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --context-window` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --fleet-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --gateway` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --id` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --interop` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --lifecycle` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --list` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --max-tokens` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --orchestrator-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --reasoning` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --remove` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --rename` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --runtime` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --set-background` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --set-fleet-default` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --set-orchestrator` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --set-worker-default` | delete, fold into --set-fleet-default | Use --set-fleet-default | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `configure --url` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `configure --worker-model` | delete, fold into --fleet-model | Use --fleet-model | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `configure --worker-profile` | delete, fold into --agent-profile | Use --agent-profile | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `configure --worker-profile-model` | delete, fold into --agent-profile-model | Use --agent-profile-model | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `configure -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --budgets` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --depth` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --md` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --min-evictable-tokens` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --model` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --no-filter` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --policies` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --protect-last-turns` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --seed` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --session` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --sessions` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --status` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --synthetic` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --target` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --thinking` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --threshold` | reshape | Move replay-only semantics to a developer replay script; retain shared wiki selection where needed | Research replay controls currently share a public command with context inspection and wiki generation. | High: evaluation scripts and wiki callers share some spellings | no |
| `context --update` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --wiki` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context --yes` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `context -y` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `docs --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `docs --no-open` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `docs -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `doctor --fix` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `doctor --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `doctor --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `doctor -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `eval --allow-config-drift` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --baseline` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --clio-coder-entry` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --clio-entry` | delete, fold into --clio-coder-entry | Use --clio-coder-entry | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `eval --format` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --help` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --json` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --metric` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --model` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --out` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --repeat` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --suite` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --target` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --task-file` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --thresholds` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval --trials` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `eval -h` | reshape | Move eval workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence --eval` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence --help` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence --json` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence --run` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence --session` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evidence -h` | reshape | Move evidence workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evolve --help` | reshape | Move evolve workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `evolve -h` | reshape | Move evolve workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `extensions --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions --project` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions --user` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `extensions -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --cache-dir` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --config-dir` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --data-dir` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --follow` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --from` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --resume` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --state-dir` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --var` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet --watch` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `fleet -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --acp` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --api-key` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --continue` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --no-context-files` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --no-panes` | delete, fold into interface.panes.layout | Use the pane layout setting | Opposing startup flags duplicate the persistent interface policy and complicate precedence. | Medium: one-shot pane workflows need a replacement | no |
| `global --no-skills` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --resume` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --skill` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --version` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global --with-panes` | delete, fold into interface.panes.layout | Use the pane layout setting | Opposing startup flags duplicate the persistent interface policy and complicate precedence. | Medium: one-shot pane workflows need a replacement | no |
| `global -c` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global -nc` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global -r` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `global -v` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --thinking` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init --yes` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `init -y` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `interop --help` | reshape | Move interop workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `interop --json` | reshape | Move interop workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `interop -h` | reshape | Move interop workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --from` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --help` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --json` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --kind` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --with-requirements` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library --yes` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `library -h` | reshape | Move library workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --acknowledge-global` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --agent` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --entry` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --from-evidence` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --from-handoff` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --help` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --repository` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --runtime` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --scope` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory --stale` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `memory -h` | reshape | Move memory workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `models --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `models --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `models --offline` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `models --target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `models -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `panes --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `panes -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `paths --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `paths --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `paths -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --auth` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --cache` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --config` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --data` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --dry-run` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset --state` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `reset -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --agent` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --agent-profile` | reshape | Select one named agent profile; keep target and model as the explicit escape hatch | Overlapping worker, runtime, requirement, and tool-profile selectors create partial profiles. | High: scripts require a staged alias and settings migration | no |
| `run --agent-runtime` | reshape | Select one named agent profile; keep target and model as the explicit escape hatch | Overlapping worker, runtime, requirement, and tool-profile selectors create partial profiles. | High: scripts require a staged alias and settings migration | no |
| `run --autonomy` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --continue` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --frequency-penalty` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --json-events` | delete, fold into --json | Use --json for the stable event stream | Two JSON output selectors expose format detail that the command can own. | Medium: stream consumers must change their invocation | no |
| `run --kv-cache-mode` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --max-context-tokens` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --min-p` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --no-skills` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --presence-penalty` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --repeat-penalty` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --require` | reshape | Select one named agent profile; keep target and model as the explicit escape hatch | Overlapping worker, runtime, requirement, and tool-profile selectors create partial profiles. | High: scripts require a staged alias and settings migration | no |
| `run --runtime` | delete, fold into --agent-runtime | Use --agent-runtime | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `run --session` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --skill` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --steer-channel` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --temperature` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --thinking` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `run --tool-profile` | reshape | Select one named agent profile; keep target and model as the explicit escape hatch | Overlapping worker, runtime, requirement, and tool-profile selectors create partial profiles. | High: scripts require a staged alias and settings migration | no |
| `run --top-k` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --top-p` | delete, hardcode default | Resolve sampling from model knowledge and target defaults | Per-run sampler internals bypass the canonical target and model calibration path. | High: advanced users may rely on one-shot sampling overrides | no |
| `run --worker` | delete, fold into --agent-profile | Use --agent-profile | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `run --worker-profile` | delete, fold into --agent-profile | Use --agent-profile | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `run --worker-runtime` | delete, fold into --agent-runtime | Use --agent-runtime | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `run -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --agents` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --both` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --context` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --dry-run` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --extensions` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --fleets` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --out` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --project` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --prompts` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --settings` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --skills` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share --user` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `share -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --allow-network` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --category` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --name` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --project` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --scenario` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --timeout` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --trust-fixtures` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --user` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills --workspace` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `skills -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --background-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --fleet-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --fleet-target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --orchestrator-model` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --probe` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --runtime` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --target` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --thinking` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `targets --worker-model` | delete, fold into --fleet-model | Use --fleet-model | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `targets --worker-target` | delete, fold into --fleet-target | Use --fleet-target | The compatibility spelling duplicates an existing command path and already emits a deprecation warning. | Low: documented replacement exists; old automation must migrate | yes |
| `targets -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools --all` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools --reset-profile` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `tools -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --db` | keep | <state>/trace.sqlite | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --follow` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --limit` | keep | 50 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --max-age-days` | keep | 30 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --max-bytes` | keep | 134217728 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace --port` | keep | 0 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `trace -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall --dry-run` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall --force` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall --remove-binary` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall -f` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `uninstall -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade --channel` | keep | latest | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade --dry-run` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade --post-install` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade --skip-migrations` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `upgrade -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `usage --days` | reshape | Move usage workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `usage --help` | reshape | Move usage workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `usage --json` | reshape | Move usage workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `usage --repo` | reshape | Move usage workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `usage -h` | reshape | Move usage workflows to versioned developer scripts or evaluation packages | This command serves maintainers and research pipelines rather than the core operator journey. | High: automation needs a published replacement entry point | no |
| `verifiers --command` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --cwd` | keep | . | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --description` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --dry-run` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --exclude` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --help` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --id` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --json` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --rename` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --tags` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --timeout-ms` | keep | 120000 | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers --yes` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |
| `verifiers -h` | keep | current shape | Keep as a discoverable command action, selection, output mode, or administrative control. | Low: no migration | no |

## Project Files

### Recommended Shape

- Keep project files focused on durable repository context, safety, hooks, agents, fleets, and validation.
- Remove accepted but ignored legacy keys after validation communicates the migration.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `.clio-coder/agents (recipe files)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/fleets steps[]` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/fleets version` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.local.yaml (same keys as hooks.yaml)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[]` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].argv` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].as` | keep | annotate | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].cwd` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].effect` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].enabled` | keep | true | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].id` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].kind` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].message` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].on` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].severity` | keep | info | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].timeoutMs` | keep | 2000 | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/hooks.yaml hooks[].tools` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/profile.yaml commitMessageStyle` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/profile.yaml localOnlyPaths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/profile.yaml responsePosture` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/profile.yaml validationPreference` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/prompts (prompt templates)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/rules description` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/rules enabled` | keep | true | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/rules excludes` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/rules paths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[]` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].actionClass` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].command` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].comment` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].cwd` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].env` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].env.allow` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].env.mode` | keep | none | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].id` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].maxOutputBytes` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].owner` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].rationale` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].requireConfirmation` | keep | false | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].shellOperators` | keep | deny | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml commands[].timeoutMs` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml disableDefaultPathPolicy` | keep | false | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml noDeletePaths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml noWritePaths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml readOnlyPaths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml tasks` | delete, hardcode default | Ignore no legacy task-policy key; reject it after a migration window | The parser accepts this legacy key but runtime behavior does not consume it. | Medium: strict rejection changes validation for old repositories | no |
| `.clio-coder/safety.yaml version` | keep | 1 | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/safety.yaml zeroAccessPaths` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/settings.local.yaml (layered subset of settings.yaml)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/settings.yaml (layered subset of settings.yaml)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/skills (skill directories)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/validation.yaml (presence)` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[]` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].command` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].cwd` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].description` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].id` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].tags` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml checks[].timeoutMs` | keep | current shape | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |
| `.clio-coder/verifiers.yaml version` | keep | 1 | Keep as repository-owned policy, context, automation, or validation data with a distinct file contract. | Low: no migration | no |

## Tool Arguments

### Recommended Shape

- Keep task payload fields and the minimum per-call policy needed for agent role, mode, intent, output policy, context scope, and verification selection.
- Move scheduler, routing, resource, review, and timeout policy to settings, recipes, or agent profiles.
- Treat any tool-schema reduction as a versioned contract migration across prompts, parsing, receipts, and tests.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `bash.command` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `bash.cwd` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `bash.output_policy` | keep | bounded | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `bash.timeout_ms` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `context.include_tree` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `context.limit` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `context.name` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `context.query` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `context.ref` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `context.scope` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.$defs.budget` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.budget.readReserve` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.budget.retryRevision` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.budget.retryRevision.readReserve` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.budget.retryRevision.toolCalls` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.budget.toolCalls` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.$defs.intent` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.$defs.intent.expected_outputs` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.$defs.intent.read_roots` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.$defs.intent.relevant_paths` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.$defs.intent.verification` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.$defs.intent.verification[].check` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.$defs.intent.verification[].timeout_ms` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.$defs.intent.write_roots` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.agent` | keep | coder | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.apply` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.apply_winner` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.apply_winner.branch` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.apply_winner.cwd` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.briefing` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.budget` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.candidates` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.cwd` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.detach` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.from_scout` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.from_scout.receipt_digest` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.from_scout.run_id` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.gate` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.intent` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.judge` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.judge.agent` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.judge.model` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.judge.node` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.judge.target` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.list` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.max_output_bytes` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.members` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.members[].label` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.members[].model` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.members[].target` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.members[].thinking` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.mode` | keep | parallel | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.model` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.node` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.persona` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.review` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.review.max_cycles` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.review.model` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.review.node` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.review.reviewer` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.review.target` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.roster` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.rounds` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.deadlineMs` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.failover` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.locality` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.maxCostUsd` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.minimumQuality` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.posture` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.routing.requiredCapabilities` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.synthesis` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.target` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.task` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.tasks` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.tasks[].agent` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.tasks[].briefing` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.tasks[].budget` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tasks[].gate` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tasks[].intent` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `dispatch.tasks[].model` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tasks[].node` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tasks[].target` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tasks[].task` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `dispatch.tasks[].worktree` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.thinking_level` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.timeout_ms` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.tool_profile` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.worktree` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `dispatch.writers` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `verify.args` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `verify.browser` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `verify.check` | keep | current shape | Keep as the smallest demonstrated per-call policy needed to express intent, execution mode, agent role, or output form. | Low: no migration | no |
| `verify.cwd` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `verify.max_output_bytes` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |
| `verify.path` | keep | current shape | Keep because it carries task payload, evidence, paths, or expected outputs rather than tuning policy. | Low: no migration | no |
| `verify.timeout_ms` | reshape | Move stable policy to settings or recipes; derive execution bounds from intent and agent profile | This model-facing argument asks the model to tune scheduler, routing, resource, or review internals on each call. | High: tool-schema changes require prompt, parser, receipt, and compatibility updates | no |

## Recipe Keys

### Recommended Shape

- Keep the complete recipe contract because these keys describe reusable task intent, capabilities, budgets, tools, skills, and result shape.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `audience` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.maximum` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.maximum.readReserve` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.maximum.toolCalls` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.readReserve` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.synthesis` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `budget.toolCalls` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `capabilityClass` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `category` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `description` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `latencyClass` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `name` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `product` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `projectContextTier` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `resultContract` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `resultContract.kind` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `resultContract.path` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `skills` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `tags` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `tools` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |
| `version` | keep | current shape | Keep because recipes are authored task contracts and each key contributes selection, budget, capability, or result semantics. | Low: no migration | no |

## Fragment Keys

### Recommended Shape

- Keep the four-key fragment contract as the minimum needed for identity, compatibility, documentation, and dynamic rendering.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `description` | keep | current shape | Keep because fragment identity, versioning, description, and dynamic behavior form the minimal fragment contract. | Low: no migration | no |
| `dynamic` | keep | current shape | Keep because fragment identity, versioning, description, and dynamic behavior form the minimal fragment contract. | Low: no migration | no |
| `id` | keep | current shape | Keep because fragment identity, versioning, description, and dynamic behavior form the minimal fragment contract. | Low: no migration | no |
| `version` | keep | current shape | Keep because fragment identity, versioning, description, and dynamic behavior form the minimal fragment contract. | Low: no migration | no |

## Model Knowledge Tags

### Recommended Shape

- Keep runtime behavior and auditable measurement provenance distinct from operator-facing configuration.
- Drop extracted fields that have no consumer so model knowledge cannot imply an effect that runtime does not implement.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `capabilities` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.audio` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.chat` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.contextWindow` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.embeddings` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.fim` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.maxTokens` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.reasoning` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.rerank` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.structuredOutputs` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.thinkingFormat` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.toolCallFormat` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.tools` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `capabilities.vision` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `family` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `matchPatterns` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.chatTemplate` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.gpuTiers` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.gpuTiers.<gpuTiers>` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.kvCache` | delete, hardcode default | Drop during model-knowledge extraction | The extractor accepts this tag but no runtime path consumes the extracted value. | Low: behavior is unchanged; source knowledge files may retain provenance text outside the runtime schema | yes |
| `quirks.kvCache.kQuant` | delete, hardcode default | Drop during model-knowledge extraction | The extractor accepts this tag but no runtime path consumes the extracted value. | Low: behavior is unchanged; source knowledge files may retain provenance text outside the runtime schema | yes |
| `quirks.kvCache.vQuant` | delete, hardcode default | Drop during model-knowledge extraction | The extractor accepts this tag but no runtime path consumes the extracted value. | Low: behavior is unchanged; source knowledge files may retain provenance text outside the runtime schema | yes |
| `quirks.leakageNote` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.batchSize` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.cacheTypeK` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.cacheTypeV` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.chatTemplateKwargs` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.chatTemplateKwargs.<chatTemplateKwargs>` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.ctxSize` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.flashAttn` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.mmproj` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.nGpuLayers` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.parallel` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.parallelSlots` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.reasoning` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.reasoningEffort` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.specDraftNMax` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.specType` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.llamaCpp.ubatchSize` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.alsoMeasuredOn` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.build` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.date` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.hardware` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.llamaCpp` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.model` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.note` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.runtime` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.measuredUnder.source` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.runtimePreference` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.runtimePreference.<runtimePreference>` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.maxTokens` | delete, hardcode default | Drop during model-knowledge extraction | The extractor accepts this tag but no runtime path consumes the extracted value. | Low: behavior is unchanged; source knowledge files may retain provenance text outside the runtime schema | yes |
| `quirks.sampling.instruct.minP` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.presencePenalty` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.repeatPenalty` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.repetitionPenalty` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.temperature` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.topK` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.instruct.topP` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.gracePeriod` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.maxTokens` | delete, hardcode default | Drop during model-knowledge extraction | The extractor accepts this tag but no runtime path consumes the extracted value. | Low: behavior is unchanged; source knowledge files may retain provenance text outside the runtime schema | yes |
| `quirks.sampling.thinking.minP` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.presencePenalty` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.reasoningBudget` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.repetitionPenalty` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.temperature` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.topK` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.sampling.thinking.topP` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.serving` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.budgetByLevel` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.budgetByLevel.<budgetByLevel>` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.effortByLevel` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.effortByLevel.<effortByLevel>` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.guidance` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinking.mechanism` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |
| `quirks.thinkingControl` | keep | current shape | Keep as runtime model behavior, serving calibration, capability data, matching metadata, or auditable measurement provenance. | Low: no migration | no |

## Constants

### Recommended Shape

- Keep constants as code-owned invariants and safety bounds, not operator-facing knobs.
- Promote a constant to settings only when operators have a demonstrated, durable reason to vary it.

### Decisions

| Knob | Decision | Default or new shape | Reasoning | Risk | Applied |
| --- | --- | --- | --- | --- | --- |
| `src/core/context-floor.ts CLIO_CONTEXT_WINDOW_WARN_BELOW` | keep | 128000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/core/context-floor.ts CLIO_MIN_CONTEXT_WINDOW` | keep | 131072 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/core/context-floor.ts CLIO_MIN_MAX_OUTPUT_TOKENS` | keep | 32768 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/fleet-contract.ts FLEET_LOOP_MAX_ATTEMPTS` | keep | 5 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/result-contract.ts COUNCIL_BALLOT_VERDICT_MAX_BYTES` | keep | 64 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/result-contract.ts MUTATION_WRITE_SET_REASON_LIMIT` | keep | 8 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/result-contract.ts RESULT_COMMIT_MESSAGE_MAX_BYTES` | keep | 1000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/result-contract.ts RESULT_CONTRACT_ANCHOR_LIMIT` | keep | 12 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/agents/result-contract.ts RESULT_CONTRACT_REPAIR_LIMIT` | keep | 2 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/context/bootstrap-prompt.ts BOOTSTRAP_INPUT_MAX_CHARS` | keep | 48000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/context/bootstrap-prompt.ts BOOTSTRAP_SIBLING_CONTENT_MAX_CHARS` | keep | 12000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/context/bootstrap-prompt.ts BOOTSTRAP_SIBLING_MAX_FILES` | keep | 12 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/context/operator-profile.ts OPERATOR_PROFILE_MAX_CHARS` | keep | 700 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/context/operator-profile.ts OPERATOR_PROFILE_MAX_LOCAL_PATHS` | keep | 8 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/delegation-plan.ts DELEGATION_PROPOSAL_BRIEFING_MAX_BYTES` | keep | 12000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/gate-role-prompts.ts COUNCIL_MAX_MEMBERS` | keep | 5 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/gate-role-prompts.ts COUNCIL_MIN_MEMBERS` | keep | 2 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/intent.ts DISPATCH_INTENT_PATH_ENTRY_BYTES_CAP` | keep | 512 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/intent.ts DISPATCH_INTENT_TIMEOUT_MIN_MS` | keep | 1000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/intent.ts DISPATCH_INTENT_VERIFICATION_CAP` | keep | 8 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/validation.ts DISPATCH_BRIEFING_MAX_BYTES` | keep | 12000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/dispatch/validation.ts INTERNAL_DISPATCH_BRIEFING_MAX_BYTES` | keep | 65536 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/memory/task-bank.ts TASK_MEMORY_CONTENT_MAX_CHARS` | keep | 1200 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/memory/task-bank.ts TASK_MEMORY_DEFAULT_KNOWLEDGE_CAP` | keep | 20 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/memory/task-bank.ts TASK_MEMORY_DEFAULT_PROCEDURAL_CAP` | keep | 30 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/budget.ts DEFAULT_HOOK_BUDGET_THRESHOLD` | keep | 3 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/budget.ts DEFAULT_HOOK_BUDGET_WARMUP_CALLS` | keep | 1 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/budget.ts DEFAULT_HOOK_BUDGET_WINDOW` | keep | 5 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/hooks.ts USER_HOOK_COMMAND_OUTPUT_MAX_CHARS` | keep | 4000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/hooks.ts USER_HOOK_COMMAND_TIMEOUT_DEFAULT_MS` | keep | 2000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/hooks.ts USER_HOOK_COMMAND_TIMEOUT_MAX_MS` | keep | 5000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/hooks.ts USER_HOOK_COMMAND_TIMEOUT_MIN_MS` | keep | 100 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/hooks.ts USER_HOOK_PROMPT_MAX_CHARS` | keep | 2000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts CALL_DESCRIPTION_MAX_CHARS` | keep | 180 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts MEMORY_INTERVENTION_ACTIVITY_LIMIT` | keep | 20 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts MEMORY_INTERVENTION_DEFAULT_EVERY_N_TOOLS` | keep | 10 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts MEMORY_INTERVENTION_DEFAULT_MAX_TOKENS` | keep | 2000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts MEMORY_INTERVENTION_DEFAULT_WINDOW_STEPS` | keep | 8 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/memory-intervention.ts MEMORY_INTERVENTION_TIMEOUT_BACKOFF_THRESHOLD` | keep | 2 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/watchdog.ts WATCHDOG_DIFF_MAX_BYTES` | keep | 12288 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/middleware/watchdog.ts WATCHDOG_PATHS_MAX` | keep | 40 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/session/compaction/auto.ts DEFAULT_COMPACTION_THRESHOLD` | keep | 0.8 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/session/compaction/defaults.ts DEFAULT_KEEP_RECENT_TOKENS` | keep | 20000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/domains/session/compaction/defaults.ts DEFAULT_RESERVE_TOKENS` | keep | 16384 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts CROSS_ARGUMENT_RESULT_MIN_BYTES` | keep | 64 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts INTERACTIVE_LOOP_BLOCK_BUDGET` | keep | 2 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts LOOP_GUARD_TURN_LIMIT` | keep | 32 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts LOOP_SYNTHESIS_BACKSTOP_DENIALS` | keep | 2 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts ORCH_TURN_TOOL_CALL_HARD_MARGIN` | keep | 15 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts RESULT_STAGNATION_THRESHOLD` | keep | 3 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts SUCCEEDED_FINGERPRINT_LIMIT` | keep | 128 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts WIDE_BATCH_DENIAL_FLOOR` | keep | 32 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/engine/loop-guard.ts WORKER_LOOP_BLOCK_CALLS_PER_BLOCK` | keep | 10 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/interactive/chat-renderer.ts DEFAULT_COALESCE_MS` | keep | 16 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/interactive/chat-renderer.ts MAX_REPLAY_TEXT_CHARS` | keep | 20000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/dispatch-arguments.ts DEFAULT_MAX_OUTPUT_BYTES` | keep | 20000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/dispatch-arguments.ts PERSONA_MAX_CHARS` | keep | 8000 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/observation.ts BUDGET_TRACK_LIMIT` | keep | 256 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/observation.ts MAX_CONTINUATION_CHARS` | keep | 200 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/observation.ts MAX_EXHAUSTED_NOTICES_PER_TURN` | keep | 3 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/observation.ts MIN_BUDGET_SLICE_BYTES` | keep | 1024 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |
| `src/tools/observation.ts OBSERVATION_POLICY_SLACK_BYTES` | keep | 2048 | Keep as an implementation invariant or safety bound; it is excluded from operator-facing totals. | Low: no migration | no |

## Migration Sequence

1. Remove deprecated environment and flag aliases after changelog notice, then fail fast on old spellings.
2. Make typed settings authoritative for the duplicated environment surfaces and refresh live session configuration on settings changes.
3. Remove unconsumed model-knowledge extraction fields while retaining source provenance that remains useful to maintainers.
4. Introduce versioned migrations before changing settings families, installed commands, project-file validation, or model-facing tool schemas.
5. Measure behavior and operator usage before hardcoding implementation tuning or removing advanced execution controls.

## Validation Gates

Every applied group must pass `npm run knobs`, `npm run knobs:check`, `npm run typecheck`, `npm run lint`, and `npm test`. Schema reductions that remain unapplied require dedicated compatibility tests and migration notes before implementation.
