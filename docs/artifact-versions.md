# Artifact Versions & Serialization Contracts

This document is the canonical registry of all versioned file formats, serialized data structures, integrity digests, and migration rules across Clio Coder in `v0.3.6`.

---

## 1. Versioned Artifacts Registry

Clio Coder strictly versions every persistent or network-transported data structure. When a reader encounters an incompatible version, it either executes an automated migration or fails closed with a typed error.

| Artifact / Subsystem | Current Version | Symbol / Type & Source Location | Persisted Path / Wire Location | Schema Semantics & Version Differences | Mismatch Handling |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Run Receipt** | `16` | `RUN_RECEIPT_INTEGRITY_VERSION = 16`<br>`src/domains/dispatch/receipt-integrity.ts:13` | `<stateDir>/receipts/<runId>.json` | Cryptographically sealed run record. Version 16 covers all base provenance fields, routing intent, quality labels, `validationGrounding`, and `capabilityMismatch`. | Fail-closed. Incompatible receipts fail verification and are never read as evidence. |
| **Session Ledger** | `3` | `CURRENT_SESSION_FORMAT_VERSION = 3`<br>`src/engine/session.ts:66` | `<stateDir>/sessions/<cwdHash>/<sessionId>/` (`meta.json`, `current.jsonl`, `tree.json`) | Append-only ledger format with UUIDv7 turn IDs, session header line, and tree graph linkage. | Automated migration via `src/domains/session/migrations/` on `/resume`. Earlier unmigratable versions rejected. |
| **Worker Spec** | `3` | `WORKER_SPEC_VERSION = 3`<br>`src/worker/spec-contract.ts:22` | Subprocess `stdin` control plane JSON payload | Worker invocation parameters, tool surface profile, and execution bounds. | Fail-closed preflight rejection before worker activation. |
| **Worker Runtime Descriptor** | `2` | `WORKER_RUNTIME_DESCRIPTOR_VERSION = 2`<br>`src/worker/spec-contract.ts:23` | Worker attestation descriptor payload | Attestation descriptor for worker runtime environment and hardware facts. | Attestation mismatch causes immediate process termination. |
| **Worker Protected Artifact State** | `1` | `WORKER_PROTECTED_ARTIFACT_STATE_VERSION = 1`<br>`src/worker/spec-contract.ts:24` | Worker spec initialization snapshot | Snapshot of active protected artifact paths and validation commands passed to worker. | Worker fails closed before executing mutations. |
| **Fleet Contract** | `1 \| 2 \| 3 \| 4` (Current: `4`) | `FleetContractVersion = 1 \| 2 \| 3 \| 4`<br>`FLEET_WRITE_BOUNDARY_VERSION = 4`<br>`src/domains/agents/fleet-contract.ts:37, 140` | `.clio-coder/fleets/<name>.yaml`, `.clio-coder/fleets/<name>.yml`, or built-in recipes | Multi-agent workflow contract. v1 is agent-only; v2 adds deterministic code steps; v3 adds bounded loops (`FLEET_LOOP_MAX_ATTEMPTS = 5`) and commit steps; v4 adds declared per-step write boundaries (`writes`). | Reader refuses contracts whose version features it does not support. |
| **Execution Plan** | `4` | `version: 4` in `interface ExecutionPlan`<br>`src/domains/dispatch/execution-plan.ts:98` | Statically compiled DAG representation in dispatch memory and receipts | Statically unrolled, deterministically hashed execution plan. v4 adds bounded loop nodes, verification staleness tracking, and commit nodes. | Preflight validation rejects unsupported plan versions. |
| **Eval Artifact** | `4` | `version: 4` in `interface EvalArtifactV4`<br>`src/domains/eval/schema/artifact.ts:51-52` | `<stateDir>/evals/<evalId>.json` | Stored eval results with suite provenance, matrix parameters, and itemized metric outcomes. Note: `EVAL_ARTIFACT_VERSION = 1` in `src/domains/eval/types.ts:2` is legacy/dead code. | Incompatible eval artifacts are rejected during `clio-coder eval report` and `compare`. |
| **Trace Database** | `1` | `TRACE_SCHEMA_VERSION = 1`<br>`src/domains/observability/trace-store.ts:23` | `<stateDir>/trace.sqlite` (`meta` table `schema_version`) | Schema version for the 7 SQLite trace mirror tables (`runs`, `phases`, `events`, `envelopes`, `gate_results`, `agent_sessions`, `processes`). | Log warning (`[clio:trace]`), trace writing degrades without failing the parent run. |
| **Capacity State File** | `2` | `version: 2` in `interface CapacityStateFile`<br>`src/domains/dispatch/capacity-lease.ts:40` | `<stateDir>/dispatch-admission.json` | Active capacity leases, drain status, and cross-process lock state. | Corrupted or unparseable state file causes admission to fail closed. |
| **Protected Artifact Journal** | `1` | `version: 1` in `interface PendingProtectedArtifactRecord`<br>`src/domains/session/protected-artifact-journal.ts:22` | `<stateDir>/protected-artifact-pending/<key>/<id>.json` | Write-ahead durability records for pending protected artifacts. | Leftover records reconciled during session initialization. |

---

## 2. Integrity Verification Contracts

### Receipt Integrity (Version 16)

Receipt integrity authenticates that a sealed receipt matches its ledger envelope without modification. Verification reproduces the canonical JSON serialization and computes the SHA-256 digest:

```typescript
export function computeReceiptDigest(receipt: RunReceiptV15): string {
  const canonical = serializeCanonicalReceipt(receipt);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
```

Receipt verification checks:
1. `integrity.version === 16`.
2. Calculated SHA-256 matches `integrity.digest`.
3. All optional fields present in the schema (`validationGrounding`, `capabilityMismatch`, `steering`, `gate`, `plan`, `briefing`) conform to the strict v16 specification.

---

## 3. Migration Mechanics

Session migrations execute automatically when resuming a session whose `meta.json` format version is less than `CURRENT_SESSION_FORMAT_VERSION = 3`:

1. **Discovery**: `src/domains/session/migrations/index.ts:runMigrations` reads the recorded `sessionFormatVersion`.
2. **Step Execution**: Sequentially runs migration passes (e.g. `v1 -> v2`, `v2 -> v3`), transforming `current.jsonl` entries and reconstructing `tree.json` linkages.
3. **Atomic Commit**: Staged migrations are written to temporary files, fsync'd, and atomically renamed over the original session files.
4. **Metadata Update**: `meta.sessionFormatVersion` is updated to `3` and committed to `meta.json`.
