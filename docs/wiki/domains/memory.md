---
title: "Memory domain: lessons, task bank and guardian"
summary: "How the memory domain keeps a task bank during a session, lets a routed model propose reminders and lessons at turn boundaries, files approved lessons into the durable store, and runs a background guardian between turns. Read this before changing memory records, intervention triggers, policy outcomes, or the guardian loop."
sources:
  - "src/domains/memory/index.ts"
  - "src/domains/memory/runtime.ts"
  - "src/domains/memory/intervention.ts"
  - "src/domains/memory/task-memory-policy.ts"
  - "src/domains/memory/guardian.ts"
  - "src/domains/memory/lesson-feedback.ts"
  - "src/domains/memory/validate.ts"
symbols:
  - "MemoryRuntime"
  - "createMemoryInterventionRegistration"
  - "runTaskMemoryPolicy"
  - "createMemoryGuardian"
  - "MemoryLessonFeedback"
  - "validateMemoryRecord"
  - "validateMemoryStore"
tests:
  - "tests/contracts/memory-lesson-lifecycle.test.ts"
invariants:
  - "A lesson offered for a task is counted as delivered only after the host reports the reminder in a submitted request; producing the offer alone records nothing (tests/contracts/memory-lesson-lifecycle.test.ts, offerLessonsForTask and acknowledgeSubmission)."
  - "An offer for the same lesson is made at most once per session in the exercised case of the lifecycle test."
  - "A flow-restricted session files no lesson at scope end, while an unrestricted session files the same lesson (tests/contracts/memory-lesson-lifecycle.test.ts)."
  - "runTaskMemoryPolicy returns a silent result with reason scope_changed when the signal is aborted or the scope is no longer current, before any model call."
  - "A model response that is not a readable operation step produces a malformed decision and does not apply its operations."
validate:
  - "node --test tests/contracts/memory-lesson-lifecycle.test.ts"
---

# Memory domain: lessons, task bank and guardian

This domain holds the memory that Clio carries across a task and across sessions. A reader needs it when changing how reminders are offered to the model, how a model's bank edits are applied, how approved lessons are stored, or how the background guardian decides to run. The entry point for the rest of the program is `src/domains/memory/index.ts`, which re-exports the public surface of the modules below. The domain is large (44 source files under `src/domains/memory`), so this page covers the central workflows and links the adjacent pages rather than auditing every file.

## What the area does

- **Task bank per session.** `MemoryRuntime` owns a `TaskMemoryBank` (`bank` field in `src/domains/memory/runtime.ts`). Model policy steps read the bank and apply their operations to it through `applyOperations`, which calls `saveKnowledge`, `saveProcedural`, `updateStatus`, and `deleteEntry` on the bank.
- **Turn-boundary intervention.** `createMemoryInterventionRegistration` in `src/domains/memory/intervention.ts` builds the registration that the orchestrator binds into the middleware chain. It decides when a policy step is worth running (trigger reasons include `interval`, `tool_error_streak`, `loop_signal`, `turn_end`, and `idle_review`) and carries deliveries and outcomes back to the feedback layer.
- **Policy step.** `runTaskMemoryPolicy` in `src/domains/memory/task-memory-policy.ts` builds a user prompt from the task, the bank, kept lessons and the trajectory, sends it through a `TaskMemoryModelClient`, reads operations and an optional reminder from the response, applies the operations, and returns a result with one of the decisions `silent`, `injected`, `gated`, `timeout`, or `malformed`.
- **Lesson feedback and filing.** `MemoryLessonFeedback` in `src/domains/memory/lesson-feedback.ts` tracks proposals, delivered reminders, and scope-end lessons, and files them into the durable lesson store under the data directory.
- **Background guardian.** `createMemoryGuardian` in `src/domains/memory/guardian.ts` runs a wake-and-tick loop between turns. It runs observation and task-maintenance steps and mines history through a `HistoryReviewSource`.
- **Store validation.** `validateMemoryRecord` and `validateMemoryStore` in `src/domains/memory/validate.ts` check the shape of persisted records and the store file.

## Ownership and composition

- `src/domains/memory/runtime.ts:MemoryRuntime` is the composition owner. Its `contract` field is the read-only view handed to other domains: prompt selection, observation status, task snapshot, intervention status, guardian state, and retention status. `configure` takes a `MemoryRuntimeInfrastructure` (settings, `cwd`, `dataDir`, `stateDir`, `currentSession`, notices, and diagnostics).
- `createIntervention` on `MemoryRuntime` wraps `createMemoryInterventionRegistration` and rebinds its callbacks: delivered entries, durable-lesson outcomes, delivery outcomes, knowledge reviews, retired kept lessons and scope end are each forwarded to `#feedback` and then to the caller's own callback. A second call throws `memory intervention already bound`. The wrapper also sets `deferBoundaryPolicy` to `this.#controller !== null`, so a boundary step waits only for a job actually in flight.
- `startGuardian` on `MemoryRuntime` builds `createMemoryGuardian` with `getKeptLessons` and `onHistoryLessons` pointed at the runtime, then the caller's dependencies, and `observations: this`. A second call throws `memory guardian already bound`.
- The orchestrator is the caller of both bindings: `src/entry/orchestrator.ts` constructs `new MemoryRuntime()` (around line 2204), calls `memoryOwner.createIntervention({...})` (around line 2762), and calls `memoryOwner.startGuardian({...})` (around line 2802).

## Intervention and the policy step

The path from a trigger to an injected reminder runs in four stages.

1. **Caller and arguments.** The intervention calls `runTaskMemoryPolicy(bank, client, input)`, where `input` is a `TaskMemoryPolicyInput` carrying the task text, trajectory, `maxTokens`, `timeoutMs`, `signal`, `isCurrent`, `workspaceRoot`, `contextLostAt`, `deterministicTrigger`, `suppressIntervention`, `previousReminder`, and an optional `pass`.
2. **Deadlines and scope.** `runTaskMemoryPolicy` takes `timeoutMs` from `positiveInteger(input.timeoutMs, TASK_MEMORY_POLICY_DEFAULT_TIMEOUT_MS)`. It returns `silent` with reason `scope_changed` before any model call if the signal is already aborted or `isCurrent()` is false.
3. **Model call.** The completion is raced against a timer and the abort signal. A timeout resolves to `timeout` with reason `deadline` and aborts the request. A transport error that is a timeout resolves to `timeout` with reason `timed_out`. Other client errors resolve to `silent` with reason `client_error`.
4. **Response gating.** A parsed response with a context reminder is checked in order: a rejected reminder (`invalid_reminder`), a missing reminder (`model_silent`), an over-budget reminder (`over_budget`), suppression, a duplicate of the previous reminder, an uncited reminder on a non-deterministic trigger (`uncited`), a reminder that cites a resolved failure (`resolved_failure`), a repeated failure without a failure lesson (`no_repeated_failure`), a reminder whose paths are not in the current workspace (`invalid_path`), and a cadence reminder without lost context (`no_lost_context`). Only a reminder that survives these checks returns `injected` with reason `intervened`.

Operations are applied before the reminder checks. `resolveOperations` drops `delete` operations whose id names nothing in the bank, and rewrites an unresolvable `save_lesson` id into a plain lesson. `applyOperations` then writes the surviving operations to the bank. A reminder that is then gated still keeps the applied bank edits; the code comments say so explicitly.

Producing a reminder is not delivery. The `injected` result only proposes the reminder. The intervention counts cited entries as delivered when the host reports the reminder in a submitted request.

### Focused test: offer, submission, delivery

`tests/contracts/memory-lesson-lifecycle.test.ts` contains a test titled "a lesson the task plainly asks about is offered once, only when the prompt lacks it and nothing else matches". It builds a registration with a kept lesson `{ id: "mem-port", text: "The GUI demo box serves the app on port 47811." }` and a second unrelated kept lesson. It asserts:

- For a task about a changelog typo, `offerLessonsForTask` returns the empty string.
- For the port question with `mem-port` already in the section (the callback returns true), it returns the empty string.
- For the port question with no match, the offer begins `Memory: [mem-port] (operator-approved) The GUI demo box`, and does not include `mem-log`.
- Before submission, the delivered list is empty.
- After `acknowledgeSubmission` receives a reminder containing the offer, the result kinds are `["durable_lesson"]` and the delivered list is `["mem-port"]`.
- A second identical request returns the empty string.

This test exercises the offer and acknowledgement surface of the registration. It does not exercise the policy model call.

## Lesson filing and the flow restriction

`MemoryLessonFeedback.scopeEnd` receives the lessons from a closing scope and files them through `#fileHistoryEntries`, `#propose`, and the store helpers. The feedback layer checks `sessionFlowRestricted(sessionId)` from its ports; in `src/domains/memory/runtime.ts` that port is wired to `this.#infrastructure?.sessionFlowRestricted?.(sessionId) === true`.

`tests/contracts/memory-lesson-lifecycle.test.ts` has a test titled "a flow-restricted session files no lesson at scope end, and a clean one still does". It creates one `MemoryLessonFeedback` with `sessionFlowRestricted` returning true and one with false, calls `scopeEnd({ sessionId: "s", lessons: [lesson] })` on each, awaits `whenSettled()`, and asserts that the restricted store holds 0 records and the clean store holds 1 record. The same test file has a second test that calls `runMemoryCommand(["promote", "--from-handoff", ...])` with a `safety.yaml` information-flow rule. That test shows that under source rules an unknown source is refused and that the rules come from the named repository, not the working directory.

## Guardian loop

`createMemoryGuardian` in `src/domains/memory/guardian.ts` exposes `state()`, `wake(reason)`, `reset()`, and `dispose()`. `wake` accepts `turn-start`, `turn-end`, `step-settled`, `settings`, or `ready`. It schedules a tick with `setTimeout` and calls `unref` on the timer. A wake that arrives during a running tick sets `wakePending`, and the tick schedules a zero-delay follow-up when it finishes.

The step checks `deps.enabled()` first and sets the state to `off` when memory is not enabled. `reset()` increments the generation, aborts the controller, clears the timer and the history source, and resets the backoff counters. A tick that finishes for a retired generation does not reschedule itself. The guardian's history work is bounded by `HISTORY_READ_BYTES_PER_WAKE` and `HISTORY_UNANSWERED_LIMIT`, whose values are declared at the top of `src/domains/memory/guardian.ts`. The guardian calls `deps.observations.runIdleStep` and `deps.live.runIdleStep` as part of this loop; the exact order of those calls within `step` was read only partially and is not described here.

## Store validation

`validateMemoryRecord` and `validateMemoryStore` in `src/domains/memory/validate.ts` reject unexpected fields and collect issues with paths. `validateMemoryStore` requires `version` to equal `MEMORY_VERSION` and `records` to be an array, and validates each record with `readMemoryRecord`. `readMemoryRecord` requires the id to match the pattern `mem-` followed by sixteen lowercase hexadecimal characters (`ID_PATTERN`) and checks the scope against `MEMORY_SCOPES`. Optional approval, observations and repository identity are read by `readOptionalApproval`, `readOptionalObservations` and `readOptionalMemoryRepositoryIdentity`. The store module (`src/domains/memory/store.ts`) and the record types (`src/domains/memory/types.ts`) were not inspected.

## Things to watch when editing

- `MemoryRuntime.createIntervention` and `startGuardian` each accept one binding per runtime instance and throw on a second call. A change that creates a second registration per runtime will fail at runtime.
- `runTaskMemoryPolicy` applies bank operations before its reminder gates run. A gated outcome still leaves the bank edits in place. Changes to the gate order change which edits persist.
- A reminder that counts as delivered depends on the host's submission callback, not on the policy's `injected` decision. Changes to `acknowledgeSubmission` or `onInjectedEntries` affect delivery counts.
- The flow restriction in `MemoryLessonFeedback` is read through `sessionFlowRestricted`. Filing of restricted scopes is covered by the lifecycle test above only for the scope-end path.
- The guardian keeps its state in closures inside `createMemoryGuardian`. Its generation counter, not the timer alone, decides whether a finished tick may reschedule.

## Related pages

- [Core](../core.md) and [Domains safety](safety.md) cover the sandbox and information-flow rules that the feedback and promotion code consult.
- [Domains context](context.md) and [Domains middleware](middleware.md) are the callers that wire memory into prompt sections and middleware hooks; this page does not trace those callers.
- [Domains session](session.md) describes the session lifecycle that supplies `currentSession` and scope-end events.

## Coverage notes

Not inspected: `src/domains/memory/store.ts`, `types.ts`, `contract.ts`, `src/domains/memory/task-bank.ts`, the remainder of `src/domains/memory/intervention.ts` beyond the trigger and offer surface, and the full `src/domains/memory/guardian.ts` step ordering. Behavior described for those areas is limited to what the anchor sources reference.
