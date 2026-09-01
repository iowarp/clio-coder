# Capacity Leases & Fleet Scheduling

This document specifies the multi-process capacity leasing protocols, node
scheduling models, cross-process transaction locks, and failure recovery
mechanics in the current source tree.

Source implementations: `src/domains/scheduling/` and `src/domains/dispatch/capacity-lease.ts`.

---

## 1. Capacity Model & Admission Invariants

Fleet dispatch manages compute resources across local and remote execution nodes as a unified capacity pool. Dispatched workers must acquire a durable capacity lease before they are spawned. Admission checks global, node, and inference-endpoint limits independently.

```mermaid
graph TD
    req[Dispatch Request] --> lock[Acquire Cross-Process Lock: dispatch-admission.json.lock]
    lock --> reap[Reap Expired Leases & Dead PIDs]
    reap --> check[Check Capacity Limits: global, per-node, and per-endpoint]
    check -->|Within Limits| grant[Grant Capacity Lease & Write State]
    check -->|Limits Exceeded| queue[Queue / Reject Request]
    grant --> unlock[Release Lock]
    unlock --> spawn[Spawn Worker Process]
```

| Dimension | Identity | Limit resolution |
| :--- | :--- | :--- |
| Global | All dispatches using the state directory. | `fleet.concurrency: auto` remains four. |
| Node | The local node or one configured fleet node. | The configured node limit applies. An unset local node cap remains unbounded. |
| Inference endpoint | A normalized scheme, host, port, and base path. | A target's `maxConcurrentRequests` override wins, then a probe in this process, then a persisted probe from an earlier process, then one slot for other local-native targets. vLLM and SGLang remain unbounded. |

The conventional final `/v1` mount and a trailing slash normalize to the same endpoint. Host aliases are not collapsed because Clio cannot prove they address the same server. For example, `http://localhost:8080/` and `http://127.0.0.1:8080/v1` remain distinct, while two target descriptors that use the same normalized URL share one endpoint limit.

llama.cpp discovery reads `total_slots` from cached probe results. A router can expose the selected worker's value from `/props?model=<id>` even when router `/props` has no slot count. The selected model's `/v1/models` argv supplies a `--parallel` fallback. LM Studio defaults to one slot when its REST response supplies no concurrency fact. Ollama defaults to one unless `OLLAMA_NUM_PARALLEL` is visible to the local process.

The endpoint set is resolved from the configured targets as well as the probed statuses, so it is the same set a second after boot as it is a minute later. An endpoint that resolves to no limit is not checked at all, and "not checked" is not a conservative answer.

### Persisted Slot Discovery

A probe learns a fact about a server, not about the process that asked, so a discovered slot count is written to disk and read back as a prior by the next process.

- **Path**: `<stateDir>/endpoint-slots.json` (`src/domains/providers/endpoint-slots-store.ts:endpointSlotsPath()`)
- **Version**: `version: 1`, one record per canonical endpoint key
- **Transaction lock**: `<stateDir>/endpoint-slots.json.lock` (`withStateFileLock`)
- **Staleness bound**: 24 hours, overridable per process with `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS`

```typescript
export interface DiscoveredEndpointSlots {
  endpointKey: string;   // Canonical inference endpoint identifier
  runtimeId: string;     // Runtime that observed the count
  slots: number;         // Discovered parallel slot count
  observedAt: string;    // ISO-8601 observation timestamp
}
```

Three things bound what a record may claim. A record older than the staleness bound is ignored and pruned by the next write, so a server restarted with a smaller `--parallel` cannot keep over-admitting against yesterday's number. A record written by a different runtime for the same host and port is ignored, because a different inference server is a different scheduler. A probe in this process always wins over the record, and `maxConcurrentRequests` wins over both. A well-formed record that fails any of these checks falls back to the conservative default rather than to a guess.

### State Storage & Format

All capacity state is stored in a single durable JSON file:

- **Path**: `<stateDir>/dispatch-admission.json` (`src/domains/dispatch/capacity-lease.ts:capacityStatePath()`)
- **Version**: `version: 2` (`CapacityStateFile`)
- **Transaction Lock**: `<stateDir>/dispatch-admission.json.lock` (`withStateFileLockSync`)

```typescript
export interface CapacityStateFile {
  version: 2;
  draining: CapacityDrain | null;
  leases: CapacityLease[];
  reservations: unknown[];
}
```

---

## 2. Capacity Lease Schema & TTLs

Each in-flight worker holds one `CapacityLease` (`src/domains/dispatch/capacity-lease.ts:18-29`):

```typescript
export interface CapacityLease {
  leaseId: string;              // Unique lease identifier
  assignmentId: string;         // Owning dispatch assignment ID
  nodeId: string;               // Execution node identifier ("local" or remote ID)
  endpointKey?: string;         // Canonical inference endpoint identifier
  ownerPid: number;             // Process ID of the orchestrator/worker owner
  processBirthToken: string;    // OS-level token preventing PID reuse collisions
  acquiredAt: string;           // ISO-8601 acquisition timestamp
  expiresAt: string;            // ISO-8601 expiration timestamp
  heartbeatAt: string;          // ISO-8601 last heartbeat timestamp
  reservationOwnerId: string | null;
  reservationMemberId: string | null;
}
```

The orchestrator's active model stream is registered in memory against the same endpoint key, so its own turn consumes one endpoint slot before a worker is admitted. This foreground count is not written to `dispatch-admission.json`; process exit releases it. Durable leases and held reservation members carry `endpointKey`, and held members count their peak per wave for the endpoint just as they do for a node.

Execution-plan waves also honor the endpoint bound. A plan with four available worker positions targeting one two-slot server packs at most two of them into a wave, or one when the orchestrator already holds the other slot. Endpoint saturation is refused rather than queued, because an endpoint-specific request queue would hold a dispatch open behind a stream whose length nobody knows. The refusal names the endpoint, both slot counts, why one slot is already gone, and the moves that actually free capacity:

```text
dispatch: admission denied: endpoint '192.168.86.141:8080' capacity reached (1/1 slots): 1 foreground stream holds the slot; reduce the same-wave worker count, set this target's maxConcurrentRequests to the slot count the server was started with, collect in-flight runs, or point workers at a second server
```

That remedy is shared by all three paths that can refuse for this reason: lease acquisition (`src/domains/dispatch/capacity-lease.ts`), the admission gate (`src/domains/dispatch/admission.ts`), and reservation preflight (`src/domains/dispatch/reservation-store.ts`). The `1/1` above is the common local case rather than an example: a llama.cpp router started with `--parallel 1` discovers one slot, so any dispatch raised while the orchestrator is streaming is refused before a worker process starts.

### What `/council` Needs on a Single-GPU Setup

A council seats two to five members and runs the whole roster in one wave, so it needs at least two endpoint slots at once, plus a third if the orchestrator's own turn is streaming to the same server. It cannot answer a capacity denial by dispatching fewer members, which is why its denial says so instead of offering that move:

```text
dispatch: admission denied: endpoint 'mini:8080' capacity exceeded (2/1 slots): no active lease, held reservation, or foreground stream currently holds a slot; a council runs its whole roster in one wave and cannot go below 2 members, so set this target's maxConcurrentRequests to the slot count the server was started with, collect in-flight runs, or point workers at a second server
```

On a single-GPU box there are three ways to make `/council` work, in order of preference:

1. Start the server with enough slots and let discovery find them. `llama-server --parallel 4` is discovered as four slots and persisted, so every later process sees four without re-probing.
2. Set `maxConcurrentRequests` on the target when the server's real concurrency is higher than what it advertises. It overrides every discovered value.
3. Point some roster members at a second server. Members on different endpoints do not compete for the same slots.

A server genuinely started with one slot cannot run a council, and admitting one anyway would put two workers plus the orchestrator through a scheduler with room for one. The denial is the correct outcome; the fix is on the server or in the roster.

### Constants & Operational Bounds

| Constant | Value | Description | Source Reference |
| :--- | :--- | :--- | :--- |
| `MAX_CAPACITY_LEASES` | `1000` | Hard cap on simultaneous active capacity leases across all nodes. | `src/domains/dispatch/capacity-lease.ts:8` |
| `DEFAULT_CAPACITY_LEASE_TTL_MS` | `30000` ms (30s) | Inactivity expiration window for leases without a refreshed heartbeat. | `src/domains/dispatch/capacity-lease.ts:9` |
| `DEFAULT_CAPACITY_DRAIN_TTL_MS` | `3600000` ms (1h) | Automatic expiration window for operator drain mode. | `src/domains/dispatch/capacity-lease.ts:16` |
| `NODE_DEATH_FAILURE_THRESHOLD` | `2` consecutive failures | Channel failure count before a remote node is classified offline. | `src/domains/scheduling/cluster.ts:64` |

---

## 3. Heartbeats & Dead-Process Recovery

To prevent leaked leases when workers or orchestrators crash:

1. **Heartbeat Protocol**: Active workers emit heartbeats over their control channel every 1,000 ms (`src/worker/heartbeat.ts`). The orchestrator updates `heartbeatAt` and extends `expiresAt` by `DEFAULT_CAPACITY_LEASE_TTL_MS`.
2. **PID Liveness & Birth Tokens**: The lease reconciler inspects `ownerPid` and validates `processBirthToken` against operating system process tables. If the PID has terminated or been recycled by the OS, the lease is immediately reclaimed.
3. **Lazy Reaping**: Every admission attempt purges expired leases and dead process records inside the cross-process transaction lock before calculating available capacity.

---

## 4. Cluster Drain & Emergency Control

The fleet can be drained for maintenance without terminating running jobs:

- **Drain Command**: `clio-coder fleet drain` sets `draining` in `dispatch-admission.json`.
- **Drain Invariant**: When draining is active, existing runs continue to completion, but all new dispatch admissions are refused with a drain notice.
- **Auto-Expiry**: To prevent an unmanaged lockup if a draining operator disconnects, the drain state automatically expires after `DEFAULT_CAPACITY_DRAIN_TTL_MS` (1 hour).
- **Resume Command**: `clio-coder fleet resume` clears the drain state immediately.

---

## 5. Fail-Closed Invariants

1. **Corrupted State File**: If `dispatch-admission.json` contains invalid JSON or schema violations, the admission engine fails closed, refusing new work until repaired.
2. **Lock Timeouts**: If the cross-process lock cannot be acquired within the timeout window, dispatch fails closed rather than executing uncoordinated parallel operations.
