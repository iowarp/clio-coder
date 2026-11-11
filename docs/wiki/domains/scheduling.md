---
title: "Scheduling: budget gating, local capacity, fleet registry and recurring jobs"
summary: "The scheduling domain owns the session spend ceiling that gates paid requests, the local and global worker limits, the fleet node registry, and the durable recurring-job controller. Read this page before changing any of those behaviors."
sources:
  - "src/domains/scheduling/index.ts"
  - "src/domains/scheduling/extension.ts"
  - "src/domains/scheduling/contract.ts"
  - "src/domains/scheduling/budget.ts"
  - "src/domains/scheduling/local-capacity.ts"
  - "src/domains/scheduling/cluster.ts"
  - "src/domains/scheduling/job-controller.ts"
  - "src/domains/scheduling/job-model.ts"
  - "src/domains/scheduling/job-store.ts"
  - "src/domains/scheduling/manifest.ts"
symbols:
  - "createSchedulingBundle"
  - "createSchedulingDomainModule"
  - "createBudgetState"
  - "sessionCeilingReached"
  - "SessionCostCeilingError"
  - "resolveLocalConcurrency"
  - "createLocalCapacitySampler"
  - "createFleetRegistry"
  - "createJobController"
  - "createJobStore"
  - "normalizeJobSpec"
  - "matchesJobPredicate"
tests:
  - "tests/contracts/telemetry-budget-records.test.ts"
  - "tests/contracts/local-capacity.test.ts"
  - "tests/contracts/job-tool.test.ts"
invariants:
  - "A session ceiling of 0 means no ceiling; admitPaidRequest returns without a flush or seed when the effective ceiling is 0."
  - "With a positive ceiling, a paid request whose settled spend plus additional cost reaches the ceiling is held until a ceiling raise, or rejected with SessionCostCeilingError when waitForRaise is false."
  - "A numeric fleet.concurrency setting is used exactly for the global pool and the local node; under auto, the local limit is the minimum of the 8-worker cap, usable CPUs, and memory-derived limits."
  - "A fleet node is classified offline after two consecutive channel failures and returns online on the next channel success."
  - "A stored job record whose specification hash or normalized specification does not match is rejected on read, and a job from a different owner session or workspace is not returned by scoped lookups."
validate:
  - "pnpm run test:file -- tests/contracts/local-capacity.test.ts"
  - "pnpm run test:file -- tests/contracts/telemetry-budget-records.test.ts"
  - "pnpm run test:file -- tests/contracts/job-tool.test.ts"
---

# Scheduling: budget gating, local capacity, fleet registry and recurring jobs

The scheduling domain is the part of Clio Coder that decides whether the next paid model request or worker dispatch may proceed. A reader needs this page when changing the session spend ceiling, the `fleet.concurrency` worker limit, the fleet node registry that dispatch places work against, or the recurring job controller that runs `job` tool schedules. Routing for the tool surface that drives jobs is covered in [tools.md](../tools.md), and the dispatch consumers are covered in [domains/dispatch.md](dispatch.md).

## What the domain does

The domain is wired by `createSchedulingBundle` in `src/domains/scheduling/extension.ts`, which returns a `DomainBundle<SchedulingContract>`. The bundle exposes four groups of behavior through `SchedulingContract` (`src/domains/scheduling/contract.ts`):

1. Budget gating: `ceilingUsd`, `preflight`, `admitPaidRequest`, `setRunCostCap`, and `runCostCap`.
2. Worker capacity: `maxWorkers` and `localCapacity`.
3. Fleet state: the `fleet` registry.
4. Recurring jobs: `createJobController` and `createJobStore` are exported from `src/domains/scheduling/index.ts` and are used by the entry layer, not by the bundle contract itself.

The manifest in `src/domains/scheduling/manifest.ts` declares the domain as `name: "scheduling"` with `dependsOn: ["config", "telemetry"]`. The bundle throws at construction if the `config` contract is absent.

## Ownership by file

| Path | Responsibility | Key symbols |
| --- | --- | --- |
| `src/domains/scheduling/index.ts` | Public barrel; exposes `SchedulingDomainModule` and `createSchedulingDomainModule`. | `SchedulingDomainModule`, `createSchedulingDomainModule` |
| `src/domains/scheduling/extension.ts` | Composes budget, capacity sampler, fleet registry and admission. | `createSchedulingBundle`, `SchedulingBundleOptions` |
| `src/domains/scheduling/contract.ts` | Type of the contract consumers import. | `SchedulingContract`, `BudgetPreflight` |
| `src/domains/scheduling/budget.ts` | Ceiling arithmetic, run caps, stop-text rendering, the stop error class. | `createBudgetState`, `sessionCeilingReached`, `runCostCeilingUsd`, `createRunCostCap`, `SessionCostCeilingError`, `readBudgetBlock`, `describeBudgetBlock` |
| `src/domains/scheduling/local-capacity.ts` | Resolves `fleet.concurrency` for the local node and the global pool. | `resolveGlobalConcurrency`, `resolveLocalConcurrency`, `createLocalCapacitySampler`, `describeHostCapacity` |
| `src/domains/scheduling/cluster.ts` | Fleet node registry with per-node online/offline state. | `createFleetRegistry`, `FleetRegistry`, `LOCAL_NODE_ID` |
| `src/domains/scheduling/job-controller.ts` | Recurring job state machine: admission, execution, settlement, recovery, control. | `createJobController` |
| `src/domains/scheduling/job-model.ts` | Pure job normalization, predicates, evidence shaping and timeouts. | `normalizeJobSpec`, `jobEvidence`, `matchesJobPredicate`, `jobExecutionTimeoutMs`, `jobIsComplete` |
| `src/domains/scheduling/job-store.ts` | Per-session JSON job store with a file lock and revision check. | `createJobStore`, `validateRecord` |

The public types for jobs live in `src/domains/scheduling/job-types.ts`, which the barrel re-exports with `export type *`. This page does not read that file in depth; its field names are used here only as they appear in `src/domains/scheduling/job-controller.ts` and `src/domains/scheduling/job-model.ts`.

## Budget gating

### Entry and state

`createSchedulingBundle` reads the initial ceiling from `config.get().safety.limits.sessionCostUsd` and creates a `BudgetState` with `createBudgetState`. `syncBudget` re-reads the ceiling on every check, from the `getSettings` option when provided and from the config snapshot otherwise, and rebuilds the state when the value changes. The comment in `src/domains/scheduling/extension.ts` explains why `getSettings` exists: a session override such as the `clio-coder run --max-cost-usd` ceiling lives in the session's effective settings view, not in the config snapshot.

`createBudgetState` (in `src/domains/scheduling/budget.ts`) rejects a negative initial ceiling and returns a `BudgetState` whose `checkCeiling` returns `"under"` when the ceiling is 0, `"over"` above it, `"at"` on equality, and `"under"` otherwise.

### Admission flow for a paid request

`admitPaidRequest` is the gate paid calls go through. Its caller passes `waitForRaise`, an optional `additionalUsd` (a number or a function), `getCeilingUsd`, `contextTokens`, `onBlocked`, `telemetry` and `signal`. The control flow inside its `for (;;)` loop is:

1. `syncBudget()` and read the ceiling, from `getCeilingUsd` when supplied.
2. If the ceiling is positive, read `settledSpend()`. This calls `telemetry.settledSessionSpend()` so the read model is flushed before the comparison. A zero ceiling skips this read entirely.
3. Re-read `additionalUsd`, then compute `spend = settled + additional`.
4. If `sessionCeilingReached(spend, ceilingUsd)` is false, the request is admitted. If a hold was in progress, `recordHold` journals the outcome as `raised`, `cleared` or `removed`, and the function returns.
5. Otherwise, if `signal` is already aborted, the hold is journaled as `aborted` and the signal reason is thrown.
6. On the first block, a `BudgetAlertPayload` is built, passed to `onBlocked`, emitted on the bus as `budget.alerted`, and a `budget.crossed` telemetry event is emitted at most once per session and ceiling value.
7. If `waitForRaise` is false, the hold is journaled as `refused` and a `SessionCostCeilingError` is thrown.
8. If `waitForRaise` is true, the loop waits 250 ms (honoring abort) and retries from step 1.

`sessionCeilingReached` in `src/domains/scheduling/budget.ts` returns false whenever the ceiling is 0, so zero means no ceiling everywhere it is read.

The raise attribution inside `recordHold` uses `ceilingChange`, which is set by a listener on `config.onChange("hotReload", ...)` and on the `config.session_changed` bus event, both wired in `start()`. A raise is attributed to a source only when the change's ceiling matches the raised value and the change arrived after the hold began. Otherwise the event carries no `raisedBy`, which the code comments state explicitly.

### Error and stop text

`SessionCostCeilingError` has `name` set to `"SessionCostCeilingError"` and a message that begins with the reason string `budget_ceiling`. When a `RunCostCap` is supplied and the ceiling is at or above the cap's ceiling, the message names the `--max-cost-usd` cap; otherwise it names `safety.limits.sessionCostUsd`. `describeBudgetBlock` builds the operator notice for a stop, with level `"warn"` for `at` and `"error"` for `over`.

### Existing test coverage

`tests/contracts/telemetry-budget-records.test.ts` exercises this path end to end against the scheduling contract. The first case holds a call with `waitForRaise: true` and `contextTokens: 900`, then changes the settings ceiling to 5 through the change listener with source `settings-ui`; the test asserts that the held call's `budget.held` record has `outcome: "raised"`, `raisedToUsd: 5`, `raisedBy: "settings-ui"`, and a positive `waitedMs`. A subsequent call with `waitForRaise: false` against a ceiling of 1 with spend 1.25 is asserted to be refused, and the `budget.crossed` record is asserted to carry `level: "over"`, `spendUsd: 1.25`, `ceilingUsd: 1` and `contextTokens: 900`. A second test in the same file (around its `stop` helper) asserts the admitted-or-rejected message for paid calls that do not wait.

## Worker capacity

### Global pool and local node

`resolveGlobalConcurrency` in `src/domains/scheduling/local-capacity.ts` returns `AUTO_MAX_WORKERS` (8) when the setting is absent or `"auto"`, and otherwise `Math.max(1, Math.floor(configured))`.

`resolveLocalConcurrency` returns the configured number as `{ limit, bound: "configured" }` when the setting is numeric. Under `auto` it builds candidates: the 8-worker cap, the usable CPU count, the memory-derived limit from `availableMemoryBytes + clioHeldBytes`, and, when `cgroupAvailableBytes` is not null, a cgroup-derived limit. It returns the smallest candidate, and ties keep the earlier candidate, so the cap wins on a host that fits it. The memory limit uses `workersFor(bytes, reserve) = max(1, floor((bytes - reserve) / 1 GiB estimate))` with the 2 GiB `OS_MEMORY_RESERVE_BYTES`; the cgroup limit uses the 512 MiB `CGROUP_MEMORY_RESERVE_BYTES`.

`createLocalCapacitySampler` caches a host sample for `HOST_SAMPLE_INTERVAL_MS` (30 seconds by default). Each sample stores the count of active local workers at sampling time, and `resolve` adds `activeWorkers * WORKER_MEMORY_ESTIMATE_BYTES` back to the memory facts before resolving. This is why the local limit does not shrink as Clio's own workers start.

`describeHostCapacity` produces the operator sentence and states explicitly that GPU, VRAM and model fit are not checked.

### Bundle wiring

Inside `createSchedulingBundle`, the sampler is created with `activeLocalWorkers: () => fleet.activeWorkers(LOCAL_NODE_ID)`, and the fleet registry is created with a `localCapacity` callback that calls the sampler. The contract's `maxWorkers` returns the global pool and `localCapacity` returns the local resolution. Both read `config.get().fleet.concurrency` at call time.

### Existing test coverage

`tests/contracts/local-capacity.test.ts` covers the resolver directly. Its cases include `resolveLocalConcurrency("auto", host({ availableMemoryBytes: 2.5 * GiB }))` clamped to one worker, a cgroup limit of 5 GiB sizing before host memory, a CPU count of 2 clamping the result, and `resolveLocalConcurrency(3, tiny)` returning `{ limit: 3, bound: "configured" }` regardless of host facts. A further case checks that the sampler does not lower its limit as Clio's own workers start, and another that an SSH node stays unclamped while the local node is clamped. One case gives `observeHostCapacityFacts` a fake cgroup tree with `cpu.max` files: the usable CPU count is the affinity count capped by the tightest quota/period, rounded up, from the process's cgroup up to `cgroupRoot` (default `/sys/fs/cgroup`), and `max` sets no cap. Two cases give `observeHostCapacityFacts` a fake cgroup directory: with `memory.stat` the headroom is `memory.max - (anon + shmem + kernel)`, checked against two samples of a 7 GiB container that size four CPU-bound workers, and without it the probe falls back to `process.availableMemory()`. The other tests use injected host facts, not real host sampling.

## Fleet registry

`createFleetRegistry` in `src/domains/scheduling/cluster.ts` keeps an in-memory `Map` of runtime state per node id. The node configuration is read through the `getNodes` callback on every call, so settings edits apply to the next dispatch. `list()` returns the implicit local node first and then each configured SSH node.

Channel health is tracked by `recordChannelFailure` and `recordChannelSuccess`. Two consecutive failures (`NODE_DEATH_FAILURE_THRESHOLD = 2`) move an online node to offline and set `stateReason` to a message naming the failure count and the reason. `recordChannelSuccess` resets the failure count, updates `lastSeenAt`, and moves an offline node back to online. The comment in `src/domains/scheduling/cluster.ts` states that idle nodes are not auto-offlined for silence; staleness is advisory only.

`activeWorkers` is not owned here. The registry reports zero until a dispatch-side source is bound through `bindActiveWorkers`, and the comment on that method says dispatch owns the capacity leases.

For an SSH node, `snapshotFor` attaches `verification` from `fleetPreflightVerdict` in `src/domains/dispatch/fleet-preflight.ts`. That call is a dispatch import; this page does not read it.

## Recurring jobs

### Spec normalization

`normalizeJobSpec` in `src/domains/scheduling/job-model.ts` is the only constructor of a job specification. It rejects unknown keys, requires `intervalMs` between 1000 and the 31-day maximum, accepts a `command` runner (with `argv` of 1 to 128 literal strings and an optional `executableSha256`) or a `main` runner (with a prompt up to 8192 bytes), and rejects any other runner kind. `count` defaults to 5 when no `deadlineAt` is given, and to null otherwise. `timeoutMs` defaults to 60 seconds for command runners and to one hour for main runners.

A typed JSON `until` predicate is only permitted with a command runner. An `onMatch` of `main_turn` requires that a predicate is present. `jobSpecHash` is the SHA-256 of the JSON-serialized normalized spec.

`matchesJobPredicate` walks `predicate.path` through own properties and then applies `exists`, `eq`, `ne`, or ordered comparisons, which apply only to finite numbers.

### Controller lifecycle

`createJobController` in `src/domains/scheduling/job-controller.ts` holds an in-memory `records` map, a `live` map of running executions, and a single `setTimeout` timer driven by `schedule()`. Its public `JobController` API is `create`, `control`, `list`, `get`, `recover`, `retire`, `close`, and `tick`.

Creation flows as follows. `create` normalizes the owner (the `cwd` must be absolute and is resolved with `realpathSync`), calls `recover(owner)` to load and classify persisted rows, normalizes the spec, builds a `JobRecord` with `state: "active"` and `nextDueAt: createdAt`, runs `authorization(job, "create")`, and only then sets `nextDueAt` to the current time and calls `store.write(job, null)`. The comment in the code states that the first run is due immediately after admission and never before it.

`tick` is the scheduling loop. For each owned, non-cleanup-blocked record it enforces the deadline, enforces the execution timeout by setting `clockExpired` and aborting the live execution with `JobClockExpired`, pauses records whose owner is no longer current, reserves a new `pending` occurrence when `nextDueAt` has passed, and launches a `delivery` or `run` execution when no execution is live and retry backoff permits.

`launch` checks capacity before starting. A command-runner occurrence is denied when any owned record has unresolved cleanup. Main-turn occupancy is limited to one per owner; command occupancy is limited to two. When capacity is full, the job is set to `wait` and retried after `POLL_MS` (250 ms). Otherwise the controller calls `options.ports.admit`, then `options.ports.run` or `options.ports.deliver`. The runner acknowledges start through `context.start`, which calls `startExecution` and commits `state: "running"` before the job's `starts` counter increments.

`settle` produces the evidence and moves the record. Its branches, in order, are: a non-started execution is re-queued or denied; a `deferred` outcome after start becomes `failed`; an identical successful command result against the prior successful occurrence is recorded as `noop`; a clock-expired run may queue a single `clockResume`, bounded by `JOB_CLOCK_RESUME_CAP` (1). A matching `until` predicate on a succeeded or noop run with complete JSON sets `reason: "condition"` and queues a delivery. Otherwise a count-exhausted record becomes `terminal`; a `permission` error pauses; an `infrastructure` error or a `timed_out` outcome increments `consecutiveFailures`, pauses after three, and otherwise schedules retry at the greater of the interval, an exponential backoff capped at 300 seconds, and `retryAfterMs`.

`recover` reads the store for an owner and classifies each stored record whose `process.instanceId` is not this controller's. A record whose owning process is not alive, judged by `processAlive` and `processBirthToken`, is committed as `paused` with `pendingReason: "owner exited; explicit resume required"`. An interrupted active occurrence is recorded in history as `interrupted`, and a running delivery is marked `failed` and not replayed.

`control` implements `cancel`, `stop`, `pause` and `resume`. Resume is refused when a live execution exists, when the record's reason is terminal and not `condition`, or when count is exhausted. Resume runs `authorization` again and bumps `generation` so any in-flight execution from the prior generation settles without advancing the job.

### Persistence

`createJobStore` in `src/domains/scheduling/job-store.ts` keeps one JSON file per session-and-cwd pair. The file name is the SHA-256 of `[sessionId, cwd]`, and the directory is `join(clioStateDir(), "jobs")` unless `rootDir` is supplied. `read` enforces an 8 MiB file limit and a 32-job limit per session, and `validateRecord` re-validates every stored record: the spec must re-normalize to the stored spec with the same hash, the history cannot exceed `JOB_HISTORY_LIMIT` (10), and each record must be under 256 KiB.

`write` runs under `withStateFileLockSync` with a 100 ms timeout. It compares the stored record's `revision` with `expectedRevision`, rejects a changed `specHash` or `createdAt`, and rejects a new record when the session holds 32 jobs and no complete job can be evicted. The file is written with `safeResourceWrite` at mode `0600`.

`createJobController` calls `store.write(draft, job.revision)` inside `commit`. A persistence failure keeps the prior in-memory revision, sets `persistenceError`, suspends execution for that record, and rethrows.

### Callers

Entry-layer callers are `src/entry/job-host.ts` and `src/entry/orchestrator.ts`, and `src/tools/job.ts` is the tool surface. `src/session-control/turn-runtime.ts` and `src/session-control/chat-loop.ts` also reference the controller, as does `src/domains/dispatch/extension.ts`. This page did not trace those callers line by line, so their wiring is described here only by the reference list above.

### Existing test coverage

`tests/contracts/job-tool.test.ts` is the focused test for the job tool surface and was located by search for `createJobController`; this page did not read its cases, so no assertion from it is cited here. Searching across `tests/` for `createJobController`, `createJobStore`, and `admitPaidRequest` returned the six files listed above; the three cited in the frontmatter were read at the level of their matched lines only.

## Things to watch when editing

- Zero means no ceiling for `sessionCostUsd`, and `sessionCeilingReached` and `createBudgetState.checkCeiling` both depend on that. Any new comparison against the ceiling must go through these helpers, as the `src/domains/scheduling/budget.ts` comments direct.
- `admitPaidRequest` reads `additionalUsd` after the settled-spend read on every retry. Moving that read before the settled fold can count a settling call twice; the code comment at that site describes the intended order.
- `ceilingChange` attribution only applies when the change timestamp is at or after the hold start. A change that arrives earlier is not credited to the hold, and an unexplained raise is recorded without `raisedBy`.
- The job store's file layout and `validateRecord` are an integrity boundary. A schema change to `JobRecord` requires updating `validateRecord` in `src/domains/scheduling/job-store.ts`, or stored records fail to load.
- `FleetRegistry` runtime state is in memory. Offline classification does not persist across processes. Durable capacity is owned by the dispatch domain, as the file header comment states.
- The 250 ms wait in `admitPaidRequest` is a polling interval, not an event subscription. Changing it changes how quickly a raise is noticed.
