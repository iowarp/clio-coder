---
title: "Dispatch domain: fleet runs, workers, routing and verification"
summary: "Overview of the dispatch domain under src/domains/dispatch: how a fleet run is driven, how native worker processes are spawned and supervised, how a route decision is sealed, and how host verification checks are run and recorded. Read this to find the owning file for a dispatch behavior before editing it."
sources:
  - "src/domains/dispatch/index.ts"
  - "src/domains/dispatch/fleet-run.ts"
  - "src/domains/dispatch/worker-spawn.ts"
  - "src/domains/dispatch/route-decision.ts"
  - "src/domains/dispatch/host-verification.ts"
  - "src/domains/dispatch/types.ts"
  - "src/domains/dispatch/gate-decisions.ts"
  - "src/domains/dispatch/extension.ts"
symbols:
  - "createDispatchDomainModule"
  - "executeFleetRun"
  - "planFleetResume"
  - "spawnNativeWorker"
  - "spawnWorkerProcess"
  - "decideRoute"
  - "runHostVerification"
  - "createBatchVerificationGate"
tests:
  - "tests/extended/host-verification-batch.test.ts"
invariants:
  - "A fleet run acquires the workspace fleet lock before it claims its verdict or writes a root record, so a refused run leaves no durable trace (executeFleetRun in src/domains/dispatch/fleet-run.ts)."
  - "runHostVerification returns undefined when no resolved checks are declared, and reports status skipped with reason worker_not_successful without executing checks when the worker did not succeed."
  - "decideRoute in active mode throws posture-floors-unsatisfiable when no admissible candidate clears the posture floors; shadow and fixed modes do not throw for that condition."
  - "spawnNativeWorker forwards the caller's full SpawnOptions to spawnWorkerProcess, except the workerEntryPath field it consumes itself."
validate:
  - "pnpm run test:file -- tests/extended/host-verification-batch.test.ts"
---

# Dispatch domain: fleet runs, workers, routing and verification

The dispatch domain is the part of Clio Coder that turns a request or a compiled fleet plan into executed work. A reader needs this page when changing how a fleet run is started or resumed, how a worker child process is launched and supervised, how a route is chosen and recorded, or how declared host checks decide a run's verification status. This page is an overview. Each workflow is owned by a file listed below, and the detailed behavior of those files is documented on their own pages where they exist.

## What the domain contains

`src/domains/dispatch/index.ts` is the public surface. It exports `DispatchDomainModule`, a constant whose `createExtension` is `createDispatchBundle` from `src/domains/dispatch/extension.ts`, and `createDispatchDomainModule(options)`, which passes caller options through to `createDispatchBundle` as `DispatchBundleOptions`. The same file re-exports the helpers other layers use, including `executeFleetRun`, `planFleetResume`, `runHostVerification`, `workspaceFingerprint`, `readGateDecisionArtifacts`, and the run-record readers.

The main owning files are:

- `src/domains/dispatch/fleet-run.ts`: drives one compiled fleet plan to completion. Exports `executeFleetRun`, `planFleetResume`, `fleetPlanWaveIndex`, and the input and outcome types (`ExecuteFleetRunInput`, `FleetRunOutcome`, `FleetRunStepEvent`, `FleetRunStepOutcome`, `FleetResumePlan`).
- `src/domains/dispatch/worker-spawn.ts`: orchestrator-side subprocess spawner for the native worker. Exports `spawnNativeWorker` and `spawnWorkerProcess` and the `SpawnOptions`, `SpawnedWorker`, and `WorkerProcessCleanup` types.
- `src/domains/dispatch/route-decision.ts`: builds and evaluates the sealed `RouteDecisionV1` artifact through `decideRoute`, `fixedRouteDecision`, `evaluateRouteDecision`, and `routeOutcomeMetrics`.
- `src/domains/dispatch/host-verification.ts`: runs declared checks after a worker finishes, through `runHostVerification`, and provides `createBatchVerificationGate` for batched runs.
- `src/domains/dispatch/types.ts`: the run record types, including `RunStatus`, `RunOutcomeCode`, `RunResult`, `RunHostVerification`, and `RunHostVerificationCheck`.
- `src/domains/dispatch/gate-decisions.ts`: gate decision artifact types (`GateDecisionArtifact`, `GateDecisionOutcome`, `ReviewGateResult`, `CompeteGateResult`) and the reader and verifier exported through `src/domains/dispatch/index.ts`.
- `src/domains/dispatch/extension.ts`: the bundle that composes the domain. It is the largest file in the area and holds the admission, dynamic prompt, and target-capability helpers.

## Fleet run execution

`executeFleetRun` in `src/domains/dispatch/fleet-run.ts` is the single entry point the documentation describes for driving a compiled fleet plan. Its only documented caller in this tree is the fleet command: `src/cli/fleet.ts` calls `planFleetResume` for a resume request and then `executeFleetRun` with the compiled `plan`, a registered emergency seal callback, and the other run inputs. The orchestrator in `src/entry/orchestrator.ts` and the joint route resolver in `src/domains/dispatch/joint-route-resolver.ts` also reference this area; their call sites were not read.

The control flow in `executeFleetRun` is:

1. It calls `acquireFleetWorkspaceLock` with the workspace root and the fleet root id. The comment at that line states that the lock is taken before the root claims its verdict or writes a record, so a refused run leaves no durable trace.
2. It registers an emergency seal with `input.registerEmergencySeal`, if the caller supplied one, so forced shutdown can persist the run's final state and release the lock.
3. It opens the root telemetry journal with `openFleetRootTelemetry`. If that fails, the function throws an error whose message begins `fleet root telemetry journal unavailable`.
4. It calls `input.onStarted` and then `runFleetHoldingWorkspace`, which keeps the lock for the whole run.
5. In its `finally` block it closes the root telemetry, releases the lock, and unregisters the emergency seal. A failed lock release is reported through `input.onNotice` and does not throw.

Inside `runFleetHoldingWorkspace`, the run record is written with `writeFleetRun` before any step is dispatched. The run claims its assignment verdict with `claimAssignmentVerdict(fleetRootId, "fleet")` before the root record exists. Each step dispatches under the root id as lineage root, so the run, not the last step, settles the verdict. Step dispatch events are appended to the fleet event journal as `step_dispatched`, and the run ends with a `fleet_sealed` event carrying `succeeded`, `failed`, or `aborted`. Replayed steps, supplied through `input.resume.replayed`, do not produce a `step_dispatched` event.

`planFleetResume` in the same file returns either `{ ok: true, replayed }`, where `replayed` maps step ids to prior `ExecutionStepResult` values, or a refusal. The comparison uses the stored plan's step identities (`stepIdentity`, `withoutEndpoint`, `canonicalPath`) and the stored variables (`sortedVars`). The fleet command maps the `fleet-name` refusal reason to its own message; the other refusal reasons were not read.

## Worker spawning

`spawnNativeWorker` in `src/domains/dispatch/worker-spawn.ts` starts a worker child. Its inputs are a `WorkerSpec` and optional `SpawnOptions`. It resolves the entry script from `opts.workerEntryPath`, or from `dist/worker/entry.js` under the package root by default. It strips `workerEntryPath` from the options and forwards the remaining options to `spawnWorkerProcess`, with `env` set to `withCompileCacheEnvironment(opts?.env ?? process.env)`. The code comment states that the function forwards the whole option set so callbacks a caller passed are not dropped.

`spawnWorkerProcess` calls `launchWorkerChild`, which runs the child with `stdio` set to three pipes, the given `cwd`, the environment from `withClioAgentEnvironment`, and `detached: true`. The comment in that function says the worker leads its own process group so abort escalation covers descendants. `attachWorkerChannel` then writes the spec to the child and wires the two protocol lanes. It reads its timing from `WorkerProcessOptions` with defaults `DEFAULT_SHUTDOWN_GRACE_MS`, `DEFAULT_ATTESTATION_GRACE_MS`, and `WORKER_ANNOUNCE_DEADLINE_MS`. Line framing is handled by `createLineReader`. The cleanup bound is `WORKER_PROCESS_CLEANUP_BOUND_MS`. The detailed protocol behavior of these lanes was not traced in full.

`withCompileCacheEnvironment` enables the Clio compile cache once per process and passes the cache directory to the child through `workerCompileCacheEnvironment`. The comment explains that `NODE_COMPILE_CACHE` is the only control Node reads early enough for the worker's static graph.

## Route decisions

`decideRoute` in `src/domains/dispatch/route-decision.ts` takes a `RouteDecisionInput` with a `mode` (`fixed`, `shadow`, or `active`), a `posture`, and a list of `candidates`, each carrying a hard `rejection` (or null), an `estimate`, and an `activeReadiness` flag. The function does the following:

- It counts candidates whose `rejection` is not null and records `hard-filter-rejected-N` in the reason codes.
- In `active` mode only, it removes candidates whose `activeReadiness.ready` is false and records `active-readiness-excluded-N`.
- It keeps candidates that clear the posture floors through `clearsPostureFloors`. If none clear them, it records `posture-floors-unsatisfiable`. In `active` mode it throws `route decision: posture-floors-unsatisfiable`. In `shadow` mode the failed floor is reported without changing execution.
- It ranks the remaining candidates. The enumeration order of the caller is the stable tie break.

The comment on `decideRoute` states that at `manual` posture the operator named the route, so the executed route is selected and the alternates are recorded but never promoted. `fixedRouteDecision` is the separate constructor for the fixed path. `evaluateRouteDecision` compares a decision with a `RouteRealizedOutcome` to produce a `RouteEvaluation`. The routing types are the `RouteCandidate`, `RouteDecisionV1`, and `RouteRegret` interfaces in the same file. The test coverage for route decisions was not located; a repository-wide search for `decideRoute` and the reason codes above in `tests` returned no matches, and the search did not cover `.clio-coder`.

## Host verification

`runHostVerification` in `src/domains/dispatch/host-verification.ts` takes a `runId`, a `request` whose `resolvedVerification` lists checks, a `workerSuccessful` flag, an optional `stateDir`, `env`, and `onDiagnostic`. It behaves as follows:

- If `resolvedVerification` is undefined or empty, it returns `undefined`, and no check runs.
- If `workerSuccessful` is false, it returns `{ status: "skipped", reason: "worker_not_successful", checks: [] }` without executing any check.
- Otherwise it runs each resolved check in order through `runResolvedCheck`, collects each result's `check` record, and returns `status: "verified"` when every check has `exitCode` 0 and `status: "rejected"` otherwise.

`runResolvedCheck` passes results through `judgeResolvedCheck`, and it consults a memo file under the state directory (`memoPath`, `readMemo`, `storeMemoEntry`) keyed by `memoKey`. `workspaceFingerprint` and `checkedTree` identify the workspace state the memo is valid for. `implicatedPaths` extracts path-like tokens from a failing check's output. `createBatchVerificationGate` groups participants of a batch and uses `checkDedupeKey` to deduplicate identical checks. `compareHostVerificationBase` compares the current checkout against a base revision through dependency manifests (`DEPENDENCY_MANIFESTS`). The memo, batching, and base-comparison logic is not described beyond these names, because the full bodies of those functions were not read.

The focused test is `tests/extended/host-verification-batch.test.ts`. Its `check` helper builds a `ResolvedCheck` whose `argv` is `process.execPath` with an inline script that appends `ran` to a log file, prints a message to stderr, and exits with the given `exitCode`. Its `member` helper builds a `BatchVerificationParticipant` from a scratch project, a declared scope intent, and `workerSuccessful`. The file imports `runHostVerification`, `createBatchVerificationGate`, `compareHostVerificationBase`, `hostVerificationRejection`, and `workspaceFingerprint`, and the `runCount` helper counts executions recorded in the log. The individual assertions beyond setup were not read, so no specific assertion outcome is claimed here.

## Callers and dependencies

Upstream, `src/cli/fleet.ts` is the inspected caller of `executeFleetRun` and `planFleetResume`. `src/entry/orchestrator.ts` and `src/domains/dispatch/joint-route-resolver.ts` reference the spawn and route functions per a repository search; those call sites were not read. Downstream, the fleet run imports the workspace lock, the telemetry journal, the assignment store, and the state writer (`writeFleetRun`), and host verification imports the sandbox availability helper and the verify catalog (`src/tools/verify/catalog.ts`, `src/tools/verify/scripts.ts`), as shown by the imports in the focused test. The test imports from `src/core/sandbox/availability.ts` and `src/tools/verify/scripts.ts`.

## Related pages

- [Architecture](../architecture.md) covers the overall layering.
- [Session control](../session-control.md) and [Engine](../engine.md) cover adjacent execution surfaces that were not inspected.
- [Domains safety](safety.md) covers the admission and boundary policy that dispatch consumes.
- [Tools verify](../tools/verify.md) covers the project check catalog used by host verification.

## Things to watch when editing

- `executeFleetRun` takes the workspace lock before claiming the assignment verdict, and the code comments say a refused run must leave no durable trace. Moving the root record write or the verdict claim ahead of the lock changes that property.
- `decideRoute` treats `active` and `shadow` differently for `posture-floors-unsatisfiable`: active throws, shadow reports. Any change to that branch changes execution behavior, not only the recorded explanation.
- `spawnNativeWorker` strips only `workerEntryPath` before forwarding options. Adding a new field that the function should consume itself must be handled there, or it reaches `spawnWorkerProcess` unchanged.
- `runHostVerification` marks a run `verified` only when every check exits 0. A worker that did not succeed never reaches check execution.

## Coverage notes

This overview traced the fleet run entry and its lock and verdict ordering, the native spawn options forwarding, the route decision posture branch, and the host verification entry and skip branch. The fleet event journal, the worker protocol lanes, the route evaluation metrics, the memo and batch gate internals, and the gate decision readers were located but not read in full, and this page does not describe their behavior.
