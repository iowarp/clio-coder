---
title: "Domains observability"
summary: "The observability domain folds dispatch bus events, session cost tracking, and forensic evidence builds into a single bounded snapshot consumed by product surfaces. It owns the live projection, the SQLite trace mirror, the cost tracker, and the out-of-turn usage ledger."
sources:
  - "src/domains/observability/index.ts"
  - "src/domains/observability/extension.ts"
  - "src/domains/observability/projection.ts"
  - "src/domains/observability/contract.ts"
  - "src/domains/observability/cost.ts"
  - "src/domains/observability/trace-store.ts"
  - "src/domains/observability/worker-progress.ts"
  - "src/domains/observability/out-of-turn-usage.ts"
  - "src/domains/observability/evidence-index.ts"
tests:
  - "tests/contracts/observability-wiring.test.ts"
  - "tests/contracts/trace-store-legacy-tables.test.ts"
invariants:
  - "Bus listeners stay cheap: each handler only mutates in-memory state and marks the projection changed; the actual snapshot build and listener fan-out happen on a 16 ms debounce."
  - "Worker progress retains only bounded answer text and redacted action descriptors; tool arguments and reasoning content are never stored."
  - "Terminal history and notices are bounded (MAX_PROJECTION_RUNS=50, MAX_PROJECTION_NOTICES=100); active runs remain until settlement."
  - "The trace SQLite mirror is a best-effort operator projection: dispatch correctness never depends on it."
  - "Out-of-turn usage rows are appended with one writeSync per line and a bound-check every 64 appends."
validate:
  - "pnpm run test:file -- tests/contracts/observability-wiring.test.ts"
  - "pnpm run test:file -- tests/contracts/trace-store-legacy-tables.test.ts"
---

# Domains observability

The observability domain is the single point where dispatch activity, session cost, and forensic
evidence converge into a product-facing read model. It listens to the dispatch event bus channels
(`DispatchEnqueued`, `DispatchStarted`, `DispatchProgress`, `DispatchCompleted`, `DispatchFailed`,
`RunAborted`, `AccountabilityEvidenceReady`), folds their payloads into an in-memory projection and
a SQLite trace mirror, and exposes a bounded snapshot through the `ObservabilityContract` interface.
Product surfaces (the TUI footer, the dispatch board, `/usage` overlay, quota views, and the
`monitor` tool) read the snapshot through that contract; the domain never imports another domain's
`extension.ts` (per repository hard invariant 4).

## Ownership and entry points

The domain module is declared in `src/domains/observability/index.ts` as
`ObservabilityDomainModule`, which the domain loader instantiates via
`createObservabilityBundle` from `src/domains/observability/extension.ts`. The manifest
(`src/domains/observability/manifest.ts`) declares `dependsOn: ["providers", "session"]`, keeping
dispatch out of `dependsOn` so scheduling can sit between observability and dispatch without a
topological cycle.

Key entry points and their files:

| Symbol | File | Role |
|---|---|---|
| `createObservabilityBundle` | `src/domains/observability/extension.ts` | Composes cost tracker, projection, trace mirror, and bus listeners |
| `createObservabilityProjection` | `src/domains/observability/projection.ts` | Reactive read model over bus events |
| `createCostTracker` | `src/domains/observability/cost.ts` | Running USD cost and token accumulator |
| `createDispatchTraceMirror` | `src/domains/observability/trace-store.ts` | Async-enqueued SQLite writer for dispatch events |
| `TraceStore` / `TraceReader` | `src/domains/observability/trace-store.ts` | Durable and read-only SQLite access |
| `createWorkerProgressFold` | `src/domains/observability/worker-progress.ts` | Bounded, redacted live-progress projection |
| `appendOutOfTurnUsageRow` / `readOutOfTurnUsageRows` | `src/domains/observability/out-of-turn-usage.ts` | Durable JSONL ledger for side questions, handoffs, prewarming |
| `summarizeEvidenceIndex` | `src/domains/observability/accountability.ts` | Pure aggregation over evidence index rows |
| `recordBackgroundMemoryStep` | `src/domains/observability/background-memory-usage.ts` | Dual-write for background memory steps |

## The `ObservabilityContract` and snapshot shape

The contract (`src/domains/observability/contract.ts`) is the interface other domains read. It
extends `ObservabilityRunProjection` (bind/dispose readers, `reconcileRuns`, `setFleetPhase`) and
adds:

- **Session cost**: `sessionCost()`, `sessionCostSummary()`, `costEntries()`, `resetSession()`,
  `recordTokens()`, `recordTokenThroughput()`.
- **Snapshot**: `snapshot()` returns a fresh `ObservabilitySnapshot` with `generatedAt`,
  `session` (cost, tokens, latest throughput), `runs` (newest-first), `notices`, and
  `pendingEvidenceBuildRunIds`.
- **Subscription**: `subscribe(listener)` fires immediately with the current snapshot, then on
  each coalesced change (16 ms debounce via `PROJECTION_FLUSH_DEBOUNCE_MS`).

The `ObservabilityRunSummary` type carries the full lifecycle for one run: status, identity
(agent, target, model, runtime), task summary, budget, TTFT, gate/council badges, endpoint
capacity, host verification, trust, retry state, steer acknowledgement, write-record downgrade,
phase/wave, timing, tokens, cost with provenance, outcome detail, and evidence reference.

## Control flow through an actual caller

### Dispatch board (`src/interactive/dispatch-board.ts`)

The dispatch board consumes `ObservabilityContract.snapshot()` to render live run rows. It reads
`runs: readonly ObservabilityRunSummary[]` from the snapshot, maps each entry to a
`DispatchBoardRow`, and renders status, elapsed time, tokens, cost, progress, and evidence state.
The board also reads `notices` to surface evidence-build failures: the test in
`tests/contracts/observability-wiring.test.ts` ("evidence build failure") constructs a projection,
calls `projection.evidenceBuildFailed("run-proof", "disk full while writing the bundle")`, and
verifies the dispatch board renders "failed" with the reason message.

### Footer panel (`src/interactive/footer-panel.ts`)

The footer reads `session.tokens` (`UsageBreakdown`) from the snapshot to render the token
counter, and `session.latestThroughput` (`TokenThroughputSnapshot`) to render the speed row.
`tokensSegment` returns `null` when no usage has landed; `throughputSegment` returns `null` when
tokens-per-second is zero or non-finite.

### Trace mirror and session turns

The `DispatchTraceMirror` interface (`src/domains/observability/trace-store.ts`) exposes
`enqueue(channel, payload)`, `enqueueSessionTurn(trace)`, `flush()`, and `close()`. The extension
subscribes to the five dispatch bus channels and forwards each payload. `enqueueSessionTurn`
accepts a `SessionTurnTrace` (start/event/finish triple) that mirrors the operator's own chat-loop
turns into the same SQLite tables as dispatched runs, using the sentinel
`SESSION_TRACE_ASSIGNMENT_ID = "session"` in the `assignment_id` column and `source = 'session'`.

## Extension wire-up and lifecycle

`createObservabilityBundle` (`src/domains/observability/extension.ts`) performs:

1. **Cost tracker creation**: `createCostTracker()` from `cost.ts`.
2. **Trace mirror creation**: `createDispatchTraceMirror(traceDatabasePath(clioStateDir()))`
   unless `options.dispatchTrace === false`. The mirror lazily opens SQLite on first write.
3. **Projection creation**: `createObservabilityProjection(context.bus, deps)` where `deps`
   provides session cost summary, tokens, and latest throughput as accessors (read at
   snapshot-build time, not cached).
4. **Bus subscriptions** (in `start()`):
   - Five dispatch channels → `trace.enqueue(channel, payload)`.
   - `DispatchCompleted` → `recordDispatchCost(cost, payload)` + `trackBuild(runId, true, attempt)`.
   - `DispatchFailed` → `recordDispatchCost(cost, payload)` + `trackBuild(runId, false, attempt)`
     (only if `dispatchHasEvidenceLedger(payload)` is true, i.e., `payload.lineage !== undefined`).
5. **Stop sequence** (in `stop()`):
   - Unsubscribe all bus handlers.
   - `projection.stop()` (clears listeners and pending flush timer).
   - `await trace.close()` (flushes the write queue and closes SQLite).
   - `await Promise.allSettled(pendingBuilds)` (flushes in-flight forensic builds).

The evidence build is best-effort: `buildAndIndexEvidence` catches all failures, logs them to
stderr via `writeDiagnostic`, and invokes `hooks.onFailed`. The `pendingBuilds` set tracks in-flight
promises so `stop()` can await them, ensuring a headless one-shot `clio-coder run` does not abandon
a build mid-flight.

## Cost tracking

`createCostTracker` (`src/domains/observability/cost.ts`) returns a `CostTracker` with:

- `accumulate()`: pushes a `CostEntry` to the log and updates running totals. The `label`
  parameter distinguishes non-ordinary-turn calls (`"side-question"`, `"handoff"`, `"prewarm"`,
  `"background-memory"`, `"failed-compaction"`).
- `sessionCost()`: returns a `CostAggregate` with `knownUsd`, `hasEstimated`, `hasUnknown`,
  `allKnownFree`, and `calls` count. The `calls` field distinguishes "zero calls" from "one free
  call" (both reduce to `knownUsd: 0` without it).
- `sessionTokens()`: returns the cumulative `UsageBreakdown`.
- `reset()`: clears all state.

Formatting is centralized: `formatCostAggregate` returns `null` when nothing has been measured
(`costWasMeasured` is false), `"not measured"` via `COST_NOT_MEASURED` for fixed-width surfaces,
and rendered values with provenance markers (`~...est` for estimated, `+?` for unknown).

## Worker progress fold

`createWorkerProgressFold` (`src/domains/observability/worker-progress.ts`) is a pure, bounded
projection of a worker's live stream. Three enforcement rules:

1. **No tool arguments**: `tool_execution_*` events (which carry `args`) are not read; tool names
   come from `clio_coder_tool_*` telemetry and `CallActionDescriptor` from the safety domain.
2. **No reasoning content**: `thinking_delta` moves the phase to `"thinking"` and nothing else.
3. **Bounded retention**: live tail is capped at `WORKER_LIVE_TAIL_LINES = 40` lines and
   `WORKER_LIVE_TAIL_MAX_BYTES = 4096` bytes; the action trail is capped at
   `WORKER_ACTION_TRAIL_LIMIT = 4`; tool names at `WORKER_TOOL_NAME_LIMIT = 8`; delta bytes at
   `WORKER_PROGRESS_WINDOW_BYTES = 16384` per 250 ms window.

The `observe(event, nowMs)` method returns `true` when the snapshot changed, allowing callers to
skip repaints. `settle(text?)` replaces the live tail with the receipt-sealed answer (bounded by
`WORKER_OUTPUT_MAX_BYTES` from the dispatch domain). `restart()` clears attempt-specific state
while preserving the tail and trail (which the operator is already reading).

## Trace store: SQLite mirror

`TraceStore` (`src/domains/observability/trace-store.ts`) writes to a WAL-mode SQLite database at
`<stateDir>/trace.sqlite`. Schema version 1 (`TRACE_SCHEMA_VERSION = 1`) defines tables:
`meta`, `runs`, `phases`, `events`, `gate_results`, `agent_sessions`, `processes`.

Key behaviors:

- **Retention pruning**: `prune()` removes terminal runs older than `maxAgeDays` (default 30)
  and, if the database exceeds `maxBytes` (default 128 MiB), the oldest terminal runs until the
  page set fits. `VACUUM` runs when ≥20% of pages are free.
- **Abandoned-run reconciliation**: on open, `reconcileAbandonedRuns` marks `running` rows whose
  owner process (pid + birth token on the same host) is provably dead as `fail`.
- **Migration**: additive columns (`host`, `birth_token` on `processes`; `source` on `runs`;
  `cache_write_1h_tokens` on `phases`) are added in-place for older databases. The `source`
  column backfills from the `SESSION_TRACE_ASSIGNMENT_ID` sentinel.
- **Read-only reader**: `TraceReader` opens the database read-only and derives `runs.source`
  from the sentinel when the column is absent (pre-migration databases).

The `createDispatchTraceMirror` factory wraps `TraceStore` in an async write queue
(`setImmediate` chain) with a `TRACE_WRITE_QUEUE_LIMIT = 2048` backpressure bound: non-critical
progress events are dropped when the queue is full, and the drop count is reported on
`flush()`/`close()`.

## Out-of-turn usage ledger

`out-of-turn-usage.ts` records priced model calls that were billed beside a session rather than
inside it: `/btw` side questions, `/handoff` extraction rounds, session prewarming, background
memory steps, and failed compaction rounds. Each row is one JSON line under
`<stateDir>/usage/out-of-turn.jsonl`.

- **Append**: `appendOutOfTurnUsageRow` uses append-mode `writeSync` per line; the
  `options.required` flag (used by failed-compaction) flushes and throws on incomplete writes.
- **Bound**: every `BOUND_CHECK_INTERVAL = 64` appends, `boundOutOfTurnUsageFile` rewrites the
  file to the newest `MAX_OUT_OF_TURN_USAGE_ROWS = 1000` lines under the state-file lock.
- **Read**: `readOutOfTurnUsageRows` is tolerant; malformed lines are reported as errors and
  skipped, never fatal.
- **Call outcome**: `failed-compaction` rows require `callOutcome`; `prewarm` rows record it
  optionally. The reader preserves the outcome for these labels and treats unknown usage as
  `null` (not `0`), so a failed prewarm is not read back as a zero-cost success.

## Evidence index

`evidence-index.ts` maintains a JSON array under `<stateDir>/evidence-index.json` as a bounded
ring (`MAX_EVIDENCE_INDEX_ROWS = 1000`). `writeEvidenceIndexRowQueued` merges by `runId`
(replacing stale entries on retry) and rewrites atomically via `safeResourceWrite`. The
accountability read model (`summarizeEvidenceIndex` in `accountability.ts`) folds the index into
first-pass-success rate and failure-cause histogram without re-running `buildEvidence`.

## Upstream callers and downstream dependencies

**Upstream callers** (from `code_nav` dependents):
- `src/cli/fleet.ts`, `src/cli/run.ts`, `src/cli/bootstrap-generate.ts`, `src/cli/wiki-generate.ts`
- `src/entry/orchestrator.ts`
- `src/interactive/dispatch-board.ts`, `src/interactive/footer-panel.ts`,
  `src/interactive/footer/dashboard.ts`, `src/interactive/footer/pages.ts`,
  `src/interactive/footer/widgets.ts`, `src/interactive/interactive-application.ts`,
  `src/interactive/usage-overlay.ts`, `src/interactive/quota-view.ts`,
  `src/interactive/overlay-general-openers.ts`, `src/interactive/view/artifacts.ts`
- `src/tools/monitor.ts`

**Downstream dependencies**:
- `src/domains/providers/index.ts` — `CostProvenance`, `normalizeCostProvenance`, `resolveCostProvenance`
- `src/domains/dispatch/budget-envelope.ts` — `RunToolBudgetEnvelope`, `cloneRunToolBudgetEnvelope`
- `src/domains/dispatch/contract.ts` — `DispatchSnapshot` (read-only, via `ObservabilityRunReaders`)
- `src/domains/dispatch/types.ts` — `DispatchRequestOrigin`, `RunKind`
- `src/domains/evidence/index.ts` — `buildEvidence`, `EvidenceTag`, `FAILURE_CAUSE_TAGS`
- `src/domains/evidence/redact.ts` — `createRedactionTally`, `redactSecretsText` (trace store)
- `src/domains/evidence/trust-projection.ts` — `summarizeTrustStatus`
- `src/domains/safety/call-target.ts` — `sanitizeCallTargetText`, `CallActionDescriptor`
- `src/core/bus-events.ts` — `BusChannels`, dispatch payload types
- `src/core/event-bus.ts` — `SafeEventBus`
- `src/core/xdg.ts` — `clioDataDir`, `clioStateDir`

## Named focused tests

### `tests/contracts/observability-wiring.test.ts`

Four test cases demonstrate concrete wiring:

1. **"gives a claude-sdk worker, which emits only the Clio frames, a row with its duration"**:
   Feeds `clio_coder_tool_start` + `clio_coder_tool_finish` events (no engine frames) through
   `createDispatchTraceMirror`, reads the SQLite with `TraceReader`, and asserts the
   `tool_call` row carries `duration_ms: 5`, `ok: false`, and timestamps derived from the
   worker-reported duration.

2. **"merges a native worker's engine and Clio frames into one row with args, result and duration"**:
   Feeds all four event types (`tool_execution_start`, `clio_coder_tool_start`,
   `clio_coder_tool_finish`, `tool_execution_end`), asserts a single `tool_call` row with
   `args: { path: "src/a.ts" }`, `result_snippet: "file text"`, `duration_ms: 40`, `ok: true`.

3. **"keeps an ACP worker's engine-frame row and adds the Clio frame's duration"**:
   Feeds Clio start, engine start, engine end, Clio finish in ACP order; asserts the row carries
   the engine frame's `toolName: "Read file"`, `args`, `result_snippet`, and the Clio frame's
   `duration_ms: 25`.

4. **"reaches the dispatch board as a failed proof with its reason"**: Constructs an
   `ObservabilityProjection`, calls `evidenceBuildFailed`, feeds the resulting snapshot to
   `createDispatchBoardView`, and asserts the rendered text matches `/proof\s+\S+ failed/u` and
   `/disk full while writing the bundle/u`.

5. **"read back a failed or aborted prewarm as that outcome with unknown usage, not a zero-cost success"**:
   Appends four out-of-turn usage rows (error, aborted, success, legacy) via
   `appendOutOfTurnUsageRow`, reads them back via `readOutOfTurnUsageRows`, and asserts
   `callOutcome` is preserved and unknown usage fields remain `null` (not coerced to `0`).

### `tests/contracts/trace-store-legacy-tables.test.ts`

Two test cases:

1. **"opens, reads and prunes a database that still has the envelopes table and itemized cost columns"**:
   Creates a `TraceStore`, adds a legacy `envelopes` table and four legacy cost columns via raw
   SQLite, reopens with `TraceStore` and `TraceReader`, asserts the legacy phase row reads but
   legacy cost columns are absent from the reader output, and that `prune()` removes the run and
   its legacy envelope rows.

2. **"creates no envelopes table and no itemized cost columns in a new database"**:
   Creates a fresh `TraceStore`, closes it, opens the raw database, and asserts neither the
   `envelopes` table nor the four legacy cost columns exist.

## Extension seams

- **New bus channel handling**: add a subscription in `extension.ts` `start()` and a handler in
  `projection.ts` `unsubscribes`. The projection's bus listeners must stay cheap (mutate state,
  mark changed).
- **New run summary fields**: add the field to `ObservabilityRunSummary` in
  `contract.ts`, parse it in the relevant `parse*` function in `projection.ts`, and render it in
  the consuming surface (dispatch board, footer).
- **New cost entry label**: add the label to `CostEntryLabel` in `cost.ts`; the `/usage` overlay
  and out-of-turn usage reader will pick it up automatically.
- **New trace tables or columns**: extend `SCHEMA_SQL` in `trace-store.ts`; additive columns
  require a migration function (`ensure*Column`) in the `TraceStore` constructor transaction.
  The reader must handle missing columns (as `TraceReader` does for `runs.source`).
- **New worker progress phase**: add the phase to `WorkerProgressPhase` in
  `worker-progress.ts` and handle it in `observe()`. The phase change returns `true` only when
  the phase actually changes.

## Things to watch when editing

- **The `runs` Map preserves first-seen (enqueue) order**, so the snapshot reverses it to surface
  the most recently started runs first. Do not reorder the Map entries or the display will
  break.
- **`applyIdentity` deletes `trust` and `resultContract`** on every lifecycle update. Trust must
  be re-earned from the current receipt; stale trust from a previous attempt must not persist.
- **The trace mirror's `isCriticalTraceEvent`** function distinguishes critical progress events
  (tool starts/ends, `message_end`, `attempt_start`) from display-only chatter. The queue limit
  drops only non-critical events. Do not add a new critical event type without updating this
  list.
- **The `boundedJson` function in `trace-store.ts`** redacts secrets via `redactSecretsText` and
  caps payloads at `TRACE_PAYLOAD_LIMIT_BYTES = 16 KiB`. A payload that exceeds the limit is
  replaced with a `{ truncated: true, snippet: ... }` object. Do not bypass this when adding new
  payload fields.
- **The `out-of-turn-usage` bound check** runs every 64 appends, not on every append. A process
  that crashes between checks leaves the file over the cap; the next append triggers the bound.
  This is intentional: reading the file on every append would be expensive.
- **`flushTimer.unref?.()`** in `projection.ts` prevents the debounce timer from keeping a
  one-shot `clio-coder run` process alive. Do not remove the `unref` call.
- **The `settleFromReceipt` function** in `projection.ts` reads the receipt's seal and trust
  status. A failed or retired seal (`artifactIntegrity.state !== "verified"`) cannot supply the
  board's terminal answer; the progress fold settles without the sealed text.
