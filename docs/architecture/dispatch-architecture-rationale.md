# Dispatch domain boundaries

The [fleet dispatch guide](../guide/fleet-dispatch.md) describes operator workflows.
`src/domains/dispatch/` owns plan compilation, admission, routing, scheduling,
worker execution, and run settlement. These responsibilities share the contracts below.

| Contract | Owners and enforcement |
| --- | --- |
| Deterministic plan | `compileExecutionPlan` ([execution-plan.ts](../../src/domains/dispatch/execution-plan.ts)) produces a version 4 plan hashed with SHA-256 over a canonical form: steps with sorted dependencies, bounded loops unrolled into check and repair nodes, scheduling waves, declared write boundaries, and per-step authority grants (`requestedAuthority` and `approvedAuthority`). The scheduler refuses an agent step whose approved authority is missing or differs from the requested one. |
| Reservation lifetime | Capacity leases serialize acquisition, retry rebinding, heartbeat, drain, and transfer under one cross-process lock. A retry rebinds its reserved member to the node and endpoint it actually resolves, and the cost bound it records is advisory. See [capacity and scheduling](capacity-and-scheduling.md). |
| Assignment and attempt identity | A plan slot belongs to an assignment, not to an attempt. Every retry has its own run ID and the `recovery` execution role, and it re-enters the admission queue holding the slot it already owns, which prevents an attempt from queuing behind itself. See [worker dispatch mechanics](worker-dispatch-mechanics.md#51-failure-classification-and-retries). |
| Whole-plan admission | Preflight and reservation finish before any worker starts. Missing candidates, authority, or verifiable boundaries refuse admission. Manual pins and `failover: none` retain their declared constraints. |
| Write attribution | The compiler refuses a scheduling wave that mixes boundary-declaring steps with steps that declare none, or that holds more than one step that may write, unless the plan declares the single-writer mode `writers: 1`. A boundary is verified by diffing one shared checkout, so concurrent writers could not be attributed. The scheduler enforces the compiled boundary after the step. |
| Loop termination | The scheduler marks later loop nodes `unneeded` after a loop terminates, so a declared attempt that was never needed does not run. |
| Verification freshness | A later workspace step can invalidate an earlier verification. Before a dependent treats it as satisfied, the scheduler reruns the affected check, at most once per verification per wave. A plan has finitely many waves, including those its plan steps add, so the reruns are bounded by the plan's own shape. |
| Run record authority | The orchestrator settles every run: it appends `run.settled` to the run's journal and then `run.sealed` over the chain, so the normalized routing intent and the run's quality facts sit under the run's seal. Quality records are local to the run. See [seals and bundles](telemetry.md#seals-and-bundles). |

Pure reducers and helpers can remain separate files within the domain while
using the same plan, identity, and lease contracts. Route history is a fold over
settled runs keyed by the executed route, and run settlement records the routing
decision actually used for the attempt.

## Imports and dependency direction

Clio Coder's public cross-domain surface goes through the owning domain's `index.ts` barrel. The [boundary checker](../../tests/boundaries/check-boundaries.ts), run by
`pnpm run lint`, forbids cross-domain `extension.ts` imports, including types.
It permits other subpath imports in most domains; the pure `turn-control` domain
may reach another domain only through its `index.ts`. The checker's permission
for a subpath does not make another domain's lifecycle extension a public API.
