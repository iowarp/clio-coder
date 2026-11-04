---
title: "Worker subprocess protocol and entry point"
summary: "How the worker subprocess is started, receives its WorkerSpec on stdin, is admitted by the orchestrator, streams NDJSON on stdout, and shuts down. Read this when changing the worker wire protocol, stdin handling, stdout bounds, or spec validation."
sources:
  - "src/worker/entry.ts"
  - "src/worker/protocol.ts"
  - "src/worker/stdin-demux.ts"
  - "src/worker/spec-contract.ts"
  - "src/worker/ndjson.ts"
  - "src/worker/ledger-mirror.ts"
  - "src/worker/context-seed.ts"
  - "src/worker/resource-facts.ts"
symbols:
  - "main"
  - "announceWorker"
  - "createWorkerStdinDemux"
  - "createOrderedSteerHandler"
  - "emitEvent"
  - "drainStdout"
  - "exitAfterDrain"
  - "parseWorkerSpec"
  - "validateRehydratedWorkerRuntime"
  - "WORKER_SPEC_VERSION"
  - "workerSpecDigest"
  - "createWorkerAgentLedgerPort"
  - "parseWorkerContextSeed"
  - "observeWorkerResourceFacts"
tests:
  - "tests/contracts/worker-boundary.test.ts"
  - "tests/contracts/worker-readonly-dispatch.test.ts"
  - "tests/extended/worker-context-dispatch.test.ts"
invariants:
  - "A worker reads exactly one WorkerSpec line from stdin first; a spec whose specVersion is not in WORKER_SPEC_VERSIONS is rejected before any model call."
  - "After announcing its identity on the control lane, the worker starts no model run until an admit frame whose specDigest equals the digest it attested arrives on stdin; a wrong digest, a missing digest, or a closed channel exits with code 2."
  - "Each NDJSON stdout frame is at most WORKER_BULK_FRAME_MAX_BYTES; the first oversize, unserializable, backlog-overflow or write failure stops the run and makes the exit code nonzero."
  - "Steer lines are delivered to the runtime in stdin order, and a steer without a positive integer sequence is dropped."
  - "When the control channel closes after the spec is received, the run is aborted and the process is forced to exit after CHANNEL_CLOSE_EXIT_GRACE_MS if the run does not settle."
validate:
  - "pnpm run test:file -- tests/contracts/worker-boundary.test.ts"
  - "pnpm run test:file -- tests/contracts/worker-readonly-dispatch.test.ts"
---

# Worker subprocess protocol and entry point

The worker is the subprocess that executes one dispatched agent run. This page covers the process boundary: how `src/worker/entry.ts` starts, how it reads its spec and admission from stdin, how it writes events to stdout, and how it ends. Read it before changing the worker wire protocol, the spec contract, or the stdout and stdin bounds. The dispatch side that spawns workers is documented separately in [domains/dispatch.md](domains/dispatch.md), and the engine that runs the model loop is in [engine.md](engine.md).

## What this area does

The worker process has four jobs.

1. It receives a `WorkerSpec` as the first stdin line and validates it.
2. It rehydrates the runtime descriptor from the runtime registry and checks it against the spec.
3. It announces a digest of its identity on the control lane and waits for the orchestrator's `admit` frame before any model call.
4. It runs the agent through `startWorkerRun` and streams events as NDJSON on stdout, with bounded output.

## Ownership

| Path | Responsibility | Key symbols |
| --- | --- | --- |
| `src/worker/entry.ts` | Process entry: builds the `WorkerRunInput`, announces, awaits admission, wires steer and permission handlers, monitors the channel, exits. | `main`, `announceWorker`, `configuredNodeLabels`, `announcedProcessGroupId`, `CHANNEL_CLOSE_EXIT_GRACE_MS` |
| `src/worker/spec-contract.ts` | `WorkerSpec` version constants, the spec parser, and the runtime rehydration check. | `WORKER_SPEC_VERSION`, `WORKER_SPEC_VERSIONS`, `WORKER_SPEC_HOOKLESS_VERSION`, `workerSpecVersionFor`, `parseWorkerSpec`, `validateRehydratedWorkerRuntime`, `WORKER_EXIT_PERMISSION_REQUIRED` |
| `src/worker/protocol.ts` | Wire constants, frame byte limits, attestation and resource types, the agent-ledger and hook frame parsers, and digest helpers. | `WORKER_PROTOCOL_VERSION`, `WORKER_BULK_FRAME_MAX_BYTES`, `WORKER_STDIN_FRAME_MAX_BYTES`, `WORKER_ADMISSION_WAIT_MS`, `workerSpecDigest`, `endpointIdentityHash`, `parseAgentLedgerEntry`, `parseWorkerHookRequest` |
| `src/worker/stdin-demux.ts` | Splits stdin into lines and routes them: the spec, `admit`, `steer`, `permission_decision`, `ledger_delta`, `hook_result`. | `createWorkerStdinDemux`, `createOrderedSteerHandler`, `WorkerStdinDemux`, `WorkerPermissionDecision`, `WorkerDecisionBinding` |
| `src/worker/ndjson.ts` | Bounded NDJSON emitter for stdout, the failure marker on stderr, and the exit-after-drain sequence. | `emitEvent`, `drainStdout`, `exitAfterDrain`, `onStdoutFailure`, `stdoutFailure`, `WORKER_STDOUT_UNDRAINED_REASON` |
| `src/worker/ledger-mirror.ts` | Worker-local mirror of the agent ledger and the port a tool call uses to read it and post to it. | `createWorkerAgentLedgerMirror`, `createWorkerAgentLedgerPort`, `WORKER_AGENT_LEDGER_POST_CAP` |
| `src/worker/context-seed.ts` | Validates the optional native history seed (`contextSeed`) and its provenance. | `parseWorkerContextSeed`, `parseWorkerContextProvenance`, `WORKER_CONTEXT_MAX_BYTES` |
| `src/worker/resource-facts.ts` | Observes the node's CPU, memory, and GPU facts for the announce. | `observeWorkerResourceFacts`, `observeHostIdentity` |

The entry file is the only caller of most of the other modules. `src/cli/index.ts` is an importer of `src/worker/entry.ts` in the module graph, but the worker is started as a separate process, so the entry is run as a program rather than called as a function.

## Spec contract

`parseWorkerSpec` in `src/worker/spec-contract.ts` is the single parser for the spec. It reads `specVersion` first and accepts only values in `WORKER_SPEC_VERSIONS`, which is currently `[8, 9]`. Version 9 is the version that carries `extensionHooks`. A spec that carries `extensionHooks` but declares version 8 is rejected with a message that names version 9. A spec with no hooks may be version 8 or 9.

Other checks in the same function include:

- `budget` must be present.
- `settingsFingerprint` must be a 64-character lowercase hex string.
- `runtime.version` must equal `WORKER_RUNTIME_DESCRIPTOR_VERSION`, and `runtimeId` must equal `runtime.id`.
- `contextSeed`, when present, is validated by `parseWorkerContextSeed` and requires an HTTP runtime.
- `helperResult`, when present, must be `true` and needs a supported internal result contract.
- `onPermission` must be `"deny"`, `"fail"`, or `"escalate"`.
- `devRootOwner` must be a UUID.

The spec is then checked against the runtime from the registry. `validateRehydratedWorkerRuntime` compares `id`, `kind`, `apiFamily`, and `auth` between the spec's `runtime` and the rehydrated `RuntimeDescriptor`, and throws on the first mismatch. `src/worker/entry.ts` treats that throw as exit code 2.

`parseWorkerSpec` is called from `createWorkerStdinDemux`'s `processLine` through `resolveSpec(parseWorkerSpec(JSON.parse(line)))`. A parse failure rejects the `readSpec()` promise, which `main()` turns into a `fatal:` stderr line and `exitAfterDrain(2)`.

Focused tests: `tests/extended/advisory-dispatch-budgets.test.ts` calls `parseWorkerSpec(spec)` and asserts `budget.mode` is `"enforced"` after a JSON round trip. `tests/contracts/worker-readonly-dispatch.test.ts` asserts that a spec with `specVersion: WORKER_SPEC_HOOKLESS_VERSION - 1` is refused. `tests/extended/worker-context-dispatch.test.ts` asserts that `parseWorkerSpec` rejects `specVersion: 3`.

## Stdin demux and admission

`createWorkerStdinDemux` in `src/worker/stdin-demux.ts` is fed by `process.stdin` data events from `src/worker/entry.ts`. `feed` accumulates the buffer and splits on newline. Before splitting, it checks each line with `withinFrameBudget` against `WORKER_STDIN_FRAME_MAX_BYTES`, and an oversize line is discarded up to the next newline. An oversize spec line rejects the spec promise.

The first non-empty line is the spec. After that, `processPostSpecLine` recognizes these messages:

- `steer` with non-empty `text` and a positive safe-integer `sequence`.
- `permission_decision` with `requestId` and `decision` of `"approve"` or `"deny"`. A malformed `binding` is dropped to `undefined`, not the whole frame.
- `ledger_delta` with at least one entry that passes `parseAgentLedgerEntry`.
- `hook_result`, parsed by `parseWorkerHookResult`. It is dropped and counted when no hook handler is registered.
- `admit` with a 64-character hex `specDigest`. Only the first `admit` counts, and a repeated one is counted as dropped.

Anything else is counted in `droppedLines`. `main()` logs that count in its `finally` block.

Admission is the gate between the announce and the first model call. In `src/worker/entry.ts`, `announceWorker` emits the `announce` control frame and returns the digest. `main()` then calls `demux.awaitAdmission(attestedDigest, WORKER_ADMISSION_WAIT_MS)`. The promise resolves when an `admit` frame names that digest. It rejects in three cases:

- The admit frame carries a different digest or no usable digest (`admissionVerdict`).
- The channel closes before admission (`eof` calls `finishAdmission` with an error).
- No admit arrives within `timeoutMs` (the timer in `awaitAdmission`).

On rejection, `main()` writes `[worker] not admitted:` to stderr, stops the heartbeat, and returns 2. The focused test in `tests/contracts/worker-boundary.test.ts`, "exits unadmitted with code 2 on a wrong digest or a closed channel", sends an admit with `"0".repeat(64)` in one case and ends stdin in the other. It asserts exit code 2, the `not admitted` stderr line, empty stdout, and zero model requests. The companion test "starts no model run until the orchestrator admits the attested digest" checks that stdout is empty and the request count is zero for 500 ms after the announce, and only after the matching `admit` does a request arrive.

Steer and permission lines that arrive before the runtime handle exists are buffered in arrays (`pendingSteers`, `pendingPermissionDecisions`) and flushed when `onSteer` or `onPermissionDecision` registers a handler.

## Steer ordering

`createOrderedSteerHandler` chains each delivery onto a promise `tail`, so a later steer does not reach the runtime before an earlier one finishes. The `deliver` callback may return a boolean or a promise. When it returns true, `onAccepted` runs with the steer, which `src/worker/entry.ts` turns into the `clio_coder_steer_received` event carrying the sequence. When it returns false or throws, `onRejected` gets a reason string.

The test "serializes live steering and acknowledges exact accepted sequences" in `tests/contracts/worker-boundary.test.ts` sends three steers, and the middle text is `"refuse"`. It asserts that `delivered` is `["first", "refuse", "third"]` in that order, `accepted` is `[1, 3]`, and exactly one rejection mentions `does not accept`.

## Stdout bounds

`emitEvent` in `src/worker/ndjson.ts` is the only writer of event frames. For each event it:

1. Returns immediately if a failure was already recorded.
2. Serializes with `JSON.stringify`. A throw or a non-string result is a failure.
3. Compares the line's byte length to `WORKER_BULK_FRAME_MAX_BYTES`.
4. Compares `process.stdout.writableLength + bytes` to `WORKER_STDOUT_BACKLOG_MAX_BYTES`.
5. Writes the line with a callback that records a `write-failed` failure on error.

`failOutput` records the first failure only. It writes an incomplete marker and a typed failure JSON to stderr, then calls the handler registered by `onStdoutFailure`. In `src/worker/entry.ts` that handler is `queueMicrotask(abortOnce)`, so a failure aborts the run.

`drainStdout` writes an empty string and waits for its callback, with a default 2000 ms timeout. A timeout records an `undrained` failure. `exitAfterDrain` returns the exit code unchanged only when the drain was complete or the code was already nonzero, and otherwise forces 1.

The test "reports the frame actually written, its errno and the worker's typed stdout failure (#425)" and the drain tests in `tests/contracts/worker-boundary.test.ts` exercise these failure paths.

## Shutdown

`src/worker/entry.ts` runs the model loop through `handle.promise`. It aborts the run in three situations: the control channel closes after the spec (`demux.onChannelClose`), a stdout failure occurs, or `SIGINT` or `SIGTERM` is received. `abortOnce` is idempotent. It emits a `cancel_ack` control frame and calls `handle.abort()`. After a channel close, a timer of `CHANNEL_CLOSE_EXIT_GRACE_MS` (5000 ms) forces `process.exit(1)`, and the timer is unref'd so it does not hold an otherwise finished process open.

The `finally` block of `main()` sets `runSettled`, clears the force-exit timer, stops the heartbeat, removes the signal listeners, and logs the dropped stdin line count.

## Agent ledger mirror

The orchestrator pushes ledger entries as `ledger_delta` lines. `createWorkerAgentLedgerMirror` keeps them keyed by sequence, drops duplicates, and caps the mirror at 200 entries. `createWorkerAgentLedgerPort` answers `read()` from the mirror without a round trip. Its `post()` method refuses locally with `no-ledger`, `invalid-body`, or `per-run-cap` (limit `WORKER_AGENT_LEDGER_POST_CAP`, 20). An accepted post becomes a `ledger_post` control frame. The comment in the module states that the orchestrator enforces the same rules authoritatively at append.

No focused test for the ledger mirror was located. The contract test `tests/contracts/agent-ledger-projection.test.ts` is listed in the ownership search output, but its contents were not inspected for this page, so the mirror's behavior is described from `src/worker/ledger-mirror.ts` alone.

## Context seed and resource facts

`parseWorkerContextSeed` in `src/worker/context-seed.ts` rejects a seed whose JSON exceeds `WORKER_CONTEXT_MAX_BYTES` (512 KiB), validates each message role (`user`, `assistant`, `toolResult`), and checks provenance fields including 64-character hashes and the `selectedRefs` format. `parseWorkerSpec` calls it, and the spec parser also requires an HTTP runtime for a seed.

`observeWorkerResourceFacts` in `src/worker/resource-facts.ts` reports CPU count and memory from the OS. GPU count and VRAM come from `nvidia-smi` with a 1000 ms timeout, and any failure reports unknown. `residentModels` is always unknown. The result is attached to the announce. The attestation comparison in `verifyWorkerAttestation` is exercised by `tests/contracts/worker-boundary.test.ts`, "binds transport admission to the entire approved worker identity": changing `toolSignature` makes verification fail.

## Things to watch when editing

- The spec version constants are coupled to parser behavior. `WORKER_SPEC_VERSION` is 9 and `WORKER_SPEC_HOOKLESS_VERSION` is 8. A spec carrying `extensionHooks` must be version 9, and `workerSpecVersionFor` returns the lowest version that fits. A new version field must be added to `WORKER_SPEC_VERSIONS` for the worker to read it.
- The announce digest is computed by `workerSpecDigest` over the canonical JSON of the whole spec. The orchestrator compares it against the same digest it computed, so any change to what is attested changes the digest and needs the approved identity to match.
- `WORKER_STDIN_FRAME_MAX_BYTES` is checked before `JSON.parse`. An oversize line is discarded, not parsed.
- Stdout frames must go through `emitEvent`. Writing to `process.stdout` directly bypasses the byte and backlog checks and the failure recording.
- The control lane (`emitControlFrame` in `src/worker/control-lane.ts`) and the bulk lane (stdout) are separate. The entry sends attestation, model-loaded notices, ledger posts, and cancel acknowledgements through the control lane, and events through `emitEvent`.
- The worker never calls a model before the admit. Reordering the `awaitAdmission` call after `startWorkerRun` would change this, and the test "starts no model run until the orchestrator admits the attested digest" is the check that covers it.
