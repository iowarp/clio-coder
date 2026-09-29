---
title: "Dispatch domain"
summary: "How Clio resolves, admits, executes, and finalizes worker runs: the dispatch bundle's contract, routing decisions, fleet execution, and gate-decision persistence."
sources:
  - "src/domains/dispatch/index.ts"
  - "src/domains/dispatch/extension.ts"
  - "src/domains/dispatch/types.ts"
  - "src/domains/dispatch/route-decision.ts"
  - "src/domains/dispatch/fleet-run.ts"
  - "src/domains/dispatch/execution-scheduler.ts"
  - "src/domains/dispatch/gate-decisions.ts"
  - "src/domains/dispatch/validation.ts"
  - "src/domains/dispatch/manifest.ts"
symbols:
  - "DispatchDomainModule"
  - "createDispatchDomainModule"
  - "createDispatchBundle"
  - "decideRoute"
  - "fixedRouteDecision"
  - "RouteDecisionV1"
  - "RouteCandidate"
  - "executeFleetRun"
  - "planFleetResume"
  - "ExecutionSchedulerAdapter"
  - "executePlan"
  - "GateDecisionArtifact"
  - "decideReviewGate"
  - "parseCompeteGateResult"
  - "validateJobSpec"
  - "JobSpec"
  - "RunEnvelope"
  - "RunReceipt"
  - "RunOutcome"
  - "RunLineage"
  - "RunGateProvenance"
tests:
  - "tests/contracts/dispatch-admission.test.ts"
  - "tests/contracts/route-readiness-reads.test.ts"
  - "tests/extended/route-identity-keying.test.ts"
invariants:
  - "Every admitted runtime kind enters through the native worker subprocess; the worker entry rehydrates the runtime descriptor and delegates behind the engine boundary."
  - "Hard constraints eliminate: a candidate the admission chain rejected can never appear as selected or in approvedFallbacks at any posture."
  - "The route decision is deterministic: decisionHash covers the inputs, not the wall clock, so equal inputs produce an equal hash and offline replay reproduces it."
  - "Every run that reaches finalization gets exactly one outcome, resolved at the single finalization point in extension.ts via resolveRunOutcome()."
  - "A dispatch reads only the receipts written since the previous readiness window, not the full ledger."
validate:
  - "pnpm run ci"
---

# Dispatch domain

The dispatch domain owns the lifecycle of a worker run from `DispatchRequest` through admission, spawning, event-pumping, and receipt finalization. It resolves a `DispatchRequest` to a `TargetDescriptor` plus `RuntimeDescriptor` plus wire model id via the providers contract, gates admission on safety scopes, concurrency, budget, and capability flags, then spawns a native worker subprocess that reports back over a structured event stream. The domain is pure data plus orchestration: the worker process is the only place that speaks the Pi SDK protocol, and the dispatch bundle in the orchestrator process reads that stream, meters tokens, collects tool stats, and seals the receipt.

The domain manifest at `src/domains/dispatch/manifest.ts` declares dependencies on `config`, `safety`, `agents`, `providers`, `middleware`, `prompts`, and `scheduling`. Every other domain reaches dispatch through `src/domains/dispatch/index.ts`, which re-exports the public surface: `DispatchDomainModule`, `createDispatchDomainModule`, and the `createDispatchBundle` extension factory.

## Entry point and registration

`DispatchDomainModule` is the `DomainModule` object that the core `DomainLoader` consumes during composition. It carries the `DispatchManifest` and a `createExtension` function that delegates to `createDispatchBundle`. The factory `createDispatchDomainModule(options)` wraps the extension in a closure that forwards the `DispatchBundleOptions` to `createDispatchBundle` at bundle-creation time.

The three composition roots that construct a dispatch bundle are:

- `src/entry/orchestrator.ts` (interactive mode)
- `src/cli/run.ts` (headless `clio-coder run`)
- `src/cli/fleet.ts` (headless fleet CLI)

The `makeDispatchBundle` helper in `tests/harness/dispatch.ts` mirrors the same construction for test bundles.

## The dispatch contract

`createDispatchBundle` in `src/domains/dispatch/extension.ts` returns a `DomainBundle<DispatchContract>`. The contract object (visible from line 7602 onward in `extension.ts`) exposes:

- `dispatch(req: DispatchRequest)` — the primary entry point. It validates the request, resolves the route, admits the run against capacity and budget, spawns a worker, pumps events, finalizes the receipt, and returns a `RunReceipt` via `run.finalPromise`.
- `dispatchBatch(batch: DispatchBatchRequest)` — the parallel-batch path used by the fleet execution plan.
- `preview(req)` — a side-effect-free route preview used by speculative dispatch.
- `planAgentSelection(input)` — resolves the agent-selection decision for a route decision.
- `routeCandidates(req)` — enumerates the route candidates for a dispatch.
- `reservations` — a set of prepare/release/rollback operations for dispatch capacity reservations.
- `speculate(prediction)` / `releaseSpeculative(reason)` — manages held worker processes for speculative dispatch.
- `listRuns(status)` / `getRun(runId)` — reads from the in-memory ledger.
- `observedRunWrites(runId)` / `observedRunWriteAttribution(runId)` — returns the write-targets this process finalized.
- `assignments` — get/getStored/flushWrites for assignment records.
- `drainMember(runId)` — awaits all pending work for a run member.
- `abort(runId, reason)` — cancels a live or queued run.

The `DispatchContract` type is defined in `src/domains/dispatch/contract.ts` and is the typed interface every caller sees.

## Data flow through a dispatch call

A call to `dispatch(req)` follows this path:

1. **Validation.** `validateJobSpec` in `src/domains/dispatch/validation.ts` validates the raw spec. It rejects unknown keys, enforces type constraints, checks that `failover: "approved"` carries `allowedCandidates`, validates `pipelineInput`, `predecessorHandoffs`, `lineage`, `gate`, `plan`, `competeStance`, and the dispatch-intent compatibility classification. On success it returns `{ ok: true, spec: JobSpec }`.

2. **Route resolution.** The bundle calls `planActiveRoute` or `resolveJointRoute` (via `active-route-planner.ts` / `joint-route-resolver.ts`) to resolve the target, runtime, and wire model id. The providers contract supplies `resolveRuntimeTarget` and `resolveEndpointCapacities`.

3. **Admission.** `admit` in `src/domains/dispatch/admission.ts` checks global concurrency, per-endpoint capacity, budget, and safety scope. The `createCapacityAdmissionController` manages slot leases. A `foregroundEndpointBlock` test in `tests/contracts/dispatch-admission.test.ts` demonstrates the deadlock guard: a run that needs the same endpoint already held by a foreground stream is refused without spending the queue timeout.

4. **Worker spawn.** `spawnNativeWorker` in `src/domains/dispatch/worker-spawn.ts` creates the subprocess. The worker spec (`WorkerSpec` from `src/worker/spec-contract.ts`) carries the serialized runtime descriptor, prompt composition, tool surface, budget, and protected-artifact state.

5. **Event pump.** `startDispatchEventPump` in `src/domains/dispatch/event-pump.ts` reads the worker's NDJSON stdout stream. The pump folds events into the `RunEnvelope` (token meters, tool stats, steering provenance, finish-contract entries) and collects tool-call statistics via `recordToolStart`/`recordToolFinish` in `tool-stats.ts`.

6. **Finalization.** `resolveRunOutcome` in `src/domains/dispatch/outcome.ts` resolves the terminal `RunOutcome` from the worker's exit code, heartbeat status, and termination evidence. The receipt is sealed via `withReceiptIntegrity` in `src/domains/dispatch/receipt-integrity.ts`, which computes the sha256 digest over the receipt's canonical JSON payload.

7. **Ledger write.** `writeFleetRun` in `src/domains/dispatch/state.ts` appends the `RunEnvelope` to the `runs.json` ledger and writes the sealed `RunReceipt` to `receipts/<runId>.json`.

## Route decision

`decideRoute` in `src/domains/dispatch/route-decision.ts` is the pure function that selects a route. It operates on `RouteDecisionInput` and returns a `RouteDecisionV1`. The algorithm:

1. **Hard filters.** Candidates with a non-null `rejection` are excluded from the admissible set. The count of rejected candidates is recorded as a `reasonCode`.
2. **Active readiness.** In `active` mode, candidates whose `activeReadiness.ready` is false are further excluded.
3. **Posture floors.** `clearsPostureFloors` filters candidates whose estimate does not satisfy the posture's quality/cost/latency floors.
4. **Scoring and ranking.** `scoreRoute` assigns a score to each admissible candidate. `compareRankedRoutes` orders them. For gate routes, a secondary sort breaks ties in favor of routes independent of the subject being graded (via `gateRouteCorrelation`).
5. **Dominated elimination.** `dominatesRoute` marks candidates that are strictly dominated by another on all cost-quality-latency axes.
6. **Selection.** In `manual` posture the executed route is selected. In `shadow` mode the best admissible candidate is recorded but never affects execution. In `active` mode the best candidate replaces the executed route.

The `RouteCandidate` interface names the whole operational tuple: `agentId`, `specFingerprint`, `executionRole`, `targetId`, `modelId`, `runtimeId`, `nodeId`, `thinkingLevel`, `toolSignature`, `promptCompositionHash`, `endpointIdentityHash`, and `settingsFingerprint`. The candidate key (`routeCandidateKey`) hashes these fields so two routes that differ in any one are distinct.

`fixedRouteDecision` is a failure-isolated fallback: when the route observer or its durable inputs fail, callers seal this exact one-candidate decision so a receipt never loses its routing evidence.

## Fleet execution

`executeFleetRun` in `src/domains/dispatch/fleet-run.ts` is the single fleet-run execution path. It drives a compiled `ExecutionPlan` through the `ExecutionSchedulerAdapter` and returns a `FleetRunOutcome`. The plan can contain agent steps, code steps, and loop constructs. The scheduler in `src/domains/dispatch/execution-scheduler.ts` (`executePlan`) handles wave-based parallelism, predecessor handoffs, and loop repair cycles.

`planFleetResume` in the same file produces a `FleetResumePlan` for a partially completed fleet run. It diffs the prior run record against the current plan and identifies which steps can be replayed from their sealed receipts versus which must be re-executed.

The `ExecutionSchedulerAdapter` interface exposes `preflight`, `reserve`, `run`, and optionally `runCode`. The orchestrator supplies the adapter's `run` as the dispatch bundle's `dispatch` method. `runCode` is the deterministic code-step path that takes no worker reservation.

## Gate decisions

`src/domains/dispatch/gate-decisions.ts` manages the durable evidence for review and compete gates. Worker receipts seal before a reviewer verdict or judge winner can be parsed, so the coordinator writes a separate integrity-covered `GateDecisionArtifact` that links the decider receipt to every subject receipt.

The lifecycle is:

1. **Stage.** `stagePendingGateOutput` writes a `PendingGateOutputRecord` as soon as the reviewer/judge event stream settles. At this point the decider receipt may still be finalizing, so the run id is durable but its receipt digest is not yet known.
2. **Resolve.** `resolvePendingGateDecision` binds the staged output to the now-sealed receipt and parsed outcome. `decideReviewGate` applies the coordinator's review policy: a pass or terminal-cycle fail is the verdict; a non-terminal fail earns a `revise` outcome with findings threaded to the next builder.
3. **Materialize.** `materializePendingGateDecision` writes the final `GateDecisionArtifact` to `gate-decisions/<id>.json` and clears the pending WAL record.

`verifyGateDecisionArtifact` checks the semantic validity and sha256 integrity digest. `readGateDecisionArtifacts` and `readGateDecisionArtifactsForRunIds` discover trusted decisions from receipt identities.

`parseCompeteGateResult` validates a judge's answer: the winner must be an integer 1..candidateCount, and the result must carry typed checks with evidence.

## Validation

`validateJobSpec` in `src/domains/dispatch/validation.ts` is a pure function that accepts unknown input and returns `{ ok: true, spec: JobSpec }` or `{ ok: false, errors: string[] }`. It enforces:

- **Known keys only.** Any key not in the `KNOWN_KEYS` set is rejected.
- **Briefing bounds.** `DISPATCH_BRIEFING_MAX_BYTES` is 12,000 for external callers; `INTERNAL_DISPATCH_BRIEFING_MAX_BYTES` is 64 KiB for `requestOrigin: "internal"` callers.
- **Failover consistency.** `failover: "approved"` requires non-empty `allowedCandidates`; `failover: "automatic"` is rejected on plan-approved dispatches.
- **Write roots.** When `writeRoots` is present, it must be a non-empty array of non-empty strings. The validator resolves them against the job's `cwd`.
- **Intent compatibility.** The dispatch-intent migration rules are classified here via `classifyDispatchIntentCompatibility`, so the compatibility table is true of every dispatch path (fleet, CLI, ACP, extension).

## Types

`src/domains/dispatch/types.ts` defines the shared run and receipt types:

- **`RunStatus`** — the ledger row's status: `queued`, `running`, `completed`, `failed`, `interrupted`, `stale`, or `dead`.
- **`RunOutcome`** — the terminal outcome taxonomy: `succeeded`, `failed`, `timed_out`, `stalled`, `canceled`, `denied_by_policy`, `spawn_failed`. `RETRYABLE_OUTCOMES` is the set `{failed, timed_out, stalled, spawn_failed}`.
- **`RunLineage`** — proof-of-work lineage. Retries inherit `rootRunId` and increment `attempt`; nested dispatch increments `depth` and resets `attempt`.
- **`RunEnvelope`** — the live ledger record, kept in `runs.json`.
- **`RunReceipt`** — the per-run artifact sealed under `receipts/<runId>.json`.
- **`RunGateProvenance`** — review/compete gate provenance sealed into the receipt. References point backward: a reviewer references the builder it reviewed, a revise builder references the reviewer whose findings it received.
- **`RunReceiptIntegrity`** — the receipt integrity version 20, with `algorithm: "sha256"` and a `digest` field. The version constant is annotated against this type, so bumping one without the other is a compile error.

## Tests

**`tests/contracts/dispatch-admission.test.ts`** demonstrates the admission boundary: `foregroundEndpointBlock` refuses a same-endpoint foreground deadlock without spending the queue timeout, and ordinary worker saturation remains queueable.

**`tests/contracts/route-readiness-reads.test.ts`** proves that a dispatch reads only the receipts written since the previous readiness window. It patches `fs.readFileSync` to count reads, then asserts that the first `readinessWindow()` reads 13 files (runs.json + 12 receipts), and subsequent windows on an unchanged ledger cost zero file reads.

**`tests/extended/route-identity-keying.test.ts`** demonstrates that prompt-wording edits preserve the quality denominator (all six observations remain visible), that model/target/node/runtime/spec/role/thinking changes start a fresh bucket, and that behavior-changing drift (tool surface, endpoint) invalidates the bucket without sharding it.

## Extension seams

- **`DispatchBundleOptions`** — the options bag passed to `createDispatchBundle`. It controls worker spawning (`spawnWorker`), held-worker management (`spawnHeldWorker`), node resolution (`resolveNode`), heartbeat specs, resilience cooldowns, settings access, session identity, protected-artifact state, reproducibility collection, route observation, and event journaling.
- **`ExecutionSchedulerAdapter`** — the adapter interface that `executePlan` calls to preflight, reserve, run, and optionally run code steps. The orchestrator implements it; tests provide stubs.
- **`RouteDecisionInput`** — the input to `decideRoute`. New routing policies are added by extending the `posture` vocabulary and the `scoreRoute`/`clearsPostureFloors` functions in `route-policy.ts`.
- **`JobSpec`** — the validated dispatch request. New fields are added to the `KNOWN_KEYS` set in `validation.ts` and to the `JobSpec` interface.

## Things to watch when editing

- **Receipt integrity digest.** The `RunReceiptIntegrity` version is 20. Bumping it without updating the `receipt-integrity.ts` constant is a compile error, but adding a field to `RunReceipt` without accounting for it in the canonical JSON serialization changes every digest. The `withReceiptIntegrity` function must cover the new field.
- **The `exactOptionalPropertyTypes` flag is on.** Pass optional fields with `...(x !== undefined ? { x } : {})`, never `x: undefined`.
- **Worker stdout is the NDJSON bulk lane.** One stray `console.log` in worker code corrupts the protocol. Call `drainStdout()` before exit.
- **Gate decisions are append-only.** A `GateDecisionArtifact` is sealed with a sha256 digest. Mutating it invalidates the evidence chain. Use `stagePendingGateDecision` / `materializePendingGateDecision` for the atomic write.
- **`validateJobSpec` is the single gate.** Every dispatch path (fleet, CLI, ACP, extension) goes through it. Adding a field without adding it to `KNOWN_KEYS` breaks every caller. The intent-compatibility classification is also classified here, so a change to the compatibility table requires updating this validator.
- **The route decision hash is deterministic.** `decisionHash` covers the inputs, not the wall clock. Do not add a timestamp or random value to the decision input.
- **`fixedRouteDecision` is the last-resort fallback.** When the route observer fails, callers seal this one-candidate decision. Do not add new failure modes that skip it, or receipts will lack routing evidence.
