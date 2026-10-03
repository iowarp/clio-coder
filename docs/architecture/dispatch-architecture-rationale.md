# Dispatch domain boundaries

The [fleet dispatch guide](../guide/fleet-dispatch.md) describes operator workflows.
`src/domains/dispatch/` owns plan compilation, admission, routing, scheduling,
worker execution, and receipts. These responsibilities share the contracts below.

| Contract | Owners and enforcement |
| --- | --- |
| Deterministic plan | `compileExecutionPlan` ([execution-plan.ts](../../src/domains/dispatch/execution-plan.ts)) produces a version 4 plan hashed with SHA-256 over a canonical form: steps with sorted dependencies, bounded loops unrolled into check and repair nodes, scheduling waves, declared write boundaries, and per-step authority grants (`requestedAuthority` and `approvedAuthority`). The scheduler refuses an agent step whose approved authority is missing or differs from the requested one. |
| Reservation lifetime | Capacity leases serialize acquisition, retry rebinding, heartbeat, drain, and transfer under one cross-process lock. A retry rebinds its reserved member to the node and endpoint it actually resolves, and the cost bound it records is advisory. See [capacity and scheduling](capacity-and-scheduling.md). |
| Assignment and attempt identity | A plan slot belongs to an assignment, not to an attempt. Every retry has its own run ID and the `recovery` execution role, and it re-enters the admission queue holding the slot it already owns, which prevents an attempt from queuing behind itself. See [worker dispatch mechanics](worker-dispatch-mechanics.md#51-failure-classification-and-retries). |
| Whole-plan admission | Preflight and reservation finish before any worker starts. Missing candidates, authority, or verifiable boundaries refuse admission. Manual pins and `failover: none` retain their declared constraints. |
| Write attribution | The compiler refuses a scheduling wave that mixes boundary-declaring steps with steps that declare none, or that holds more than one step that may write, unless the plan declares the single-writer mode `writers: 1`. A boundary is verified by diffing one shared checkout, so concurrent writers could not be attributed. The scheduler enforces the compiled boundary after the step. |
| Loop termination | The scheduler marks later loop nodes `unneeded` after a loop terminates, so a declared attempt that was never needed does not run. |
| Verification freshness | A later workspace step can invalidate an earlier verification. Before a dependent treats it as satisfied, the scheduler reruns the affected check, at most `STALENESS_REVALIDATION_LIMIT` (3) times per verification in one plan. |
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
