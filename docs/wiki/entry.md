---
title: "Entry composition and runtime coordination"
summary: "How the src/entry layer composes a session: extension generation reloads, the reload report, the background job host and runtime admission, the information-flow ledger, the safety judge host, and the orchestrator that wires them. Read this before changing boot order, extension publication, reload reporting, job admission, or provenance handling."
sources:
  - "src/entry/extension-reload.ts"
  - "src/entry/reload-classes.ts"
  - "src/entry/job-host.ts"
  - "src/entry/job-runtime.ts"
  - "src/entry/flow-ledger.ts"
  - "src/entry/safety-judge-host.ts"
  - "src/entry/orchestrator.ts"
symbols:
  - "createExtensionReloadCoordinator"
  - "createReloadClasses"
  - "createJobHost"
  - "createJobRuntime"
  - "jobAuthorityRefusal"
  - "createFlowLedger"
  - "admitHandoffSeedFlow"
  - "createSafetyJudgeHost"
  - "createJudgeScreen"
  - "bootOrchestrator"
tests:
  - "tests/extended/extension-reload-coordinator.test.ts"
  - "tests/contracts/job-tool.test.ts"
  - "tests/contracts/safety-judge.test.ts"
  - "tests/contracts/session-handoff-service.test.ts"
invariants:
  - "Extension generation and user-hook registrations are published as a pair: both prepared states are re-validated before either is published, and publish primitives are assignment-only."
  - "A reload that fails validation, build, or freshness discards both prepared states and emits no success line for that generation."
  - "A job host admits a job only for its current conversation, cwd and generation; a closed, unattended, or sessionless host refuses new admission."
  - "A command job that reports unresolved subprocess cleanup blocks every later command launch and every resume in that host, per the job-tool contract test for that case."
  - "A flow ledger that cannot read or persist a session's restrictions reports a refusal, and an outbound transfer from that session is refused until the ledger is repaired."
validate:
  - "pnpm run test:file -- tests/extended/extension-reload-coordinator.test.ts"
  - "pnpm run test:file -- tests/contracts/job-tool.test.ts"
  - "pnpm run typecheck"
---

# Entry composition and runtime coordination

The `src/entry` directory holds the composition layer that turns a booted process into a working session. A reader needs it when changing how extensions are reloaded, how the `/reload` report is assembled, how background jobs are owned and admitted, how information-flow provenance is carried across a session, or how the safety judge is wired into boot. The layer is composition code: it owns no domain logic, but it sequences the writers of several domains so that observers never see a mixed state.

## What this area does

- **Extension generation publication.** `src/entry/extension-reload.ts` is the only caller of the extensions reload and the only writer of the `user-hooks` middleware owner. It prepares an extension candidate, builds user-hook registrations from that candidate's captured declarations, prepares a middleware replacement, re-checks both for freshness, and only then publishes both. The publish primitives are documented as neither validating nor throwing.
- **Reload report assembly.** `src/entry/reload-classes.ts` builds the text of one `/reload` command: a settings, library, and extensions section plus a fixed list of restart-bound classes. It does not reload anything itself; it calls the existing reload functions it is given.
- **Job ownership and admission.** `src/entry/job-host.ts` creates one job controller per parent process and per current conversation. `src/entry/job-runtime.ts` supplies the ports the scheduling domain uses to admit, run, and deliver each job, and holds the command-slot and cleanup state for that host.
- **Information-flow provenance.** `src/entry/flow-ledger.ts` keeps one durable union of restricted sources per session. `admitHandoffSeedFlow` uses it to decide whether a task-memory seed can leave its source session.
- **Safety judge wiring.** `src/entry/safety-judge-host.ts` gives the safety domain's judge the operator's own messages, a one-shot completion on the judge's route, a memoized screen of third-party tool results, the decision recorder, and a transcript note writer. The judge itself lives in the safety domain and does not see the session, providers, or ledger.

## Owning symbols

- `src/entry/extension-reload.ts`: `createExtensionReloadCoordinator` returns the coordinator with `applyBoot`, `reload`, `promptGate`, `attachRuntimeTools`, and `workerHooks`. `extensionHookReceiptSink` routes hook receipts to the telemetry journal and package activity. `EXTENSION_RELOAD_REPORT_LINE_CAP` bounds the issue lines carried in one outcome.
- `src/entry/reload-classes.ts`: `createReloadClasses` returns a controller whose `run(target, reloadOperators)` produces a `ReloadReport`. `captureIssue` routes extension and hook report lines into the active report while `run` is in progress.
- `src/entry/job-host.ts`: `createJobHost(deps)` returns a `JobHost` with `tool`, `operations`, `attachChat`, and `close`. `JobHostDeps` lists the registry, bus, session, safety contract, autonomy getter, and `attended` flag the host depends on. The host builds its runtime ports with `createJobRuntime(runtimeDeps)`.
- `src/entry/job-runtime.ts`: `createJobRuntime(deps)` returns `JobRunnerPorts` (`isCurrent`, `admit`, `run`, `deliver`). `jobAuthorityRefusal` is the synchronous final check, applied at operator creation and again before each effect.
- `src/entry/flow-ledger.ts`: `createFlowLedger(deps)` returns a `FlowLedger` with `current`, `refusal`, `absorb`, `restrictionsOf`, and `isRestricted`. `admitHandoffSeedFlow` is the handoff-seed admission used by the session handoff path.
- `src/entry/safety-judge-host.ts`: `createSafetyJudgeCompletion`, `createJudgeScreen`, `operatorMessagesForJudge`, and `onJudgeDestination` are its helpers. `createSafetyJudgeHost(deps)` assembles them into a `SafetyJudgeSeat` through the safety domain's `createSafetyJudge`.
- `src/entry/orchestrator.ts`: `bootOrchestrator` is the boot entry. It constructs `createReloadClasses` (around line 3028) and `createExtensionReloadCoordinator` (around line 3039), calls `extensionReload.applyBoot()` (around line 3059), and creates the job host with `createJobHost` (around line 3820). It constructs `createFlowLedger` (around line 2398), wiring `readFlowSessionEntries` and a `hasSourceRules` check against the safety policy's information-flow rules. It constructs `createSafetyJudgeHost` (around line 3214) after the judge's one-shot port is declared, and it passes `createJudgeScreen` with a live window from the chat loop. The `/reload` path calls `extensionReload.reload()` at around lines 5410 and 5804.

## How a reload flows

The caller is the `/reload` handler in `src/entry/orchestrator.ts`, which calls `reloadClasses.run(target, ...)`. For the `extensions` target, the reload operator passed in calls `extensionReload.reload()`. Inside `run` in `src/entry/extension-reload.ts`, the order is:

1. Resolve the workspace with `realpathSync`. If it fails, the outcome is a `build-failed` rejection.
2. Call `deps.extensions.prepareReload()`. A rejected preparation is returned unchanged. A candidate whose snapshot cwd differs from the workspace is discarded with a `workspace-changed` rejection.
3. Build user-hook registrations with `buildUserHookRegistrations`. A thrown build discards the candidate.
4. Build runtime hook registrations and the prompt gate for the candidate's packages, then call `deps.middleware.prepareRegistrationReplacement("user-hooks", generation, ...)`. A rejected preparation discards the candidate with a `stale` reason.
5. Re-check `candidate.current()` and `replacement.current()`. If either is stale, both are discarded and nothing is published.
6. Call `candidate.publish()` and `replacement.publish()`, then assign the prompt gate, published packages, worker hook declarations, and worker evaluators. Only after this point are conflicts emitted and the runtime tools republished.
7. Invoke `onCommitted`. A throw from that observer is appended to the report as a line and does not turn the commit into a rejection.

The coordinator is guarded by an `inFlight` flag. A re-entrant call returns a `reentrant` rejection instead of running.

`reloadClasses` interacts with the coordinator through `captureIssue`: the `report` callback in `src/entry/orchestrator.ts` first offers each line to `reloadClasses.captureIssue`, so lines produced during an active `/reload` are folded into that report. Outside a report, lines go to stderr in headless runs or to `bus.emit("extension.load_failed", ...)` otherwise. The `onCommitted` observer calls `reloadPlugins()` only when no report is active.

## Boot ordering

`applyBoot` runs the same `run(true)` path. The difference is the degraded case: when `deps.extensions` is undefined, or the prepare step rejects, `publishProjectHooksOnly` publishes the project's own hooks under generation 1 without an extension generation.

## Reload report content

`createReloadClasses.run` snapshots the boot settings and the last reported settings. For the settings section it first calls `readStrictLayeredSettings`, then `config.reload()`, and it reports a `config.reload_failed` message captured from the bus. The restart-bound list is printed as fixed text at the end of every report. The reload report does not itself claim that any restart-bound class has been reloaded beyond that text.

## Job host lifecycle

`createJobHost` is constructed once per process. Its `owner(create)` function creates a conversation session when asked and then builds a `JobOwner` of session id, canonical cwd, and a fresh `randomUUID` generation. When the conversation changes, `retireCurrent` retires the previous owner through the controller. Bus subscriptions on `session.parked`, `session.reattached`, and `session.turn_switched` park, resume, or retire the owner. `isCurrent` requires the owner's session, generation, and cwd to match the live session and that the workspace still resolves to the same canonical path; a removed or replaced workspace cannot keep admission.

`hostRefusal` refuses in three cases, each with a fixed message: the host is closing, the host is not attended (`clio-coder run` exits after one turn and cannot own recurring jobs), or there is no persistent session.

## Job admission

`jobAuthorityRefusal` in `src/entry/job-runtime.ts` is the shared final check. It applies, in order:

1. The host refusal, then the trust refusal. The trust refusal reads five project surfaces (`safety`, `settings`, `hooks`, `extensions`, `plugins`) with `captureProjectSurface` and refuses when a surface is not trusted and has file content.
2. The `isCurrent` check on the owner.
3. For command runners, the tool-scope check: `turnAllowsTool` on the intersected constraints must admit `ToolNames.Bash`. The intersection comes from `jobTurnConstraints`, which narrows the creating scope and the current scope so neither widens the other.
4. For command runners, `attestJobCommand`. Any throw is returned as the refusal text.
5. `evaluateAdmission` with `ToolNames.Job` and the command's effects, passing the current constraints and any pending session code consent. A result other than `allow` becomes a refusal that states job approval does not approve future effects.

`createJobRuntime.check` layers the phase rules on top. It denies a canceled occurrence. It waits while an operator permission or interview decision is pending, except for create, resume, and notice delivery. It then runs `jobAuthorityRefusal`. For command jobs, a set `unresolvedCommandCleanup` flag denies with a message that no replacement command can launch in this host. Create and resume are then ready. For command runs, a counter `commandSlots` admits at most two concurrent command jobs and waits otherwise. For main-conversation runs, admission is ready only when `chat.machineTurnAvailable()` returns true.

`run` for a command runner increments `commandSlots`, calls `deps.runCommand` with a `start` callback that re-checks admission, and decrements the counter in `finally` unless cleanup was unresolved. A result with `cleanupUnresolved === true` sets `unresolvedCommandCleanup`, keeps the slot held, and emits a notice that further command launches are blocked in this host.

`main` submits the occurrence through `chat.submitMachineTurn`, passing the job id, execution id, prompt, owner session id, abort signal, job constraints, and `isAdmissionCurrent` and `onStarting` callbacks that re-run the same checks. A `refused` result becomes a `deferred` outcome. `deliver` handles three delivery kinds. A clock resume on a main job's own prompt is prefixed with `JOB_CLOCK_RESUME_PREAMBLE`. A `main_turn` delivery on a job whose `onMatch` is a main turn sends the match prompt followed by the untrusted-content banner and a size-capped JSON observation. A notice delivery calls `deps.notice` directly without a model turn.

A focused test, `tests/contracts/job-tool.test.ts`, case `"blocks replacement runs and completion claims when command cleanup is unresolved"`, runs a command whose `run` returns `{ outcome: "failed", cleanupUnresolved: true }`. It asserts the job is not complete after the first run, that a second run does not start (`effects` stays at 1 after a further tick), that `control(..., "resume")` rejects with a message matching `/cleanup/i`, and that a cancel leaves the job incomplete.

## Information-flow ledger

`createFlowLedger` in `src/entry/flow-ledger.ts` holds one union of `FlowRestrictionSet` per session. The union is persisted as `custom` session entries of type `FLOW_RESTRICTION_ENTRY_TYPE` (`clio_coder_flow_restriction`), and `flowRestrictionsFromEntries` rebuilds it by merging every such entry on read. Its state is `loadedFor` (the current session id), `carried`, `readFailure`, a per-session `known` map, a `pending` queue keyed by session id (with a `null` key for labels absorbed before a session exists), and `writeFailure`.

`sync` runs whenever the current session changes. It moves unassigned pending labels to the new session, recomputes `carried` from the session's entries plus pending labels, and records a `readFailure` if `readEntries` throws. `flush` appends each queued set to the current session with `appendEntry`, parented to the session's leaf turn, and records a `writeFailure` on error, leaving the entry queued.

`refusal()` returns the read failure only when the carried ledger has restrictions or the project has source rules. Otherwise it returns the write failure. An outbound transfer that consults `refusal()` is therefore refused when a read failed under restriction or rule conditions, and whenever a write is pending failure. `absorb` merges a new set into `carried`, queues it only when it adds restrictions, and flushes.

`admitHandoffSeedFlow(deps, sourceSessionId)` is the admission for a task-memory handoff seed. A null source id or a `restrictionsOf` throw is refused when the project declares source rules, and otherwise passes with no rule ids. A source with no restrictions passes with no rule ids. Otherwise it calls `ensureSession`, absorbs the source's labels with origin tool `memory-seed`, and returns either the `refusal()` text or the distinct rule ids. A focused test in `tests/contracts/session-handoff-service.test.ts` covers this path; this page does not restate its assertions beyond what the test file names.

## Safety judge host

`createSafetyJudgeHost` in `src/entry/safety-judge-host.ts` builds a `SafetyJudgeSeat` by calling the safety domain's `createSafetyJudge` with:

- `config`, resolved from the current settings through `resolveSafetyJudgeConfig`.
- `complete`, the completion created by `createSafetyJudgeCompletion`. That completion resolves the target and model, asks the flow admission for a refusal against the judge's destination, registers a foreground stream on the endpoint key, runs the one-shot port, and releases the stream in `finally`. A missing target or missing model throws.
- `operatorMessages`, which calls `operatorMessagesForJudge` on the session's entries. That function walks the active path, keeps only `user` messages not marked synthetic, and reduces each to the operator's own text with `operatorTextOfUserPayload`. When the judged call's `currentTurnId` is not on the leaf path but exists in the session, the path is recomputed from that turn.
- `record` and `note`. `record` forwards to `safety.decisions.recordSafetyJudge`. `note` appends a non-displayed `custom` entry of type `SAFETY_JUDGE_NOTE_CUSTOM_TYPE` (`clio-coder.safety-judge`) to the session.
- `screen`, when supplied. `createJudgeScreen` reads the newest third-party tool results since the operator's last message through `judgeScreenResults`, asks System One at `JUDGE_SCREEN_POINT` one result at a time, and returns the first source judged as directing an agent. A verdict is cached by call id until the operator speaks again. The screen returns null, and asks nothing, when System One is unbound, when the flow ledger refuses, or when there is no live window.

`onJudgeDestination` reports whether an engine would share the judge's endpoint, so the screen can avoid it.

In `src/entry/orchestrator.ts`, the judge host receives `createSafetyJudgeCompletion` with `flowRefusal: admitModelFlow`, and `createJudgeScreen` reads `systemOne`, `providers`, and `chat.screenWindow()`. The file's comment states that nothing calls the judge before the first tool call, since `systemOne` and `chat` are constructed later in boot.

A focused test, `tests/contracts/safety-judge.test.ts`, exercises the safety judge contract that this host feeds. This page does not restate its assertions because the host's own behavior is only the wiring listed above.

## Extension seams

- New extension-level reload behavior belongs in `src/entry/extension-reload.ts` inside the candidate and replacement sequence, before publication. Adding a new publish step after `replacement.publish()` changes the observable pairing and should be justified against the module's documented ordering.
- New `/reload` report sections belong in `src/entry/reload-classes.ts`. A new target requires a branch in `run`, and a new restart-bound class is recorded as text in the closing line.
- Runtime tools are published through `attachRuntimeTools` and `publishRuntimeTools`. A name already in the registry is reported as not registered rather than replaced.
- New job admission rules belong in `jobAuthorityRefusal` for rules shared by creation and effects, or in `createJobRuntime.check` for phase-specific rules. A rule added only to `check` will not run at operator creation through `jobAuthorityRefusal` unless that function is also changed.
- New flow provenance sources reach the ledger through `absorb`, with an origin tool name. `operator-bash` and `memory-seed` are the origins used in this file.

## Focused tests

`tests/extended/extension-reload-coordinator.test.ts` contains the coordinator tests. The following cases are read:

- `"publishes neither side when either final freshness check refuses"`: for each stale side, the test asserts a `stale` rejection with generation 4, no `publish:` calls on either side, a `discard:5` on both, and no emitted events.
- `"calls assignment-only publication adjacently only after both current checks"`: asserts the exact timeline `ext-prepare`, `mw-prepare:5`, `ext-current:5`, `mw-current:5`, `ext-publish:5`, `mw-publish:5`, `mw-emit:5`, `committed:5`, and one committed event with previous generation 4.
- `"rejects prepare-time refusal before publication and reports no success after it"`: a middleware rejection with active generation 7 yields a `stale` outcome and no events.

`tests/contracts/job-tool.test.ts` contains the job host and runtime cases, including `"blocks replacement runs and completion claims when command cleanup is unresolved"` described above, `"waits for an operator decision before attestation, then refuses changed or missing executables"` (which asserts `wait` before the decision and `denied` for the changed or missing executable phases), and `"job allow cannot widen creating or delegated constraints"`. Each is listed for location; the job-tool contract file was searched by the job-runtime symbol and these cases were located there, and the assertions cited above were read for the cleanup case.

## Things to watch when editing

- The publish primitives are documented as unable to refuse. All validation has to occur before `replacement.current()` is checked, or a partial publication becomes possible.
- `inFlight` is reset in a `finally`. A reload that throws inside `build` is still caught by the surrounding `try` blocks, but a change that moves code outside that `try` should be checked against this.
- Hook receipts route to telemetry under the receipt's own session id before falling back to the current session. Changing the fallback changes which conversation a `hook.ran` record is attributed to.
- `commandSlots` and `unresolvedCommandCleanup` are closure state in `createJobRuntime`, so their lifetime is that of one host. Moving command launches into another host would bypass the cleanup block.
- `FLOW_RESTRICTION_ENTRY_TYPE` is a persisted custom type name. Renaming it orphans restrictions already written to existing session files.
- `flowRestrictionsFromEntries` silently skips entries whose `data.set` fails `isFlowRestrictionSet`. The ledger therefore cannot distinguish a malformed entry from an absent one; the read path has no separate error for that case.

## Related pages

Extension package discovery and snapshot construction are owned by [domains/extensions.md](domains/extensions.md). Middleware registration tables are owned by [domains/middleware.md](domains/middleware.md). Job scheduling and the controller are owned by [domains/scheduling.md](domains/scheduling.md). The safety admission rules used by `jobAuthorityRefusal` and the judge itself are described in [domains/safety.md](domains/safety.md). Session entries and handoff are described in [domains/session.md](domains/session.md). System One points used by the judge screen are described in [domains/system-one.md](domains/system-one.md).
