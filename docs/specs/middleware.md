# Middleware Domain

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The middleware domain is a pure declarative policy layer. It defines hook points around model turns, tool calls, dispatch, compaction, retry, and finish-contract events; a closed enumeration of effect kinds; a hook runtime; and a worker-safe snapshot the dispatch path threads into worker runs. The stable built-in rule catalog is intentionally empty until a rule has enforced behavior and regression tests. Custom user JavaScript is intentionally not loaded; rules are data, not plugins. The domain has no direct CLI surface in v0.1.4.

## Data layout

The middleware domain is in-process. There is no on-disk store. The built-in rule registry lives in `src/domains/middleware/rules.ts`; it currently returns no rules. The worker-safe snapshot is a JSON-serializable `MiddlewareSnapshot` that the dispatch path attaches to every worker run; the worker rehydrates it from stdin and runs the same hook runner the orchestrator does.

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

`BUILTIN_MIDDLEWARE_RULE_IDS` is an empty list. Previous placeholder rules were removed because they emitted no effects and made stable execution look more policy-rich than it was. New built-in middleware should land only with enforced behavior and tests that prove the effect is consumed.

## Invariants

1. `runMiddlewareHook` is pure. With the shipped empty registry it returns an empty `effects[]` array and empty `ruleIds[]`.
2. There is no plugin loader; user JavaScript is not executed.
3. Hook inputs are cloned before they leave the runtime so rules cannot mutate caller state.
4. The worker-safe `MiddlewareSnapshot` is JSON-serializable and contains no closures, references, or imports. The worker re-creates the runner from data.
5. Tool registry effects honored in v0.1.4 are `block_tool`, `annotate_tool_result`, and `protect_path`. `block_tool` stops an admitted call before execution. `annotate_tool_result` appends a deterministic annotation block to the tool result text. `protect_path` adds the path to the in-memory protected-artifacts state.
6. `record_memory_candidate` is declarative metadata only this slice. The runtime does not emit memory candidates from middleware in v0.1.4; the `memory-curator` agent recipe is the supported derivation path.
7. `inject_reminder` and `require_validation` are observable but not enforced as hard blocks in v0.1.4. They feed the advisory finish-contract path and are recorded in evidence.
8. Disabled rules (`enabled: false`) are skipped by `middlewareRuleIdsForHook` for snapshots that contain rules.

## Status and scope notes

The middleware runtime is intentionally conservative: no built-in rule emits effects in stable execution. Tool-registry wiring (`block_tool`, `annotate_tool_result`, `protect_path`) remains the concrete enforcement path for middleware effects supplied by tests or future validated snapshots. The worker rehydrates the snapshot and runs the same pure hook runner.

## References

- `src/domains/middleware/types.ts`: hook, effect, rule, and snapshot types.
- `src/domains/middleware/rules.ts`: built-in rule registry and per-hook id lookup.
- `src/domains/middleware/runtime.ts`: pure no-op hook runner.
- `src/domains/middleware/snapshot.ts`: worker-safe snapshot helpers.
- `src/domains/middleware/validate.ts`: declarative rule/effect validation.
- `src/domains/middleware/index.ts`: public domain entry.
- `src/tools/registry.ts`: tool-surface effect wiring (`block_tool`, `annotate_tool_result`, `protect_path`).
- `src/domains/dispatch/`: snapshot threading into worker runs.
- `tests/unit/middleware.test.ts` and the registry/wiring tests: regression coverage.
