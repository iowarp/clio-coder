# Dispatch Architecture Rationale

Why `src/domains/dispatch/` is one domain, why one import out of it looks
irregular and is allowed to, and why the repository has no barrel-only import
convention. No code moved as a result of this document. It exists so that a
later split is argued from invariants rather than from file counts.

Counts verified against the current tree: 65 TypeScript files in
`src/domains/dispatch/`, a 137-line barrel at `src/domains/dispatch/index.ts`,
and one dispatch → eval import.

---

## Size does not argue for a split

A five-way split by responsibility label is the obvious proposal and the wrong
one. The invariants in this domain are not partitioned by the labels such a
split would use. They cross them.

### Invariants that cross the proposed seams

| Invariant | Crosses | Evidence |
| --- | --- | --- |
| A retry is `recovery`, and rebinds its reservation to the node and cost bound it actually resolved | routing, admission, retries, receipts | `execution-role.ts`, `capacity-lease.ts`, `routing-intent.ts` |
| A plan slot belongs to an assignment, never an attempt, so a retry never queues behind itself | admission, scheduling, retries | `admission-queue.ts` |
| Whole-plan preflight and reservation happen before any spawn | scheduling, admission, write boundaries | `execution-scheduler.ts` |
| Route history keys on capability, and a receipt's `quality` block must be run-local | routing, receipts, quality | `route-history.ts`, `route-quality.ts` |
| Write-boundary attribution is per scheduling *window*, so the compiler refuses a wave with two writers | scheduling, write boundaries, plan compilation | `execution-plan.ts`, `write-boundary.ts` |
| A loop's later nodes are `unneeded`, decided by the scheduler, not the plan | plan compilation, scheduling, receipts | `fleet-plan.ts`, `execution-scheduler.ts` |
| Staleness revalidation re-runs a verification a later workspace step invalidated | scheduling, plan compilation, code steps | `execution-scheduler.ts` |
| Receipt integrity v15 seals normalized routing intent | routing, receipts | `receipt-integrity.ts`, `routing-intent.ts` |

The write-boundary and loop rows are the sharpest. Both are properties of a
*wave*, which is a scheduling concept computed by the plan compiler and enforced
by the scheduler. A split putting plan compilation and scheduling in different
modules puts the two halves of one invariant on opposite sides of a module
boundary, where nothing but convention keeps them agreeing.

### What a split would have to preserve

Any future split must carry these forward. A split proposal that does not
address every one of them is not ready:

1. **One hashed plan.** `compileExecutionPlan` produces one deterministic hashed
   DAG including unrolled loops. Wave computation, boundary-attribution refusal,
   and authority grants are all decided there. Splitting compilation from
   scheduling requires the wave contract to become an explicit, versioned
   interface rather than an in-process assumption.
2. **Admission is serialized by one cross-process lock.** Lease acquisition,
   retry rebinding, heartbeat, drain, and reservation transfer are one critical
   section. A split that puts any of them behind a separate module's API must
   not introduce a second lock or a lock-free path.
3. **Attempt identity.** Assignment id and terminal run id are distinct, and
   role derivation (`recovery` for every attempt after the first) is read by
   routing, receipts, history, and the ledger. This is a shared vocabulary, not a
   routing detail.
4. **Fail-closed defaults.** No-ready-candidate, manual pins, `failover: none`,
   missing authority grants, and unverifiable boundaries all refuse. A split must
   not create a module whose default answer is permissive.
5. **Receipt sealing is the authority.** The orchestrator's validation, not the
   worker's, decides conformance. Any split must keep sealing on the
   orchestrator side of the new seam.

### Recommendation

Do not split cross-domain, and do not split `dispatch` on responsibility labels.
Internal cohesion is available and safe: extracting a pure reducer or a
single-owner helper into another file *within* `src/domains/dispatch` costs
nothing and needs only the existing tests. `route-quality.ts` and
`routing-intent.ts` are already this shape and are the model to follow.

A genuine split, if it is ever wanted, should be argued from the wave contract
outward, because that is the one seam the invariants above actually respect.

---

## Dispatch reads an eval parser the eval barrel does not export

`src/domains/dispatch/route-observer.ts` imports `parseEvalArtifactV4` from
`../eval/artifacts/store.js`. The eval barrel does not export it. This is the
only dispatch → eval import in the domain.

This is coupling worth recording, not a violation. It breaks none of the five
enforced boundary rules, and the direction is defensible: the routing quality
reducer treats an eval artifact as evidence, so it must parse one, and
`parseEvalArtifactV4` is the strict fail-closed parser rather than a convenience
reader. Routing quality reading eval evidence through the artifact's own
validating parser is better than routing quality inventing a second reader that
could accept an artifact the eval domain would reject.

Widening the eval barrel to export it would be a public-surface change made only
to satisfy import form, which is exactly what the barrel decision below rejects.
If the coupling is ever to be removed, the honest fix is for the eval domain to
own a narrow "read an artifact as routing evidence" function and export that,
which is a design change needing its own justification.

---

## The repository has no barrel-only import convention

Direct subpath imports are permitted. This is a decision, not a postponement.

The evidence that decides it:

- Measured across `src/domains/**`, counting an import as cross-domain when the
  importing file and the resolved target sit in different `src/domains/<name>`
  directories: **110** cross-domain subpath imports against **29** cross-domain
  barrel imports. Direct subpath import is the majority pattern by roughly four
  to one, not an exception to a rule.
- All five enforced boundary rules
  (`tests/boundaries/check-boundaries.ts`) constrain dependency **direction**:
  who may depend on whom. Not one constrains import **form**. There is no rule
  to be half-consistent with.
- `src/domains/dispatch/execution-plan.ts` imports `AgentAutomationAuthority`
  from `../agents/spec.js`, and `src/domains/agents/index.ts` does not export
  it. A barrel-only rule would have to widen the agents barrel for no reason but
  import style.

A barrel-only sixth rule would require widening many barrels to re-export
symbols currently reached directly. Every one of those is a public-surface
addition justified by nothing but import style, and it would rewrite every
affected import site for no behavioral gain. A boundary rule should protect an
invariant. "Always import through the barrel" protects a preference.

What is *not* permitted is anything the five direction rules forbid, and those
stay enforced by the boundary checker that `npm run lint` runs.
