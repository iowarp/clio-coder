# Artifact Versions & Serialization Contracts

This document is the canonical registry of all versioned file formats, serialized data structures, integrity digests, and migration rules across Clio Coder in `v0.3.8`.

---

## 1. Versioned Artifacts Registry

Clio Coder strictly versions every persistent or network-transported data structure. When a reader encounters an incompatible version, it either executes an automated migration or fails closed with a typed error.

| Artifact / Subsystem | Current Version | Symbol / Type & Source Location | Persisted Path / Wire Location | Schema Semantics & Version Differences | Mismatch Handling |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Run Receipt** | `20` | `RUN_RECEIPT_INTEGRITY_VERSION = 20`<br>`src/domains/dispatch/receipt-integrity.ts:13` | `<stateDir>/receipts/<runId>.json` | Cryptographically sealed run record. Version 20 adds `pathProvenance` on dispatch intent and the resolved `pathScope`, over the v19 base of provenance fields, routing intent, quality labels, `validationGrounding`, `capabilityMismatch`, council provenance, and fleet gate provenance. | Fail-closed. A receipt below v20 is reported as retired rather than invalid, is never read as evidence, and is never migrated; a malformed or tampered v20 receipt fails verification. |
| **Session Ledger** | `3` | `CURRENT_SESSION_FORMAT_VERSION = 3`<br>`src/engine/session.ts:66` | `<stateDir>/sessions/<cwdHash>/<sessionId>/` (`meta.json`, `current.jsonl`, `tree.json`) | Append-only ledger format with UUIDv7 turn IDs, session header line, and tree graph linkage. | Automated migration via `src/domains/session/migrations/` on `/resume`. Earlier unmigratable versions rejected. |
| **Worker Spec** | `3` | `WORKER_SPEC_VERSION = 3`<br>`src/worker/spec-contract.ts:22` | Subprocess `stdin` control plane JSON payload | Worker invocation parameters, tool surface profile, and execution bounds. | Fail-closed preflight rejection before worker activation. |
| **Worker Runtime Descriptor** | `2` | `WORKER_RUNTIME_DESCRIPTOR_VERSION = 2`<br>`src/worker/spec-contract.ts:23` | Worker attestation descriptor payload | Attestation descriptor for worker runtime environment and hardware facts. | Attestation mismatch causes immediate process termination. |
| **Worker Protected Artifact State** | `1` | `WORKER_PROTECTED_ARTIFACT_STATE_VERSION = 1`<br>`src/worker/spec-contract.ts:24` | Worker spec initialization snapshot | Snapshot of active protected artifact paths and validation commands passed to worker. | Worker fails closed before executing mutations. |
| **Fleet Contract** | `1 \| 2 \| 3 \| 4 \| 5` (Current: `5`) | `FleetContractVersion = 1 \| 2 \| 3 \| 4 \| 5`<br>`FLEET_WRITE_BOUNDARY_VERSION = 4`<br>`FLEET_DYNAMIC_STEP_VERSION = 5`<br>`src/domains/agents/fleet-contract.ts` | `.clio-coder/fleets/<name>.yaml`, `.clio-coder/fleets/<name>.yml`, or built-in recipes | Multi-agent workflow contract. v1 is agent-only; v2 adds deterministic code steps; v3 adds bounded loops and commit steps; v4 adds declared per-step write boundaries; v5 adds plan steps, gate steps, per-step target or profile routing, and the single-writer declaration. | Reader refuses contracts whose version features it does not support. |
| **Execution Plan** | `4` | `version: 4` in `interface ExecutionPlan`<br>`src/domains/dispatch/execution-plan.ts:98` | Statically compiled DAG representation in dispatch memory and receipts | Statically unrolled, deterministically hashed execution plan. v4 adds bounded loop nodes, verification staleness tracking, and commit nodes. | Preflight validation rejects unsupported plan versions. |
| **Eval Artifact** | `4` | `version: 4` in `interface EvalArtifactV4`<br>`src/domains/eval/schema/artifact.ts:51-52` | `<stateDir>/evals/<evalId>.json` | Stored eval results with suite provenance, matrix parameters, and itemized metric outcomes. Note: `EVAL_ARTIFACT_VERSION = 1` in `src/domains/eval/types.ts:2` is legacy/dead code. | Incompatible eval artifacts are rejected during `clio-coder eval report` and `compare`. |
| **Trace Database** | `1` | `TRACE_SCHEMA_VERSION = 1`<br>`src/domains/observability/trace-store.ts:23` | `<stateDir>/trace.sqlite` (`meta` table `schema_version`) | Schema version for the 7 SQLite trace mirror tables (`runs`, `phases`, `events`, `envelopes`, `gate_results`, `agent_sessions`, `processes`). | Log warning (`[clio:trace]`), trace writing degrades without failing the parent run. |
| **Capacity State File** | `2` | `version: 2` in `interface CapacityStateFile`<br>`src/domains/dispatch/capacity-lease.ts:40` | `<stateDir>/dispatch-admission.json` | Active capacity leases, drain status, and cross-process lock state. | Corrupted or unparseable state file causes admission to fail closed. |
| **Protected Artifact Journal** | `1` | `version: 1` in `interface PendingProtectedArtifactRecord`<br>`src/domains/session/protected-artifact-journal.ts:22` | `<stateDir>/protected-artifact-pending/<key>/<id>.json` | Write-ahead durability records for pending protected artifacts. | Leftover records reconciled during session initialization. |
| **Fleet Run Record** | `1` | `version: 1` in `interface FleetRunRecord`<br>`src/domains/dispatch/fleet-run.ts` | `<stateDir>/fleet-runs/<runId>.json` | Durable record of one fleet run: contract name, plan hash, static step ids and steps, `--var` values, replayed and settled step results, and the delegation plan hash a `kind: plan` step produced. Read by `fleet run --resume`. | Resume refuses a changed plan hash with a per-step diff and refuses differing `--var` values. |
| **Durable Assignment Store** | `1` | `version: 1` in `interface AssignmentStoreFile`<br>`DurableAssignmentRecord`<br>`src/domains/dispatch/assignment-store.ts` | `<stateDir>/assignments.json` | Machine-wide logical-dispatch records: assignment id, attempt ids, terminal run id, status, optional fleet verdict owner, and—while running—`processOwner {pid, processBirthToken, acquiredAt}`. The owner is cleared on a true terminal transition. | A live sibling owner keeps the row running; a genuinely dead or legacy ownerless row is reconciled. An unsupported or unreadable store is treated as empty, and malformed records are ignored. |
| **Checkout Writer Lease** | `1` | `version: 1` in `interface CheckoutWriterLeaseRecord`<br>`src/domains/dispatch/checkout-writer-lease.ts` | `<stateDir>/checkout-writer-leases/<key>.json` (key derived from the canonical checkout path) | Cross-process single-writer lease: checkout path, pid, process birth token, acquisition time. | A live sibling holder is refused with `checkout_writer_lease_held`; a dead owner is reclaimed; a malformed record is treated as absent. |
| **Out-of-turn Usage Ledger** | unversioned JSONL | `OutOfTurnUsageRow`<br>`src/domains/observability/out-of-turn-usage.ts` | `<stateDir>/usage/out-of-turn.jsonl` | One row per priced `/btw` or `/handoff` call: label, session id, repo identity, timestamp, target, attributed model, provider usage. Bounded ring of `MAX_OUT_OF_TURN_USAGE_ROWS = 1000`, rewritten atomically under the state-file lock. | Unparseable rows are skipped and counted by `usage report`; the session ledger is never affected. |
| **Library Pins** | unversioned YAML map | `readLibraryPins`<br>`src/domains/resources/library.ts` | `<configDir>/library-pins.yaml` | Typed ref (`skill:x`, `agent:y`, `prompt:p`, `fleet:z`) to `{sha256, sourceUrl}` for every resource `library add` or the Skills Hub installed. | A non-map document reads as empty; an entry whose installed file is missing is reported as available, not installed. |

---

## 2. Integrity Verification Contracts

### Receipt Integrity (Version 20)

Receipt integrity authenticates that a sealed receipt matches its ledger envelope without modification. Verification reproduces the canonical JSON serialization and computes the SHA-256 digest:

```typescript
export function computeReceiptDigest(receipt: RunReceiptV15): string {
  const canonical = serializeCanonicalReceipt(receipt);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

Receipt verification checks:
1. `integrity.version === 20`. A receipt sealed at a lower version is reported as retired rather than invalid: it is intact, but is not read as evidence and is never migrated.
2. Calculated SHA-256 matches `integrity.digest`.
3. All optional fields present in the schema (`validationGrounding`, `capabilityMismatch`, `steering`, `gate`, `fleetGate`, `council`, `plan`, `briefing`) conform to the strict v20 specification.

---

## 3. Migration Mechanics

Session migrations execute automatically when resuming a session whose `meta.json` format version is less than `CURRENT_SESSION_FORMAT_VERSION = 3`:

1. **Discovery**: `src/domains/session/migrations/index.ts:runMigrations` reads the recorded `sessionFormatVersion`.
2. **Step Execution**: Sequentially runs migration passes (e.g. `v1 -> v2`, `v2 -> v3`), transforming `current.jsonl` entries and reconstructing `tree.json` linkages.
3. **Atomic Commit**: Staged migrations are written to temporary files, fsync'd, and atomically renamed over the original session files.
4. **Metadata Update**: `meta.sessionFormatVersion` is updated to `3` and committed to `meta.json`.
