---
title: "Domains scheduling"
summary: "The scheduling domain owns three things: the session cost budget that scores spend against a ceiling, the fleet node registry that turns N machines into one pinnable capacity pool, and the local-capacity resolver that sizes worker concurrency under fleet.concurrency."
sources:
  - "src/domains/scheduling/index.ts"
  - "src/domains/scheduling/contract.ts"
  - "src/domains/scheduling/extension.ts"
  - "src/domains/scheduling/budget.ts"
  - "src/domains/scheduling/cluster.ts"
  - "src/domains/scheduling/local-capacity.ts"
  - "src/domains/scheduling/manifest.ts"
symbols:
  - "SchedulingDomainModule"
  - "createSchedulingBundle"
  - "createBudgetState"
  - "createFleetRegistry"
  - "createLocalCapacitySampler"
  - "resolveGlobalConcurrency"
  - "resolveLocalConcurrency"
tests:
  - "tests/contracts/local-capacity.test.ts"
  - "tests/extended/fleet-lifecycle.test.ts"
invariants:
  - "The session budget verdict is advisory: dispatch records it on every reservation but never denies a reservation from it."
  - "A fleet node is classified offline after two consecutive channel failures and is restored by a later channel success."
  - "Under fleet.concurrency: auto the global worker pool caps at AUTO_MAX_WORKERS (8) while only the local node is sized from host CPU and memory."
validate:
  - "pnpm run test:file -- tests/contracts/local-capacity.test.ts"
---

# Domains scheduling

The scheduling domain is where Clio answers two questions that are easy to conflate: how much of this session's money is left to spend, and how many workers may run on each machine in the fleet. It bundles a session budget state, a fleet node registry, and a local-capacity resolver, and exposes them to the rest of the system through a small contract that the [Dispatch domain](dispatch.md) consumes to size and place new runs.

## What this area does

`SchedulingDomainModule` in `src/domains/scheduling/index.ts` is the domain's entry point. It carries `SchedulingManifest` (from `src/domains/scheduling/manifest.ts`) and `createSchedulingBundle`. The manifest declares the domain `scheduling` with `dependsOn: ["config", "observability"]`, which is why the bundle reads its ceiling from the `config` contract and its session spend from the `observability` contract.

The module exposes a `DomainModule` whose `createExtension` is `createSchedulingBundle` (in `src/domains/scheduling/extension.ts`). That function builds the three components, wires them together, and returns a `DomainBundle<SchedulingContract>` whose `contract` is the surface other domains read.

## What owns it

| File | Owns |
|---|---|
| `src/domains/scheduling/index.ts` | `SchedulingDomainModule`, re-exports `BudgetVerdict` and `SchedulingContract` |
| `src/domains/scheduling/manifest.ts` | `SchedulingManifest` (`name: "scheduling"`, `dependsOn: ["config", "observability"]`) |
| `src/domains/scheduling/extension.ts` | `createSchedulingBundle`, `SchedulingBundleOptions`, the budget-alert event subscription, `syncBudget` |
| `src/domains/scheduling/budget.ts` | `BudgetState`, `BudgetVerdict`, `createBudgetState`, `checkCeiling`, `raise` |
| `src/domains/scheduling/cluster.ts` | `FleetRegistry`, `createFleetRegistry`, `LOCAL_NODE_ID`, `NODE_DEATH_FAILURE_THRESHOLD` (2), `FleetNodeSnapshot` |
| `src/domains/scheduling/local-capacity.ts` | `resolveGlobalConcurrency`, `resolveLocalConcurrency`, `createLocalCapacitySampler`, `observeHostCapacityFacts`, the sizing constants |
| `src/domains/scheduling/contract.ts` | `SchedulingContract`, `BudgetPreflight` |

## Session budget state

`createBudgetState(initialCeilingUsd)` in `src/domains/scheduling/budget.ts` throws on a negative ceiling and returns a closure over a mutable `ceiling`. The three operations are:

- `ceilingUsd` (getter): current ceiling.
- `checkCeiling(currentUsd)`: returns `"over"` when spend is above the ceiling, `"at"` when equal, and `"under"` when below.
- `raise(newCeilingUsd)`: rejects a ceiling lower than the current one and otherwise replaces it.

The ceiling is seeded from `settings.safety.limits.sessionCostUsd` (default `5`, defined in `src/core/defaults.ts`). The module docstring in `budget.ts` states the division of labor directly: "Scheduling preflight exposes that spend and ceiling to dispatch reservations for accounting; the allocator does not enforce this session ceiling." Dispatch separately enforces an explicit per-request intent cost ceiling against the route estimate.

## Local-capacity resolver

`src/domains/scheduling/local-capacity.ts` is "the one resolver for `fleet.concurrency`" (per its docstring). The setting is `"auto" | number`.

`resolveGlobalConcurrency(configured)` returns `AUTO_MAX_WORKERS` (the constant `8`) when the setting is `undefined` or `"auto"`, otherwise `Math.max(1, Math.floor(configured))`. This is the cap on the *global* worker pool.

`resolveLocalConcurrency(configured, facts, clioHeldBytes)` resolves the limit for the implicit local node:
- A numeric setting returns `{ limit: resolveGlobalConcurrency(configured), bound: "configured" }`, ignoring host facts.
- Under `"auto"` it builds a candidate list `[{ limit: AUTO_MAX_WORKERS, bound: "cap" }, { limit: Math.max(1, Math.floor(facts.cpus)), bound: "cpu" }, { limit: workersFor(facts.availableMemoryBytes + clioHeldBytes), bound: "memory" }]` and appends a `cgroup` candidate when `facts.cgroupAvailableBytes !== null`. It then returns the candidate with the smallest `limit` (ties keep the earlier input), so a host that fits the cap reports `"cap"`.

`workersFor(bytes)` computes `Math.max(1, Math.floor((bytes - OS_MEMORY_RESERVE_BYTES) / WORKER_MEMORY_ESTIMATE_BYTES))`. The two sizing constants are `WORKER_MEMORY_ESTIMATE_BYTES = 1 GiB` (four times the observed 160–270 MB worker RSS, to absorb compiler/test-suite children) and `OS_MEMORY_RESERVE_BYTES = 2 GiB` (left for the OS, orchestrator, and local inference servers).

`createLocalCapacitySampler(options)` wraps a pure resolver in rate-limited sampling: it samples host facts at most once per `HOST_SAMPLE_INTERVAL_MS` (30,000 ms by default). Each sample also captures the `activeLocalWorkers` count, and `resolve("auto")` adds those workers back as `activeWorkers * WORKER_MEMORY_ESTIMATE_BYTES`, so the limit does not collapse as the fleet it admitted starts running. A numeric setting short-circuits before any sampling.

`observeHostCapacityFacts()` reads `node:os`: `availableParallelism()` for CPUs (respecting affinity masks such as a Slurm cpuset), `freemem()` for available memory, and `process.constrainedMemory()` / `process.availableMemory()` for the cgroup limit. The comment notes that `constrainedMemory()` reports an unbounded sentinel when no cgroup limit applies, so only a limit below physical memory constrains anything.

## Fleet node registry

`createFleetRegistry(getNodes, options)` in `src/domains/scheduling/cluster.ts` turns N machines into one addressable, pinnable capacity pool. Node configuration comes from the `getNodes` thunk (a `() => ReadonlyArray<FleetNodeSettings>`), which is read fresh on every call so settings edits apply on the next dispatch. Runtime state (channel health and last-seen observations) lives in a `Map<string, NodeRuntimeState>` owned by the registry.

Key behaviors:
- `LOCAL_NODE_ID` is `"local"`. The implicit local node is always first in `list()` and is never declared in settings. Its `maxWorkers` and `capacityBound` come from the `localCapacity` thunk (which the bundle binds to `localCapacity.resolve(fleet.concurrency)`); SSH nodes declare their own `maxWorkers` and report `capacityBound: null`.
- `hasRemoteNodes()` is true when at least one node is configured.
- `recordChannelFailure(id, reason)` increments `consecutiveFailures`; when the node is `online` and failures reach `NODE_DEATH_FAILURE_THRESHOLD` (2), it flips to `offline` with a `stateReason` naming the failure count. It returns the resulting state.
- `recordChannelSuccess(id)` resets `consecutiveFailures`, stamps `lastSeenMs`, and restores an `offline` node to `online`.
- `seen(id)` records a last-seen timestamp for staleness display only. The module docstring is explicit that staleness is advisory: "an idle node is never auto-offlined for silence, because no signal is expected from a node with no work."
- `bindActiveWorkers(source)` and `activeWorkers(nodeId)` hold the durable lease-derived usage. Until a source is bound, snapshots report zero rather than inventing a process-local count.

The docstring distinguishes *online* from *dispatch-eligible*: "online, channel healthy as far as this registry knows. Nodes start online; dispatch eligibility additionally requires a passing doctor preflight (durable, checked at placement)."

## How dispatch uses the scheduling contract

The [Dispatch domain](dispatch.md) is the primary upstream caller. Its manifest declares `dependsOn: [..., "scheduling"]` (`src/domains/dispatch/manifest.ts`), and its extension reads the contract with `context.getContract<SchedulingContract>("scheduling")` (`src/domains/dispatch/extension.ts:2647`).

**Budget preflight is recorded, not a denial gate.** When dispatch builds a reservation it calls `scheduling.preflight()` inside `reservationCapacitySnapshot` (`src/domains/dispatch/extension.ts:2812`) and stores `budget: { currentUsd: preflight.currentUsd, ceilingUsd: preflight.ceilingUsd }` on the `ReservationCapacitySnapshot` (`src/domains/dispatch/extension.ts:2833`). The reservation allocator in `src/domains/dispatch/reservation-store.ts` sums the recorded cost into `ReservationAllocation.budgetUsd`, but its comment is unambiguous: "Cost estimates remain recorded in the allocation, but do not deny useful work." So the session budget never stops a reservation; it is advisory.

**The hard per-request cost gate is separate.** `assertBudgetAdmitsRoute` (`src/domains/dispatch/extension.ts:2877`) computes a conservative route estimate and compares it to `req.routingIntent?.maxCostUsd`; if the estimate exceeds the intent ceiling it calls `denyDispatchForBudget`, which audits a denied `dispatch` tool call (`reasonCode: "budget-ceiling"`) and throws. This gate enforces the per-request intent ceiling, not the session budget from scheduling.

**The session budget surfaces as a `budget.alert` event.** The scheduling bundle subscribes to `BusChannels.DispatchEnqueued` in `createSchedulingBundle.start()` (`src/domains/scheduling/extension.ts`). On each enqueue it calls `evaluate()`, which syncs the budget from settings and reads `observability?.sessionCost()`, then emits `BusChannels.BudgetAlert` with `{ level, currentUsd, ceilingUsd }` whenever the verdict is not `"under"`. The `BudgetAlertPayload` docstring in `src/core/bus-events.ts` notes the event is "Informational in v0.x: scheduling never rejects the enqueue, so the interactive notice is the operator's only signal."

**Capacity sizing flows into placement.** Dispatch reads `scheduling.maxWorkers?.()` for the global capacity (`configuredGlobalCapacity`, `src/domains/dispatch/extension.ts:2885`) and `scheduling.localCapacity?.().limit` for the local node (`configuredLocalCapacity`, `src/domains/dispatch/extension.ts:2890`), falling back to resolving `fleet.concurrency` directly when the contract method is absent. It also reads `scheduling.ceilingUsd()` to expose `costCeilingUsd()` on the dispatch contract (`src/domains/dispatch/extension.ts:7615`), and binds the durable lease usage reader back into the registry with `scheduling.fleet?.bindActiveWorkers(createNodeLeaseUsageReader(...))` (`src/domains/dispatch/extension.ts:2739`).

## The dispatch-to-scheduling control flow

```mermaid
sequenceDiagram
    participant D as Dispatch (extension)
    participant S as Scheduling contract
    participant O as Observability
    participant R as Reservation store

    D->>S: preflight()
    S->>O: sessionCost()
    O-->>S: currentUsd
    S-->>D: { verdict, currentUsd, ceilingUsd }
    D->>R: reservationCapacitySnapshot(budget)
    R-->>D: record (budget recorded, not denied)
    D->>D: assertBudgetAdmitsRoute(intent maxCostUsd)
    Note over D: hard gate — per-request intent ceiling,
    separate from the session budget
```

## Data model

A `FleetNodeSnapshot` (in `src/domains/scheduling/cluster.ts`) is the registry's read shape for one machine: `id`, `host`, `kind: "local" | "ssh"`, `state: "online" | "offline"`, `stateReason`, `activeWorkers`, `maxWorkers`, `capacityBound` (which input bound `maxWorkers`, `null` for SSH nodes), `labels`, and `lastSeenAt`.

The local-capacity resolver returns a `LocalCapacity` of `{ limit, bound }` where `bound: "configured" | "cpu" | "memory" | "cgroup" | "cap"`. `describeLocalCapacity` renders a short phrase like `"memory-bound at 2"` for operator surfaces (it returns `null` for `"configured"` and `"cap"`).

## Focused tests

`tests/contracts/local-capacity.test.ts` is the contract-level guard for sizing. Representative cases:
- `resolveLocalConcurrency("auto", host({ availableMemoryBytes: 2.5 * GiB }))` asserts `limit: 1, bound: "memory"` (low-memory host clamps to one local worker).
- `resolveLocalConcurrency("auto", host({ cgroupAvailableBytes: 5 * GiB }))` asserts `limit: 3, bound: "cgroup"` (cgroup limit sizes before host memory).
- `resolveLocalConcurrency("auto", host({ cpus: 2 }))` asserts `limit: 2, bound: "cpu"`.
- `resolveLocalConcurrency("auto", host())` (32 CPUs / 64 GiB) asserts `limit: AUTO_MAX_WORKERS, bound: "cap"` (host fits the cap).
- `resolveLocalConcurrency(3, tiny)` asserts `limit: 3, bound: "configured"` (numeric setting is exact regardless of host facts).
- A sampler test ("does not lower the limit as Clio's own workers start") seeds 8 GiB / 0 workers → limit 6, then drops available memory by 5 worker estimates while raising active workers to 5 and advances the injected clock inside and past `intervalMs`; it asserts the limit stays 6 and that sampling happened only once per interval and once per worker add-back.
- A dispatch test ("admits SSH work past a clamped local node without shrinking the global pool") builds a dispatch bundle with `localCapacity: () => ({ limit: 1, bound: "memory" })`, then asserts `reservations.prepare` for two parallel local members throws `/node 'local' capacity exceeded \(2\/1\)/u` while three parallel SSH members on a node with `maxWorkers: 3` succeeds.

`tests/extended/fleet-lifecycle.test.ts` exercises the cluster registry's failure accounting. Its "places by durable usage and excludes a failed node on failover" case calls `createFleetRegistry(() => settings.fleet.nodes, { activeWorkers })`, then asserts that two consecutive `recordChannelFailure("blade", ...)` calls return `"offline"` on the second, and that the placement resolver then reroutes a failed node's work to another node with `reason: "node classified dead"`.

## Extension seams

- **Adding a node kind or a new sizing input:** the `resolveLocalConcurrency` candidate list in `src/domains/scheduling/local-capacity.ts` is the single place where a new `LocalCapacityBound` participates; add a candidate to the array and it competes for the minimum like the existing `cap`/`cpu`/`memory`/`cgroup` entries.
- **Changing how the session budget is scored:** `createBudgetState` and `checkCeiling` in `src/domains/scheduling/budget.ts` are the only place the `"under" | "at" | "over"` verdict is produced. The dispatch gate (`assertBudgetAdmitsRoute`) and the alert event (`extension.ts`) both consume that verdict, so a change there propagates to both.
- **New alert side-effects:** `createSchedulingBundle.start()` is the one subscription to `BusChannels.DispatchEnqueued`; the verdict logic lives in the `evaluate()` closure.
- **New per-node capability:** `FleetRegistryOptions` and `createFleetRegistry`'s `snapshotFor` are where a local node's capacity differs from an SSH node's declared capacity.

## Things to watch when editing

- **The session budget is advisory.** The `budget.ts` docstring and the `reservation-store.ts` comment both state that dispatch records the budget but does not deny from it. If you change the budget to gate reservations, you are changing the contract documented in two separate modules, and the `budget.alert` docstring in `src/core/bus-events.ts` ("scheduling never rejects the enqueue") stops being true.
- **`AUTO_MAX_WORKERS` is both the `auto` global pool and the local-node cap.** It is used as the first `cap` candidate in `resolveLocalConcurrency` and as the return of `resolveGlobalConcurrency` for `undefined`/`"auto"`. Raising it changes the global pool and the auto local node together.
- **`WORKER_MEMORY_ESTIMATE_BYTES` is doubled in effect.** It is the divisor in `workersFor` and the add-back multiplier in `createLocalCapacitySampler.resolve`. The sampler test relies on the add-back preserving the limit, so changing one without the other breaks that invariant.
- **`NODE_DEATH_FAILURE_THRESHOLD` (2) is a consecutive-failure counter.** It resets only on `recordChannelSuccess`. A node flapping between success and failure never accumulates, which is the intended behavior, not a bug to "fix" with a sliding window.
- **Node config is read live via the `getNodes` thunk.** The registry does not cache node settings; it calls `getNodes()` on every `list()`, `get()`, `config()`, and `hasRemoteNodes()`. Do not memoize the settings array outside the registry expecting the registry to see a later settings edit.

<!-- clio-coder:wiki unresolved links: domains/dispatch.md -->
