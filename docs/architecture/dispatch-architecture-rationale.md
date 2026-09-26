# Dispatch domain boundaries

The [fleet dispatch guide](../guide/fleet-dispatch.md) describes operator workflows.
`src/domains/dispatch/` owns plan compilation, admission, routing, scheduling,
worker execution, and receipts. These responsibilities share the contracts below.

| Contract | Owners and enforcement |
| --- | --- |
| Deterministic plan | `compileExecutionPlan` produces a hashed DAG with unrolled loops, scheduling waves, boundary attribution, and authority grants. |
| Reservation lifetime | Capacity leases serialize acquisition, retry rebinding, heartbeat, drain, and transfer under one cross-process lock. A retry reserves the node and cost bound it actually resolves. |
| Assignment and attempt identity | A plan slot belongs to an assignment. Retries have distinct run IDs and the `recovery` role, preventing an attempt from queuing behind itself. |
| Whole-plan admission | Preflight and reservation finish before any worker starts. Missing candidates, authority, or verifiable boundaries refuse admission. Manual pins and `failover: none` retain their declared constraints. |
| Write attribution | The compiler refuses a scheduling wave with two writers. The scheduler enforces the compiled boundary. |
| Loop termination | The scheduler marks later loop nodes `unneeded` after termination. |
| Verification freshness | A later workspace step can invalidate an earlier verification; the scheduler reruns the affected check. |
| Receipt authority | The orchestrator validates and seals receipts. Normalized routing intent is included in receipt integrity; quality records are local to the run. |

Pure reducers and helpers can remain separate files within the domain while
using the same plan, identity, and lease contracts. Routing history keys on
capability, and receipt generation consumes the routing decision actually used
for the attempt.

## Imports and dependency direction

Direct subpath imports and domain-barrel imports are both permitted. The
[boundary checker](../../tests/boundaries/check-boundaries.ts), run by
`pnpm run lint`, constrains dependency direction. It does not require every
cross-domain symbol to be re-exported from a barrel.
