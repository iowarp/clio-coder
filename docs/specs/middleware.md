# Middleware Domain

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The middleware domain is a pure declarative policy layer. It defines hook points around model turns, tool calls, dispatch, compaction, retry, and finish-contract events; a closed enumeration of effect kinds; a built-in rule registry; a no-op runtime that emits `ruleIds` per hook; and a worker-safe snapshot the dispatch path threads into worker runs. v0.1.4 ships the declarative metadata, the no-op hook runner, the snapshot wiring, and three tool-surface effects enforced through the tool registry. Custom user JavaScript is intentionally not loaded; rules are data, not plugins. The domain has no direct CLI surface in v0.1.4.

## Data layout

The middleware domain is in-process. There is no on-disk store. The built-in rule registry lives in `src/domains/middleware/rules.ts` and is cloned per call so consumers cannot mutate the canonical list. The worker-safe snapshot is a JSON-serializable `MiddlewareSnapshot` that the dispatch path attaches to every worker run; the worker rehydrates it from stdin and runs the same no-op hook runner the orchestrator does.

## Public CLI surface

None in v0.1.4. The middleware domain is consumed through:

- the tool registry (`src/tools/registry.ts`) which calls `runMiddlewareHook` around every admitted tool execution,
- the dispatch path (`src/domains/dispatch/`) which serializes a `MiddlewareSnapshot` into `WorkerSpec` and replays no-op hooks inside the worker,
- the chat-loop (`src/interactive/chat-loop.ts`) which runs the advisory finish-contract check using the same hook runner.

`clio components` lists every middleware artifact under the `middleware` kind and `clio evolve manifest` accepts `middleware` as a `ManifestChange.authorityLevel`, but neither command edits middleware state.

## Public types

Types live in `src/domains/middleware/types.ts` and are re-exported from `src/domains/middleware/index.ts`.

- `MiddlewareHook` enumerates 11 hooks: `before_model`, `after_model`, `before_tool`, `after_tool`, `before_finish`, `after_finish`, `on_blocked_tool`, `on_retry`, `on_compaction`, `on_dispatch_start`, `on_dispatch_end`.
- `MiddlewareEffectKind` enumerates 6 effect kinds: `inject_reminder`, `annotate_tool_result`, `block_tool`, `protect_path`, `require_validation`, `record_memory_candidate`.
- `MiddlewareEffect` is the discriminated union over the six kinds with their per-kind payloads. `inject_reminder` and `annotate_tool_result` carry an optional `severity`; `block_tool` requires `severity: "hard-block"`; `protect_path` carries a path and reason; `require_validation` carries a reason; `record_memory_candidate` carries a lesson and evidence refs.
- `MiddlewareRule` is the rule shape: `id`, `source` (always `builtin` in v0.1.4), `description`, `enabled`, `hooks[]`, `effectKinds[]`.
- `MiddlewareSnapshot` is the worker-safe envelope: `{ version: 1, rules[] }`.
- `MiddlewareHookInput` and `MiddlewareHookResult` are the hook runner contract.

## Built-in rules

`BUILTIN_MIDDLEWARE_RULE_IDS` is a closed list of 8 ids:

- `publish-state-guard`: detects tool flows that may publish or mutate durable harness state. Hooks: `before_tool`, `after_tool`. Effects permitted: `protect_path`, `require_validation`, `inject_reminder`.
- `finish-contract-check`: tracks finish-contract advisories around the final assistant handoff. Hooks: `before_finish`, `after_finish`. Effects permitted: `inject_reminder`, `require_validation`.
- `proxy-validation-detector`: detects proxy validation patterns after tool execution and on blocked tool attempts. Hooks: `after_tool`, `on_blocked_tool`. Effects permitted: `annotate_tool_result`, `require_validation`.
- `resource-budget-sentinel`: observes dispatch, model, and retry hooks for future budget policy decisions. Hooks: `before_model`, `after_model`, `on_retry`, `on_dispatch_start`, `on_dispatch_end`. Effects permitted: `inject_reminder`, `require_validation`.
- `framework-reminder`: carries framework reminders for future model, tool, and compaction boundaries. Hooks: `before_model`, `before_tool`, `on_compaction`. Effects permitted: `inject_reminder`.
- `science.no-existence-only-validation`: reminds agents that file existence does not validate scientific artifacts. Hooks: `before_finish`, `after_tool`. Effects permitted: `inject_reminder`, `annotate_tool_result`.
- `science.preserve-checkpoints`: marks validated checkpoint and restart artifacts as protected so destructive cleanup tools cannot remove them. Hooks: `before_tool`, `after_tool`. Effects permitted: `protect_path`, `inject_reminder`.
- `science.unit-vs-scheduler-validation`: distinguishes local unit validation from scheduler-backed validation (`sbatch`, `srun`, `qsub`, `flux run`); a scheduler exit code does not validate produced artifacts. Hooks: `after_tool`, `before_finish`. Effects permitted: `inject_reminder`, `annotate_tool_result`.

The five generic ids ship from M4. The three `science.*` ids ship as the M10 scientific-validation seed.

## Invariants

1. `runMiddlewareHook` is pure. It returns an empty `effects[]` array and the rule ids whose `hooks[]` includes the requested hook.
2. The built-in registry is the only source of rules in v0.1.4. There is no plugin loader; user JavaScript is not executed.
3. Hook inputs are cloned before they leave the runtime so rules cannot mutate caller state.
4. The worker-safe `MiddlewareSnapshot` is JSON-serializable and contains no closures, references, or imports. The worker re-creates the runner from data.
5. Tool registry effects honored in v0.1.4 are `block_tool`, `annotate_tool_result`, and `protect_path`. `block_tool` stops an admitted call before execution. `annotate_tool_result` appends a deterministic annotation block to the tool result text. `protect_path` adds the path to the in-memory protected-artifacts state.
6. `record_memory_candidate` is declarative metadata only this slice. The runtime does not emit memory candidates from middleware in v0.1.4; the `memory-curator` agent recipe is the supported derivation path.
7. `inject_reminder` and `require_validation` are observable but not enforced as hard blocks in v0.1.4. They feed the advisory finish-contract path and are recorded in evidence.
8. Disabled rules (`enabled: false`) are skipped by `middlewareRuleIdsForHook`. All built-ins ship enabled in v0.1.4.

## Status and scope notes

The middleware runtime is intentionally a no-op effect emitter. The framework is in place so future slices can plug rule evaluators per id without changing the consumer surface. Tool-registry wiring (`block_tool`, `annotate_tool_result`, `protect_path`) is the first concrete enforcement; the worker rehydrates the snapshot but keeps the same no-op runner. The advisory finish-contract check at `src/domains/safety/finish-contract.ts` consumes `before_finish` and `after_finish` outputs; its strict mode is reserved for a later slice. Cross-references the scientific-validation pack at `docs/specs/scientific-validation.md` for the three `science.*` rules' intent and worked example.

## References

- `src/domains/middleware/types.ts`: hook, effect, rule, and snapshot types.
- `src/domains/middleware/rules.ts`: built-in rule registry and per-hook id lookup.
- `src/domains/middleware/runtime.ts`: pure no-op hook runner.
- `src/domains/middleware/snapshot.ts`: worker-safe snapshot helpers.
- `src/domains/middleware/validate.ts`: snapshot validation for the worker rehydrate path.
- `src/domains/middleware/index.ts`: public domain entry.
- `src/tools/registry.ts`: tool-surface effect wiring (`block_tool`, `annotate_tool_result`, `protect_path`).
- `src/domains/dispatch/`: snapshot threading into worker runs.
- `src/domains/safety/finish-contract.ts`: advisory finish-contract consumer.
- `tests/unit/middleware.test.ts`, `tests/unit/dispatch-memory-injection.test.ts`, and the registry/wiring tests under `tests/unit/`: regression coverage.
- `docs/specs/scientific-validation.md`: the M10 spec covering the three `science.*` rules.
- `docs/.superpowers/IMPROVE.md` section M4 and M10: roadmap entries.
