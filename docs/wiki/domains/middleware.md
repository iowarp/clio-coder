---
title: "Middleware Domain"
summary: "The unified hook-based effect layer that observes five lifecycle events (before_tool, after_tool, turn_start, turn_end, on_compaction), evaluates ordered registrations, and emits effects that steer tool admission, reminders, continuations, and operator notices."
sources:
  - "src/domains/middleware/index.ts"
  - "src/domains/middleware/extension.ts"
  - "src/domains/middleware/runtime.ts"
  - "src/domains/middleware/registrations.ts"
  - "src/domains/middleware/contract.ts"
  - "src/domains/middleware/types.ts"
  - "src/domains/middleware/rules.ts"
  - "src/domains/middleware/budget.ts"
  - "src/domains/middleware/hooks.ts"
  - "src/domains/middleware/hooks-io.ts"
  - "src/domains/middleware/hook-receipts.ts"
  - "src/domains/middleware/snapshot.ts"
  - "src/domains/middleware/validate.ts"
  - "src/domains/middleware/memory-intervention.ts"
  - "src/domains/middleware/dispatch-nudge.ts"
  - "src/domains/middleware/guidance.ts"
  - "src/domains/middleware/marketplace-offer.ts"
tests:
  - "tests/contracts/middleware-hooks.test.ts"
invariants:
  - "One id namespace shared across all tiers; a colliding registration is dropped, first entry wins."
  - "Evaluation is synchronous on the caller's stack; async work is isolated to the evaluateAsync phase."
  - "Every registration is copy-on-write: a publishing writer computes a complete next state, then publishes with one reference assignment."
  - "User hooks cannot grant a permission that the safety policy would deny; they can only add effects."
  - "Worker snapshots strip rules that declare notify_operator effects, since workers have no operator surface."
validate:
  - "pnpm test:file -- tests/contracts/middleware-hooks.test.ts"
---

# Middleware Domain

The middleware layer is the unified hook-based effect system that Clio Coder's orchestrator and workers use to observe tool calls and turn boundaries. It fires at exactly five lifecycle events, evaluates ordered registrations against each event, and emits a closed set of effect kinds that steer tool admission, inject reminders, request continuations, and deliver operator-only notices. The layer is domain-neutral: it knows no tool semantics, no safety rules, no session state, and no dispatch mechanics. It only matches hook inputs, runs ordered evaluations, and accumulates effects.

## Lifecycle Events and Effect Kinds

The five lifecycle events are defined as `MIDDLEWARE_HOOKS` in `src/domains/middleware/types.ts`:

```ts
export const MIDDLEWARE_HOOKS = ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"] as const;
```

- **before_tool** / **after_tool**: fired by the tool registry during `runSpec`, around each tool invocation. They carry `toolName`, `toolArgs`, `toolResultDetails`, and `toolResultDigest`.
- **turn_start**: fired by the chat loop when a user prompt is accepted. Carries the prompt text in `input.text`, metadata about conversation length, active tool names, and pending skill requests.
- **turn_end**: fired by the chat loop when the final assistant message lands. Carries the assistant text, stop reason, turn tool call counts, and active tool names.
- **on_compaction**: fired by the chat loop before each compaction or working-set stage. Carries stage and trigger metadata. Effects are discarded by design; this is an observe-only point.

The eight effect kinds are defined as `MIDDLEWARE_EFFECT_KINDS`:

```ts
export const MIDDLEWARE_EFFECT_KINDS = [
  "inject_reminder",
  "annotate_tool_result",
  "block_tool",
  "protect_path",
  "request_continuation",
  "require_tool",
  "lock_tools",
  "notify_operator",
] as const;
```

Each effect kind has a specific contract:
- **inject_reminder**: adds a system-reminder block to the model's context on the next turn. Severity: `info`, `advisory`, `warn`, or `hard-block`.
- **annotate_tool_result**: adds a message to the tool result the model sees. Severity: `info` or `warn`.
- **block_tool**: refuses a tool call. Severity is always `hard-block`. The registry treats the first `block_tool` as the verdict.
- **protect_path**: adds a path to the protected-artifact registry. Consumed by the protected-artifacts guard after user hooks.
- **request_continuation**: carries a turn onward with a nudge. One continuation per user prompt.
- **require_tool**: forces a specific tool to be used in the next round.
- **lock_tools**: locks all tools for the rest of the turn so the model answers from what it gathered.
- **notify_operator**: delivers a message to the operator only. Never enters model context.

## The Registration Table

The middleware contract is built on a three-tier, copy-on-write registration table defined in `src/domains/middleware/registrations.ts`. The three tiers share one id namespace and one evaluation list:

1. **Fixed tier**: declarative rules (builtin plus composition-root definitions), immutable for the life of the contract, always evaluated first. These come from `listMiddlewareRuleDefinitions()` in `src/domains/middleware/rules.ts`, which returns `STALLED_TURN_RULE_DEFINITION` and `INJECTION_SCREEN_RULE`.

2. **Host tier**: coded registrations appended by the composition root through `registerHook`. Append-only, first id wins. The orchestrator uses this for guards, observers, nudges, and assessors.

3. **Owned tier**: registration sets replaced as one unit by an owner under a strictly increasing generation. Today the only owner is `"user-hooks"`, used for user-defined middleware hooks from `.clio-coder/hooks.yaml` and extensions.

The table is one immutable state object held behind a single reference. Every writer computes a complete next state and publishes it with one assignment. Readers capture the reference once per evaluation, so an evaluation that started before a publish finishes against the state it started with, including across an await.

```ts
// src/domains/middleware/registrations.ts
const table: MiddlewareRegistrationTable = {
  list: () => state.list,
  registerHook(registration) { /* append to host tier */ },
  prepareReplacement(owner, generation, registrations) { /* build next state without publishing */ },
  replaceRegistrations(owner, generation, registrations) { /* prepare + publish */ },
  ownedGeneration(owner) { /* active generation for owner */ },
};
```

The `prepareReplacement` method builds the complete next state, validates conflicts, and returns a `MiddlewareRegistrationReplacement` that publishes with one reference assignment. Preparation never runs user code: conflicts are returned as frozen data and a caller emits them through the diagnostic sink only after publication. This is what lets the composition root publish an extension generation and hook registrations with two adjacent assignments on one stack, so no consumer ever sees extension resources paired with hooks from a different generation.

## The Runtime Evaluation Path

The runtime in `src/domains/middleware/runtime.ts` provides two entry points:

- **`runMiddlewareRegistrations`**: synchronous evaluation. Called by the tool registry (`runToolHook`) and the chat loop (`runMiddlewareTurnHook`).
- **`runMiddlewareAsyncRegistrations`**: asynchronous evaluation. Called by the chat loop after the synchronous phase at turn boundaries.

Both follow the same pattern:

```ts
export function runMiddlewareRegistrations(
  input: MiddlewareHookInput,
  registrations: ReadonlyArray<MiddlewareHookRegistration>,
  options: RunMiddlewareRegistrationsOptions = {},
): MiddlewareHookResult {
  // 1. Match registrations to the input's hook event and tool name
  // 2. Clone the input for each evaluation (defensive isolation)
  // 3. Call registration.evaluate() synchronously
  // 4. Record elapsed time in the budget tracker
  // 5. Emit budget diagnostics if exceeded
  // 6. Clone effects and accumulate
  // 7. Return { hook, input, effects, ruleIds }
}
```

Key behaviors:

- **Isolation**: a throwing registration is reported via the diagnostic sink and skipped. The turn never fails because of a middleware hook.
- **Prior effects**: each evaluation receives a `MiddlewareHookEvaluationContext` carrying `priorEffects`, the effects emitted by earlier registrations in the same hook run. This lets a consumer registered last (e.g., the protected-artifacts guard absorbing `protect_path`) react to them deterministically without shared mutable state.
- **Tool scoping**: a registration with `toolNames` defined only matches inputs that carry that tool name. Inputs without a tool name never match.
- **Budget tracking**: every evaluation is recorded against a session-scoped budget tracker. Phase-aware budgets: `before_tool`/`after_tool` have 25ms budgets (hot path), `turn_start` has 50ms, `turn_end` has 75ms, `on_compaction` has 150ms. Warmup grace: the first invocation per (registrationId, hook) never warns. Steady-state detection: only warns when ≥3 of the last 5 post-warmup calls exceeded budget.

## The Middleware Contract

The contract in `src/domains/middleware/contract.ts` exposes the registration table and evaluation path to the rest of the system:

```ts
export interface MiddlewareContract {
  runHook(input: MiddlewareHookInput): MiddlewareHookResult;
  runAsyncHook?(input: MiddlewareHookInput, priorEffects?: ReadonlyArray<MiddlewareEffect>): Promise<MiddlewareHookResult>;
  snapshot(): MiddlewareSnapshot;
  registerHook(registration: MiddlewareHookRegistration): void;
  setDiagnosticSink(sink: MiddlewareDiagnosticSink): void;
  prepareRegistrationReplacement(owner, generation, registrations): PrepareRegistrationReplacementResult;
  replaceRegistrations(owner, generation, registrations): ReplaceRegistrationsReport;
  ownedGeneration(owner): number;
}
```

The domain loader constructs the bundle via `createMiddlewareBundle` in `src/domains/middleware/extension.ts`. The composition root (`src/entry/orchestrator.ts`) then calls `registerHook` to add coded registrations: guards (loop-guard, protected-artifacts), observers (skill-activation, file-mutation), nudges (task-board, dispatch-dedup, tool-prose, task-nudge, read-only-exploration, unbacked-worker-claim, detached-dispatch), assessors (finish-contract, watchdog), and guidance (marketplace-offer, skills-reminder, decision-hints).

## User-Defined Hooks

User hooks are a conservative, receipted automation surface that extensions and project configuration can declare on top of the effect machinery. They are defined in `src/domains/middleware/hooks.ts` and loaded in `src/domains/middleware/hooks-io.ts`.

### Hook Kinds

A user hook is one of three closed kinds:

- **prompt**: injects one small reminder (an `inject_reminder` effect). Message capped at 2000 characters.
- **effect**: emits one existing closed middleware effect verbatim. The effect must validate against `validateMiddlewareEffect` in `src/domains/middleware/validate.ts`.
- **command**: runs an explicit argv (no shell) under the workspace with a timeout and bounded output, surfaced as one effect. Timeout: 100-5000ms (default 2000ms). Output capped at 4000 characters.

### Event/Effect Applicability

Not every effect kind is applicable to every hook event. The `USER_HOOK_APPLIED_EFFECTS` map in `hooks.ts` defines the allowed pairings:

```ts
const USER_HOOK_APPLIED_EFFECTS: Readonly<Record<MiddlewareHook, ReadonlyArray<MiddlewareEffectKind>>> = {
  before_tool: ["block_tool", "annotate_tool_result", "require_tool", "lock_tools", "protect_path"],
  after_tool: ["annotate_tool_result", "require_tool", "lock_tools", "protect_path"],
  turn_start: ["inject_reminder", "notify_operator", "require_tool", "lock_tools"],
  turn_end: ["inject_reminder", "request_continuation", "notify_operator"],
  on_compaction: [],
};
```

A hook declaration that pairs an event with an effect it cannot apply is refused at load time, not recorded as "emitted" and ignored. For example, a `before_tool` hook cannot apply `inject_reminder` (the model is mid-tool-call and cannot read a reminder yet), so `normalizeUserHook` returns an issue naming the events that can apply it.

### Origins and Precedence

Hooks come from four origins, lowest precedence first:

```ts
export const USER_HOOK_ORIGIN_ORDER: ReadonlyArray<UserHookOrigin> = ["extension", "user", "project", "project.local"];
```

- **extension**: hooks shipped by an installed extension, captured from verified bytes during install-digest verification.
- **user**: (reserved, not currently loaded).
- **project**: `.clio-coder/hooks.yaml` committed to the repo.
- **project.local**: `.clio-coder/hooks.local.yaml` gitignored local hooks.

On an id collision, the higher-precedence origin wins and the loser is reported for the inspector. Malformed declarations are collected as issues and never throw.

### Trust and Isolation

User hooks are trust-gated. The composition root publishes the extension generation and hook registrations with two adjacent assignments on one stack, and reloads plugin resources only after both. The boot generation is published before any consumer can see a mismatch.

Project hooks stop executing after their approved surface changes or is revoked. The `isTrusted` callback in `UserHookRegistrationDeps` is wired to `projectStillTrusted` in `hooks-io.ts`, which re-captures the project surface and compares the content hash. If the hash changed or trust was revoked, hooks are skipped and the operator is notified.

Extension hooks are never read from disk by middleware. They arrive already parsed as a captured source set that the composition root adapts from the extension snapshot, which captured the bytes during install-digest verification. A `hooks.yaml` rewritten after verification cannot be admitted until the next generation re-verifies the tree.

### Receipts

Every hook execution emits a `HookReceipt` with source attribution and content hash. The `HookReceiptLog` in `src/domains/middleware/hook-receipts.ts` keeps a bounded in-memory ring (capacity 200) and persists it atomically through `safeResourceWrite`. Writes are throttled to 2 seconds so a per-tool-call cadence never turns into per-call disk I/O. `flush()` forces a final write at shutdown. `clio-coder config inspect` reads the persisted snapshot back with `readPersistedHookReceipts`.

## Budget Tracking

The budget tracker in `src/domains/middleware/budget.ts` enforces phase-aware soft budgets for middleware hook evaluation. The flat 10ms-per-call budget was wrong on two counts: it fired on one-time JIT/module warmup, and it treated every hook phase the same.

**Phase budgets** (defaults):
- `before_tool`: 25ms
- `after_tool`: 25ms
- `turn_start`: 50ms
- `turn_end`: 75ms
- `on_compaction`: 150ms

**Warmup grace**: first N invocations per (registrationId, hook) never warn (default 1). One-time warmup is not misbehavior.

**Steady-state detection**: rolling window of M=5 post-warmup calls. Warns when ≥N=3 of the last 5 exceeded budget. A lone spike never sets `steadyStateWarn`; only consistent slowness does.

**Environment overrides**:
- `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS`: per-phase budget
- `CLIO_CODER_HOOK_BUDGET_MS`: global budget
- `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS`: warmup count
- `CLIO_CODER_HOOK_BUDGET_WINDOW`: rolling window size
- `CLIO_CODER_HOOK_BUDGET_THRESHOLD`: over-budget count to warn

Invalid or non-positive values are ignored so a typo never zeroes a budget.

## Worker Snapshots

Workers receive a declarative snapshot of the middleware rules and rebuild their contract from it. The snapshot in `src/domains/middleware/snapshot.ts` carries no effect payloads: it only has rule metadata (id, enabled, hooks, effectKinds).

**Why no payloads?**: A worker has no operator surface, and its spec validator admits no `notify_operator` effect kind, so a rule declaring one would fail every dispatch at parse time. Such rules stay with the orchestrator.

**Snapshot filtering**: `createMiddlewareSnapshot` strips rules that declare `notify_operator`:

```ts
export function createMiddlewareSnapshot(
  rules: ReadonlyArray<MiddlewareRule> = listMiddlewareRules(),
): MiddlewareSnapshot {
  return {
    version: 1,
    rules: rules.filter((rule) => !rule.effectKinds.includes("notify_operator")).map(cloneMiddlewareRule),
  };
}
```

**Worker rebuild**: `createMiddlewareContractFromSnapshot` rebuilds a contract from the snapshot. Each rule is resolved against the builtin definition table by id; the snapshot's declarative fields (enabled, hooks, effectKinds) stay authoritative. A rule id with no builtin definition in this binary evaluates to no effects.

Workers never receive owned registrations; the table exists so the worker contract satisfies the same interface with the same semantics.

## Built-in Rules

The builtin rules in `src/domains/middleware/rules.ts` are declarative rule definitions that ship with the binary:

- **STALLED_TURN_RULE_DEFINITION**: detects a turn that made the skill suggestion and then stopped, with only the listing call behind it (issue #184). The generic stalled-turn predicate cannot see this: the tool call was successful, so a "stalled" nudge is needed to continue.

- **INJECTION_SCREEN_RULE**: raw-body marker detection. The registry supplies the raw body before result shaping; this rule detects injection attempts.

These rules travel in the snapshot to workers, which resolve payloads from the builtin table by rule id.

## Extension Seams

The middleware layer is designed for extension at several seams:

### 1. Adding a Host Registration

The composition root calls `middleware.registerHook(registration)` to add a coded registration. The registration must implement `MiddlewareHookRegistration`:

```ts
interface MiddlewareHookRegistration {
  id: string;
  description: string;
  hooks: ReadonlyArray<MiddlewareHook>;
  toolNames?: ReadonlyArray<string>;
  evaluate(input: MiddlewareHookInput, context?: MiddlewareHookEvaluationContext): ReadonlyArray<MiddlewareEffect>;
  evaluateAsync?(input: MiddlewareHookInput, context?: MiddlewareHookEvaluationContext): Promise<ReadonlyArray<MiddlewareEffect>>;
}
```

Host registrations are append-only. A colliding id is dropped, first entry wins.

### 2. Adding a User Hook

Project authors add hooks to `.clio-coder/hooks.yaml` or `.clio-coder/hooks.local.yaml`:

```yaml
- id: my-hook
  on: turn_start
  kind: prompt
  message: "Remember to test your changes"
```

Extension authors ship `hooks.yaml` in their extension package. The hooks are captured during install-digest verification and arrive as a `CapturedHookSourceSet`.

### 3. Adding a Built-in Rule

To ship a builtin policy, add an entry to `BUILTIN_MIDDLEWARE_RULE_DEFINITIONS` in `src/domains/middleware/rules.ts`. The rule must be a `MiddlewareRuleDefinition` with declarative rule metadata and effect payloads. The snapshot channel delivers the declarative half to workers, which resolve payloads from this table by rule id.

### 4. Adding a User Hook Kind

The three kinds (prompt, effect, command) are a closed set. Adding a fourth requires updating `NormalizedUserHookSpec` in `hooks.ts`, the normalization functions, the applicability map, and the validation logic.

## Key Symbols and Files

| Symbol | File | Purpose |
|--------|------|---------|
| `MiddlewareContract` | `contract.ts` | The interface exposed to the orchestrator and workers |
| `MiddlewareRegistrationTable` | `registrations.ts` | The three-tier, copy-on-write registration table |
| `runMiddlewareRegistrations` | `runtime.ts` | Synchronous evaluation path |
| `runMiddlewareAsyncRegistrations` | `runtime.ts` | Asynchronous evaluation path |
| `createMiddlewareBundle` | `extension.ts` | Constructs the domain bundle |
| `createMiddlewareContractFromSnapshot` | `snapshot.ts` | Rebuilds a contract for workers |
| `normalizeUserHook` | `hooks.ts` | Validates one raw hook declaration |
| `loadUserHooks` | `hooks.ts` | Merges hooks across sources with precedence |
| `userHookToRegistration` | `hooks.ts` | Turns a normalized hook into a coded registration |
| `createHookBudgetTracker` | `budget.ts` | Session-scoped budget tracker |
| `createHookReceiptLog` | `hook-receipts.ts` | Durable receipt log for user hooks |
| `validateMiddlewareEffect` | `validate.ts` | Validates a raw effect against the closed set |
| `createMemoryInterventionRegistration` | `memory-intervention.ts` | Proactive task-memory policy |
| `createReadOnlyExplorationNudgeRegistration` | `dispatch-nudge.ts` | Advises Scout delegation |
| `createGuidanceRegistration` | `guidance.ts` | Post-turn capability tips |
| `createMarketplaceOfferRegistration` | `marketplace-offer.ts` | Marketplace skill promotion |

## Upstream Callers

- **`src/interactive/turn-middleware.ts`**: fires `turn_start`, `turn_end`, and `on_compaction` hooks from the chat loop. Owns every `deps.middleware` interaction of the loop.
- **`src/tools/registry.ts`**: fires `before_tool` and `after_tool` hooks during `runSpec`. The registry treats the first `block_tool` as the verdict.
- **`src/entry/orchestrator.ts`**: constructs the middleware bundle and registers all host registrations (guards, observers, nudges, assessors).

## Downstream Dependencies

- **`src/domains/session/`**: memory-intervention reads the session bank and writes injected entries.
- **`src/domains/dispatch/`**: dispatch-nudge reads detached batch views and ownership.
- **`src/domains/safety/`**: the loop-detector provides `hashToolCall`; the finish-contract uses the nudge channel.
- **`src/domains/resources/skills/`**: marketplace-offer reads installed skills and marketplace entries.

## Tests

The contract test suite `tests/contracts/middleware-hooks.test.ts` covers:

- **Extension hook boundary**: does not admit hooks from an unverifiable installed extension (symlinked payload outside the project).
- **Extension hook provenance**: builds extension hooks from captured bytes and attributes receipts to the admitting generation. A rewritten tree after the snapshot was built cannot reach this generation's registrations.
- **Ordered evaluation**: evaluates matching registrations in order and exposes prior effects.
- **Isolation**: isolates a failed registration and continues later effects. A throwing registration is reported and skipped, never propagated.
- **Tool scoping**: matches exact hook and tool scopes. A `before_tool` hook with `toolNames: ["write"]` does not match `toolName: "read"` or inputs without a tool name.
- **Async serialization**: serializes async phases in registration order and isolates rejection. A throwing async registration does not break the chain.
- **Generation ownership**: replaces an owner's set as one unit under a strictly increasing generation. Stale generations are refused.
- **Stale disposer**: makes a stale disposer harmless and lets a prepared replacement refuse after supersession.
- **Builtin/host id exclusion**: keeps builtin and host ids out of owned sets and lets a host registration evict an owned one.
- **Owned slot anchoring**: anchors the owned slot where it was first applied and keeps it there across replacements.
- **In-flight async**: finishes an in-flight async evaluation against its captured list while later evaluations use the new one.
- **Reference model**: matches a reference model across every ordering of replace, dispose, host, and evaluate (120 permutations).
- **Copy-on-write publication**: holds one copy-on-write state reference and publishes with an assignment that cannot refuse.
- **User hook applicability**: rejects a hook whose event cannot apply the effect it produces, naming the events that can.
- **Snapshot filtering**: strips operator-notification rules from the snapshot workers receive.

## Things to Watch When Editing

1. **Id collisions**: the three tiers share one id namespace. A host registration that takes an owned id evicts the owned registration (with a diagnostic). An owned registration that collides with a builtin or host id is dropped.

2. **Copy-on-write semantics**: a publishing writer must compute the complete next state before publishing. The `prepareReplacement` method builds the next state without running user code. Conflicts are returned as frozen data. A caller emits them through the diagnostic sink only after publication.

3. **Budget isolation**: a budget diagnostic sink must never affect hook evaluation or the turn. The `emitDiagnostic` function in `runtime.ts` wraps the sink call in a try-catch.

4. **Trust revocation**: project hooks stop executing after their approved surface changes or is revoked. The `isTrusted` callback must re-capture the project surface and compare the content hash.

5. **Worker snapshots**: workers receive no `notify_operator` effects. If a builtin rule declares this effect kind, it is stripped from the snapshot. The rule stays with the orchestrator.

6. **Async isolation**: the async phase is isolated from the synchronous phase. A throwing async registration is reported and skipped. The synchronous phase never awaits the async phase.

7. **Extension isolation**: extension hooks are never read from disk by middleware. They arrive as captured bytes from the extension snapshot. A `hooks.yaml` rewritten after verification cannot be admitted until the next generation re-verifies the tree.

8. **Text capping**: `MiddlewareHookInput.text` is capped at `MIDDLEWARE_HOOK_TEXT_MAX_CHARS` (16,000 characters) by the runtime when cloning inputs. Producers report the true length out of band.
