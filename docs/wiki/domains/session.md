---
title: "Domains session"
summary: "The session domain owns the persistence vocabulary (SessionEntry union), the lifecycle manager, context token accounting, the compaction pipeline, the task board store, and the pure validating continuity fold. It defines what a session is on disk and how a turn flows from append to durable replay."
sources:
  - "src/domains/session/index.ts"
  - "src/domains/session/entries.ts"
  - "src/domains/session/extension.ts"
  - "src/domains/session/contract.ts"
  - "src/domains/session/context-accounting.ts"
  - "src/domains/session/compaction/compact.ts"
  - "src/domains/session/task-board.ts"
  - "src/domains/session/continuity/fold.ts"
  - "src/domains/session/migrations/index.ts"
symbols:
  - "SessionEntry"
  - "SessionContract"
  - "SessionDomainModule"
  - "compact"
  - "createTaskBoardStore"
  - "foldContinuity"
  - "runMigrations"
  - "estimateAgentContextTokens"
  - "captureContextSnapshot"
  - "toTaskLedgerEntryFields"
  - "foldTaskBoard"
tests:
  - "tests/contracts/continuity-fold.test.ts"
  - "tests/extended/task-board-done.test.ts"
invariants:
  - "A session append may only parent onto this session's current leaf; the extension throws if a foreign parent id reaches disk."
  - "Each taskLedger entry is a full snapshot, so the last one wins; earlier entries are history, not deltas."
  - "A continuity fold never performs the action it proposes; it returns a proposed recovery action and lets the caller execute it."
  - "The migrations reader refuses sessions from future format versions and does not transform ledgers below version 3."
validate:
  - "pnpm run test:file -- tests/contracts/continuity-fold.test.ts"
  - "pnpm run test:file -- tests/extended/task-board-done.test.ts"
---

# Domains session

The session domain owns the persistence vocabulary for session events, the lifecycle contract that the CLI drives, token accounting for context estimation and reconciliation, the compaction pipeline that summarizes history, the task board store behind the `tasks` tool, and the pure validating fold for durable continuity. It is the single domain that defines what a session is on disk (`current.jsonl` + `tree.json` + `meta.json`) and how a turn flows from append to durable replay.

## Entry point and registration

`src/domains/session/index.ts` exports `SessionDomainModule`, a `DomainModule` whose `manifest` is `SessionManifest` and whose `createExtension` is `createSessionBundle` from `extension.ts`. The domain is loaded by the core domain loader (`src/core/domain-loader.ts`), which calls `createSessionBundle(context)` to obtain the `SessionContract` and the `DomainExtension` with `start()`/`stop()` lifecycle hooks.

## What owns it

### `src/domains/session/entries.ts`

The `SessionEntry` discriminated union is the persistence vocabulary. Each entry carries a `kind` discriminant, a `turnId` (UUID v7 where possible so entries sort by creation), a `parentTurnId` pointer, and an ISO `timestamp`. The union spans nineteen kinds: `message`, `bashExecution`, `custom`, `modelChange`, `thinkingLevelChange`, `fileEntry`, `branchSummary`, `compactionSummary`, `sessionInfo`, `label`, `protectedArtifact`, `skillActivation`, `taskLedger`, `decisionLedger`, `workerRun`, `contextEviction`, `contextRecall`, `handoffTransaction`, `continuityCommit`. The canonical list `SESSION_ENTRY_KINDS` is exported so consumers can assert exhaustive coverage in tests.

Structural validation lives in `isSessionEntry(value: unknown): value is SessionEntry`, which switches on `kind` and validates every field of every variant. For continuity kinds (`handoffTransaction`, `continuityCommit`), it delegates to the validators from `src/domains/session/continuity/validate.ts`. The `compactionSummary` kind carries an optional `continuity` payload that is fully validated: a summary carrying a malformed checkpoint is a malformed summary, not a summary with a field to ignore.

### `src/domains/session/extension.ts`

`createSessionBundle(context: DomainContext)` returns a `DomainBundle<SessionContract>` containing the live `SessionContract` implementation and a `DomainExtension` with `start()`/`stop()`. The extension owns a single current `SessionManagerState` and funnels create/append/checkpoint/resume/fork/close through the engine session writer (`src/engine/session.ts`).

Key lifecycle rules:

- **Open-before-close**: `resume()` and `fork()` open the target before closing the prior session, because `resumeSessionState` and `forkFromState` can throw (unsupported format version, unknown parent turn). Closing the prior session first would orphan the operator with no current session.
- **Leaf invariant**: `append(turn)` throws if `turn.parentId !== currentTurnId`, refusing to parent a turn onto another session's turn.
- **Park/resume emission**: every session replacement or close emits `SessionParked` on the bus; every `resume()` or `switchBranch()` emits `SessionResumed`. The safety audit subscriber persists these without pulling in the session contract.
- **Pinned leaf**: `switchTurn()` persists `pinnedLeafTurnId` to `meta.json` immediately so a `/tree` switch survives quit + resume. `resume()` and `switchBranch()` prefer this pin over timestamp inference when it still names a real turn; a plain `append()` clears it.

### `src/domains/session/contract.ts`

`SessionContract` is the domain-level interface with methods `current()`, `create()`, `append()`, `appendEntry()`, `replaceEntries()`, `recordSkillActivation()`, `checkpoint()`, `resume()`, `fork()`, `tree()`, `switchBranch()`, `switchTurn()`, `editLabel()`, `setName()`, `deleteSession()`, `history()`, and `close()`. The `SessionMeta` type extends `ClioSessionMeta` with `ClioSessionMetaExtension` fields: `parentSessionId`, `lastCheckpointAt`, `name`, `labels`, `firstMessagePreview`, `messageCount`, `lastActivityAt`, `workspace`, `skillActivations`, and `pinnedLeafTurnId`.

### `src/domains/session/migrations/index.ts`

`runMigrations(meta, sessionPath)` reads formats 3 through 6. Older formats and formats newer than this build are refused. Format 4 added `contextEviction` and `contextRecall`; format 5 added continuity transactions and checkpoint payloads; format 6 added structural eviction reasons, the `reread` recall trigger, and optional evicted-item content hashes. Resuming formats 3–5 updates the metadata version without transforming ledger records. Older binaries cannot resume a session restamped to format 6.

### `src/domains/session/handoff-service.ts`

The terminal and ACP host share the prepare/commit service. Prepare extracts a goal-directed document, validates file references against the active read ledger, and incorporates durable decisions. It records a host-only identity of the source session, workspace, pinned branch, entries, skill activations, and decision board. A changed identity after extraction or before commit refuses the draft before writing. Commit accepts the reviewed document, creates and seeds a successor, restores activations, and links the original session; cancellation leaves the source conversation in place.

### `src/domains/session/context-accounting.ts`

Token estimation uses a chars/4 heuristic (`TOKEN_CHARS = 4`), with `IMAGE_CHAR_ESTIMATE = 4800` for image blocks and `MESSAGE_OVERHEAD_TOKENS = 16` per message. The `estimateAgentContextTokens(input)` function finds the latest usable assistant usage from the messages, anchors to that token count, adds trailing tokens and tool schemas, and returns the maximum of the projection and the anchored estimate.

`captureContextSnapshot(input)` is the single assembly point for a turn's context snapshot, decomposing tokens into categories: `system`, `tools`, `toolResults`, `agents`, `skills`, `memory`, `project`, `messages`, `reserve`, `free`, and `streaming`. The `persistableSnapshot(snapshot)` function strips heavy captured inputs (system prompt, conversation messages, tool schemas, pending user input, images) before writing to the JSONL ledger, because persisting the full conversation per turn would duplicate the session log with O(turns²) growth.

`reconcileSnapshot(snapshot, usage)` replaces estimated categories with provider-exact numbers when a response usage arrives. Cached prompt tokens are folded back in. The function records `estimatedTokens` (the chars/4 prompt-side total), `reconciledTokens` (the provider's own prompt token count), and `divergenceRatio` (reconciled / estimated). A ratio above 1 means the estimator is under-counting.

### `src/domains/session/compaction/compact.ts`

`compact(input: CompactInput)` is the compaction pipeline. It finds the cut point via `findCutPoint`, serializes the history portion, and asks the model for a structured summary via `streamSimple` from `src/engine/ai.ts`. The caller persists the summary as a `compactionSummary` entry.

Key behavior:

- **Iterative compaction**: when a prior `compactionSummary` exists, it is canonical history. The cut search is restricted to entries strictly after that boundary; the canonical summary and its retained suffix are recovered and prepended explicitly.
- **Skill context preservation**: `captureSkillContext` recovers complete, uniquely paired historical main-agent skill loads. A typed checkpoint is not regenerated from summary prose; failure to verify its original receipts prevents another destructive pass.
- **Split-turn handling**: when the cut splits a turn, `compact` runs two summary streams: one for the history portion and one for the split-turn prefix. The split-turn summary is not a reliable copy of the active request, so it is kept in the canonical checkpoint.
- **Summary format validation**: `validateHistorySummary` checks that the summary contains the required section headings (`## Goal`, `## Constraints & Preferences`, etc.) in order outside code fences.

### `src/domains/session/task-board.ts`

`createTaskBoardStore(deps: TaskBoardStoreDeps)` returns a `TaskBoardStore` with `snapshot()`, `cachedSnapshot()`, `historySnapshot()`, `apply(mutation)`, `attachRun(runId)`, `detachRun(runId)`, and `invalidate()`. The board is replayable from the JSONL alone: every mutation persists a full-snapshot `taskLedger` entry via `appendEntry`, so the store survives resume/fork without any side-car state.

Mutation types: `plan`, `add`, `pick`, `start`, `done`, `block`, `drop`. The `applyMutation` function enforces:

- One active task at a time: starting a task parks any other active task back to pending.
- `done` requires a non-empty completion note.
- `block` requires a reason.
- `plan` replaces agent tasks but preserves open operator tasks.
- `pick` requires an operator task id matching `/^u[1-9]\d*$/`.

`foldTaskBoard(entries)` walks entries and returns the last `taskLedger` entry as the current board. `foldSessionTaskHistory(entries)` groups entries by `boardId` to recover every safely identifiable board generation.

`toTaskLedgerEntryFields(board, now)` maps the in-memory board to the durable `TaskLedgerEntryFields` shape: the board title becomes the single top-level goal (`TASK_BOARD_GOAL_ID = "board"`), tasks become subgoals with `parentGoalId` pointing at that goal, and a completion note becomes a claim on the completed subgoal.

### `src/domains/session/continuity/fold.ts`

`foldContinuity(input: ContinuityFoldInput)` is the pure validating continuity fold. It reads no clock, mints no id, touches no disk, calls no model, and never performs the action it proposes. Given one ordered applicable projection of the ledger, it returns the state of the selected transaction, the recallable note, the anomalies it found, and a proposed recovery action.

Key validation rules:

- A real record extends the chain only as a validated successor: predecessor equals the head, sequence is head + 1, attempt moves only for `reducing`, and the phase is legal from the head's phase.
- A summary carry is a projection of a chain whose middle was cut out of this input. It may be ahead of the observed head but may never contradict what was observed: it cannot reopen a terminal state, walk the lifecycle backwards, or leave a pause without a resume.
- An exact original commit appended after a validated later carry is the one legitimate out-of-order case. It fills the commit's presence and does not move the head.
- Missing-commit classification waits for the whole input, because an initial summary legitimately precedes its own commit.

## How data flows

### Append flow

The CLI calls `session.append(turn: TurnInput)`. The extension checks that `turn.parentId === currentTurnId`, calls `appendTurn(state, turn)` from `manager.ts`, which writes the turn to the engine session writer. The record's `id` becomes `currentTurnId`. If `pinnedLeafTurnId` was set, it is cleared because the leaf has moved past it.

### Compaction flow

When context pressure exceeds the compaction threshold, the interactive layer calls `compact(input)`. The function:

1. Folds the working set (`foldWorkingSet` + `projectWorkingSet`) to apply eviction decisions.
2. Finds the prior compaction boundary and restricts the cut search to entries after it.
3. Calls `findCutPoint` to locate the first entry to retain.
4. Serializes the history portion via `serializeConversation`.
5. Calls the model via `streamSimple` to produce a structured summary.
6. Returns `CompactResult` with `summary`, `firstKeptEntryIndex`, `tokensBefore`, and usage.

The caller persists the result as a `compactionSummary` entry via `session.appendEntry`.

### Task board mutation flow

The `tasks` tool calls `store.apply(mutation)`. The store:

1. Syncs to the session (refolds from ledger if dirty).
2. Applies the mutation via `applyMutation`.
3. If operator-linked (pick or done on a user task), persists immediately and fails if persistence fails.
4. Otherwise persists best-effort.

### Continuity fold flow

`foldContinuity` is called with the full applicable ledger before the replay cut. It:

1. Indexes entry positions for resume authority checks.
2. Walks entries, classifying each as a transaction, commit, or carrying summary.
3. Applies each to the appropriate chain state.
4. Returns a `ContinuityFoldResult` with phase, authority, anomalies, and proposed action.

## Extension seams

- **New entry kind**: add the kind to `SESSION_ENTRY_KINDS` in `entries.ts`, add the interface and its validation case in `isSessionEntry`, and export it from `index.ts`. The compaction pipeline, tree navigator, and any replay consumer must handle the new kind.
- **New mutation type**: add the variant to `TaskBoardMutation` in `task-board.ts` and handle it in `applyMutation`. The durable shape is automatically covered by `toTaskLedgerEntryFields`.
- **New continuity phase**: add the phase to `LEGAL_PREDECESSORS` in `fold.ts` and update `LIFECYCLE_RANK` if it has a position in the linear lifecycle.
- **New compaction behavior**: modify `compact()` in `compact.ts`. The summary stream goes through `src/engine/ai.ts` to honor the engine boundary; this module does not import pi-ai directly.

## Focused tests

### `tests/contracts/continuity-fold.test.ts`

Tests the validating fold across:

- **Legal chain**: `prepared -> reducing -> ready -> delivered -> acknowledged` with matching terminal evidence. Asserts `result.phase === "acknowledged"`, `result.validated === true`, `result.action.kind === "none"`, and `result.authority === "recall_only"`.
- **Chain extension validation**: refuses a commit that is not a validated successor (high sequence number is not proof of a valid chain). Refuses a commit whose predecessor or attempt does not follow the head. Refuses a third reduction attempt and a retry after a non-provider failure.
- **Carry validation**: refuses a carry that fabricates an extension past what was observed. Holds a one-step carried successor to the real successor rules. Compares every retained field of a carry against the observed head. Refuses a carry that refunds a spent attempt.
- **Resume authority**: accepts a resume bound to a durable new operator control request. Refuses a request that is not strictly between the head it answers and the resume. Refuses a binding that names another handoff, action, head, or session.
- **Deadlines**: ends automatic work when the window is reached, and clamps an overlong one. Treats a backward or unusable clock as requiring operator recovery.
- **Missing commit**: reconstructs an absent commit under its reserved identity and keeps the later head. Refuses to conclude absence while unreadable records could hide the commit.

### `tests/extended/task-board-done.test.ts`

Tests the task board done flow:

- Completes a pending task with evidence and records the implicit start. The test creates a store, plans a board, applies `done` on `t2`, and asserts `done.notes` contains `"started t2 implicitly"`.
- Refuses `done` without evidence. Asserts `done.ok === false` when the evidence is whitespace-only.
- Keeps a failed-check completion note without projecting passed validation. Asserts `written.requiredValidationEvidence.length === 0` and that the note remains durable and replayable.
- Refolds a legacy passed-note ledger and reprojects the note as a claim.
- Keeps operator declarations and observed checks separate from the done note.

## Things to watch when editing

- **Engine boundary**: only `src/engine/**` imports `@earendil-works/pi-*`. The compaction pipeline goes through `src/engine/ai.ts` (`streamSimple`); it never imports pi-ai directly.
- **Session domain does not import other domains' `extension.ts`**: the session domain imports from other domains through their `index.ts` or concrete submodules, never through their extension module.
- **Continuity import is one-directional**: `entries.ts` imports continuity validators as value imports; the continuity modules reach back for `BaseSessionEntry` as an erased `import type`. There is no runtime cycle.
- **Compaction is a real model call**: it is billed like one and carries usage. A compaction that needs more tokens than the model's context window throws before calling the provider.
- **Task board persistence is best-effort** for agent mutations but required for operator-linked work. A failed ledger write for an agent mutation only costs replay fidelity; a failed write for an operator pick or done returns an error to the caller.
- **Continuity fold never performs actions**: it proposes recovery actions; the caller executes them. The fold reads no clock, mints no id, touches no disk, calls no model.

<!-- clio-coder:wiki unresolved sources: src/engine/** -->
