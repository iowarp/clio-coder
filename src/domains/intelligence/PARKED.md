# intelligence (parked)

Status: parked, not deleted. As of v0.2.7 this domain is no longer in the
`loadDomains([...])` list in `src/entry/orchestrator.ts`, so it does not load
into any session. The source stays in the tree.

## Intent

The intelligence domain is meant to produce intent-detection overlays: a small,
synchronous read of what the session is doing right now, classified into one of
`compose`, `edit`, `investigate`, or `idle` (see `IntentKind` in
`contracts.ts`). Those observations were planned as a future input to the
repo-adaptive profile, so static context and the evidence bar can lean on what
the operator is actually doing, not just on what the repo is.

## Why it is parked

There is no detector. `extension.ts` ships disabled: it throws if
`intelligence.enabled === true`, and the contract returns empty observations.
It is a types-only no-op today. Loading it added a domain to every session for
no behavior, so v0.2.7 drops it from the load list rather than carry a stub.

## Re-entry condition

Re-enable this domain only when both halves exist:

1. A real intent detector that emits `IntentObservation` values from live
   session signals, replacing the empty `observations()` stub.
2. A repo-profile consumer that reads those observations and adapts the static
   context or the evidence bar from them.

Until both land, keep the domain out of `loadDomains([...])`.
