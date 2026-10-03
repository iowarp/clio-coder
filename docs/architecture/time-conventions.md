# Time and Clock Conventions

This document describes the time practices implemented in the current Clio
Coder source tree. The code distinguishes process-local elapsed spans from
durable instants, but it does not impose one clock primitive on every module.

---

## 1. Choose a clock for the lifetime of the fact

| Fact | Current practice | Representative sources |
| --- | --- | --- |
| Process-local elapsed span | Use a monotonic source such as `performance.now()` or `process.hrtime.bigint()` when the start and finish occur in one process. | [heartbeat.ts](../../src/domains/dispatch/heartbeat.ts), [code-step.ts](../../src/domains/dispatch/code-step.ts), [startup-timer.ts](../../src/core/startup-timer.ts) |
| Durable or cross-process instant | Store epoch milliseconds or canonical UTC from `new Date(...).toISOString()`. | Session entries, receipts, dispatch rows, audit rows |
| Persisted expiry, lock age, or restart-visible deadline | Some owners intentionally compare `Date.now()` values because the fact must survive a process boundary or is derived from filesystem metadata. | [state-file-lock.ts](../../src/core/state-file-lock.ts) for lock age, [capacity-lease.ts](../../src/domains/dispatch/capacity-lease.ts) for lease and drain `expiresAt`, dispatch admission and recovery |
| Duration between two stored instants | Subtract through `rawDurationMs` and clamp at the render or summing boundary. | [timers.ts](../../src/core/timers.ts), [phase-timing.ts](../../src/domains/dispatch/phase-timing.ts) |
| Timer delay | Clamp to Node's real limit before calling `setTimeout`. | [timers.ts](../../src/core/timers.ts) |
| Concurrent ordering | Prefer an explicit sequence or store order when the protocol supplies one; do not invent ordering from close timestamps. | [agent-ledger-store.ts](../../src/domains/dispatch/agent-ledger-store.ts), [execution-scheduler.ts](../../src/domains/dispatch/execution-scheduler.ts) |

This means neither `performance.now()` nor `Date.now()` is universally correct.
A monotonic value has meaning only within its clock origin and is the right
choice for a live heartbeat age or one process's latency. A wall-clock value is
necessary for a receipt timestamp, a persisted lease deadline, a filesystem
mtime age, or a record another process must read after restart.

`state-file-lock.ts` uses both on purpose. It measures lock-file age as
`Date.now()` minus the file's mtime, because the lock is another process's
filesystem fact, and it measures its own acquisition deadline with
`performance.now()`, because that wait is a span inside the calling process.

### Durations between stored instants

`rawDurationMs(start, end)` in [timers.ts](../../src/core/timers.ts) returns the
signed difference of two reads of the same clock. A negative result means the
clock moved backwards (an NTP correction, a resume, or a value derived across
two hosts) and is a defect in the caller, not a value to swallow. The clamp to
zero belongs at the boundary that renders or sums a duration, and it wraps the
raw subtraction. Phase timing in `phase-timing.ts`, the evidence builder, the
admission queue's queue wait, and run runtime totals follow this pattern.

### Timer delays

`setTimeout` fires after about 1 ms when its delay exceeds 2,147,483,647 ms.
`clampTimerDelayMs` caps a delay at `MAX_TIMER_DELAY_MS` and returns 0, the
disable value, for `NaN` and nonpositive input. Command timeouts in
[bash-exec.ts](../../src/core/bash-exec.ts) and [safe-exec.ts](../../src/core/safe-exec.ts) pass through it.

### Combined anchor and span pattern

When a record needs both a human-readable anchor and an accurate in-process
duration, [code-step.ts](../../src/domains/dispatch/code-step.ts) uses one wall anchor and one
monotonic span:

```ts
const startedAtMs = Date.now();
const clock = process.hrtime.bigint();
const startedAt = new Date(startedAtMs).toISOString();
// ... operation executes ...
const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
const endedAt = new Date(startedAtMs + durationMs).toISOString();
```

The derived ending instant stays consistent with the measured duration even if
the wall clock changes during the operation. The trace mirror applies the same
rule to tool spans. A worker measures `durationMs` on its own clock and the
orchestrator stamps arrival on another, so the mirror stores the observed start
and derives `ended_at` as that start plus the worker's duration, which keeps the
two fields consistent by construction ([trace-store.md](trace-store.md)).

### Cross-host and restart boundaries

Never subtract process-local monotonic values from different processes or
hosts. A restart has no shared monotonic origin with the worker it recovers;
[orphan-recovery.ts](../../src/domains/dispatch/orphan-recovery.ts) first adjudicates the host-scoped
process identity and then uses the persisted heartbeat only as a display and
evidence bound. Transport protocols that need a durable anchor and live
liveness carry both. `HeartbeatStamp.current` is the wall-clock instant, while
`HeartbeatStamp.monotonic` is the value the live watchdog compares.
[worker-spawn.ts](../../src/domains/dispatch/worker-spawn.ts) reads the wall clock once for the
anchor and adds a monotonic span to it for later heartbeat instants, so the
serialized ISO heartbeat and the liveness comparison come from one origin.

On a shared filesystem, a process record created by another host is not checked
against the local process table. Host, pid, and process-birth facts prevent pid
reuse and cross-host confusion. When exact event ordering matters, use a
protocol sequence, SQLite rowid, or append order defined by the owning store.

### Injectable seams are local contracts

Clock injection exists where deterministic timing tests or protocol logic need
it. Examples include the pure heartbeat classifier, the dispatch admission
queue's `now`, capacity lease calls that take `nowMs`, fleet preflight's `now`,
worker spawn's `now` and `monotonicNow`, and the audit writer's `dateFn`. Other
modules read a platform clock directly. There is no global
test-clock harness; tests use the seam supplied by the owner under test or
exercise real passage explicitly.

---

## 2. UTC storage and local rendering

Durable and wire timestamps use canonical ISO-8601 UTC strings produced by
`toISOString()` unless a schema explicitly owns epoch milliseconds. Localized
display strings do not belong in persisted models.

Operator-facing conversion is centralized in
[format-time.ts](../../src/core/format-time.ts), which `src/interactive/format-time.ts` re-exports.
The `/view` artifact providers in the session domain use the same module, so
the terminal and ACP clients show identical local times. Each function accepts an
`Instant` (an ISO string, epoch milliseconds, or a `Date`):

| Function | Output | Purpose |
| --- | --- | --- |
| `clockLocal(instant)` | `HH:MM:SS` through `en-GB` with a 24-hour cycle | Local time of day |
| `dateLocal(instant)` | `YYYY-MM-DD` through `en-CA` | Local calendar date |
| `relative(instant, now)` | `just now` under 5 s, then `Ns ago`, `Nm ago`, `Nh ago`, `yesterday`, `Nd ago` under 7 days, `Nw ago` under 30 days, then `dateLocal` | Coarse recency |

An absent or unparseable instant renders as `—`. The module keeps its
`Intl.DateTimeFormat` instances at module scope and rebuilds them, with the zone
passed explicitly, when `process.env.TZ` changes. Machine-readable surfaces such as
structured logs, session records, and receipts bypass these formatters.

---

## 3. Receipt and audit integrity

Persisted receipt fields such as `startedAt` and `endedAt` participate in the
integrity digest owned by [receipt-integrity.ts](../../src/domains/dispatch/receipt-integrity.ts). Timestamp
normalization and duration derivation must finish before sealing. A sealed
receipt must not be rewritten merely to make its clocks look tidier.

Safety audit rows are written under:

```text
<stateDir>/audit/YYYY-MM-DD.jsonl
```

The filename date is the operator-local calendar date on which the writer
opened that generation. Each row still carries a canonical UTC `ts`. Concurrent
producers do not promise timestamp order in the raw file, so consumers sort by
`ts` when reconstructing time order. The local date label is not itself a
machine ordering key.

---

## 4. Review checklist

When adding a timed fact:

1. Decide whether it is a process-local span, a durable instant, or a
   restart-visible deadline.
2. Keep monotonic values inside their originating process.
3. Persist UTC anchors and the measured duration when both are useful.
4. Use host identity and process-birth evidence before consulting a local pid.
5. Add a narrow injectable seam when deterministic tests need one; do not imply
   that an unrelated module shares it.
6. Normalize timestamps before sealing any receipt or evidence digest.
7. Subtract stored instants through `rawDurationMs` and clamp only where a
   duration is rendered or summed.
8. Pass any configurable timeout through `clampTimerDelayMs` before it reaches
   `setTimeout`.
