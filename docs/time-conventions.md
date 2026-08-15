# Time and Clock Conventions

This document defines the canonical time and clock conventions for `clio-coder`. These policies establish consistent rules for measuring durations, recording instants, converting timezones, and managing concurrency across the codebase.

This policy is promoted from Section 10 of the repository time audit in [time-audit-2026-08-15.md](issues/time-audit-2026-08-15.md).

---

## 1. Which Clock for What Purpose

### Monotonic clocks for durations

All durations must be measured using `performance.now()` without exception. This rule applies to latency measurements, elapsed run times, time-to-first-token (TTFT), execution budgets, timeouts, stall watchdogs, retry backoff intervals, and rendering metrics.

Whenever a value answers the question "how long did this take" or "how long until", it must originate from the monotonic clock. Monotonic clocks are unaffected by Network Time Protocol (NTP) adjustments, system suspend or resume events, and Daylight Saving Time (DST) transitions.

### Wall clocks for anchored instants

Wall clock reads via `Date.now()` or `new Date()` are reserved exclusively for anchoring instants that a human operator or an external machine will inspect. These include timestamps such as `startedAt`, `endedAt`, `createdAt`, and `expiresAt`. Wall clocks must never be used to measure durations or elapsed intervals.

### Combined anchor and span pattern

When both an anchor instant and a duration are required, code must follow the pattern established in `src/domains/dispatch/code-step.ts:291-306`:

```ts
const startedAtMs = Date.now();                      // wall anchor, for the record
const clock = process.hrtime.bigint();               // monotonic span
const startedAt = new Date(startedAtMs).toISOString();
// ... operation executes ...
const durationMs = Number((process.hrtime.bigint() - clock) / 1_000_000n);
const endedAt = new Date(startedAtMs + durationMs).toISOString();
```

The wall clock anchors the starting instant for human correlation. The monotonic clock measures the elapsed span. The ending timestamp `endedAt` is derived by adding the monotonic span to the initial wall anchor. This derivation guarantees that `endedAt - startedAt === durationMs` remains true regardless of any wall-clock adjustments that occur during execution.

### Injectable clock seams

Every module that reads a clock must accept an optional injectable clock interface in its configuration or options, defaulting to the system clock. Injectable clock seams allow test suites to run deterministically without relying on real-time passage or introducing timing races.

### Cross-host timestamp boundaries

A timestamp produced on one host must never be compared directly against a clock read on another host. Systems must receive-stamp incoming events upon arrival on the local host, maintain an explicit clock offset, or order events using sequence numbers rather than timestamps. Code must never subtract timestamps across host boundaries.

### Sequence numbers over timestamps for ordering

When ordering operations under concurrency, code must prefer monotonic sequence numbers over timestamps. Components such as the agent ledger (`src/domains/session/agent-ledger-store.ts`) and the execution scheduler (`src/domains/dispatch/execution-scheduler.ts`) rely on sequence numbers to remain correct by construction. Timestamps are reserved for human display and coarse windowing. Any attribution logic that relies on timestamps must report ambiguity explicitly rather than returning null.

---

## 2. Where UTC Is Converted

### Storage, transport, and comparisons in UTC

The system stores UTC, transports UTC, and compares UTC. Conversion to local time occurs once, strictly at the render call site.

1. On disk and across the wire, timestamps are always represented as canonical ISO-8601 strings produced by `toISOString()`. Every store validates timestamps upon reading using the exact round-trip check from `src/domains/dispatch/capacity-lease.ts:80-84`.
2. In memory, instants are stored as epoch milliseconds or canonical ISO-8601 strings. Localized or pre-formatted date strings must not be held in memory models.
3. At the user interface render boundary, UTC instants are converted to the operator's local timezone.
4. Whenever a converted local timestamp is displayed, the underlying canonical UTC instant must remain accessible. For example, a table row displays local time while the associated detail pane preserves the exact ISO-8601 string so that the two representations can always be reconciled.

---

## 3. Formatter Policy

All operator-facing time formatting is consolidated in `src/interactive/format-time.ts`. The module provides three standardized formatting functions:

| Function | Output Format | Timezone and Locale Frame | Purpose |
|---|---|---|---|
| `clockLocal(instant)` | `HH:MM:SS` | Operator local timezone using `en-GB` locale with 24-hour cycle (`hourCycle: "h23"`) | Renders time-of-day for logs, tree selectors, and message pickers |
| `dateLocal(instant)` | `YYYY-MM-DD` | Operator local timezone using `en-CA` locale | Renders calendar dates for session selectors, welcome dashboards, and export filenames |
| `relative(instant, now)` | `"3m ago"` (falls back to `dateLocal`) | Operator local timezone | Renders relative recency ladders with automatic fallback to calendar dates |

Both `Intl.DateTimeFormat` instances are constructed at module scope. The module automatically rebuilds formatters if `process.env.TZ` changes during runtime.

Machine surfaces such as filenames, IDs, structured log fields, and receipt records bypass the formatting module entirely and use canonical `toISOString()`.

---

## 4. Test Determinism and Receipt Integrity

### Test clock harness

Test suites must rely on the steppable clock helper in `tests/harness/clock.ts`. Every factory function that reads a clock must default to the harness clock in test environments. Real-time passage in tests is opt-in and requires explicit configuration.

### Receipt integrity digests

Persisted fields such as `startedAt` and `endedAt` participate in receipt integrity digests (`src/domains/dispatch/receipt-integrity.ts`). Any timestamp normalization, derivation, or adjustment must occur before the receipt digest is sealed. Timestamps must never be rewritten after receipt creation.

---

## 5. State-Root and Audit-Filename Assumptions

### Host-scoped state root and coordination

The state root directory is host-scoped. Durable locks and capacity leases carry a metadata payload containing `{host, pid, birthToken}`.

A coordination record created by a foreign host is never adjudicated against the local process table. This follows the host-scoping pattern implemented in `src/tools/compete-worktrees.ts:207-215`, `src/domains/dispatch/orphan-recovery.ts:140-149`, and `src/core/run-identity.ts:23`.

### Audit filename semantics

The date in an audit log filename (such as `audit-YYYY-MM-DD.jsonl`) is a human-facing label indicating the local calendar date on which the audit log was opened. It does not represent machine-read data. All individual audit event records contained within the file store canonical UTC ISO-8601 timestamps.
