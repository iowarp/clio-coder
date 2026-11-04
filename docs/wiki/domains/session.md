---
title: "Session domain: format gating, task board, continuity and compaction"
summary: "Describes the src/domains/session tree: how session format versions are gated before resume, how the live task board is held and persisted, and the entry points for continuity folding and compaction. Read this to find which module owns a session behavior before editing it."
sources:
  - "src/domains/session/index.ts"
  - "src/domains/session/migrations/index.ts"
  - "src/domains/session/manager.ts"
  - "src/domains/session/task-board.ts"
  - "src/domains/session/continuity/fold.ts"
  - "src/domains/session/compaction/compact.ts"
  - "src/domains/session/workspace/index.ts"
symbols:
  - "SessionDomainModule"
  - "runMigrations"
  - "OLDEST_READABLE_SESSION_FORMAT_VERSION"
  - "createTaskBoardStore"
  - "foldTaskBoard"
  - "foldContinuity"
  - "compact"
tests:
  - "tests/extended/task-board-done.test.ts"
invariants:
  - "A session whose metadata lacks a format version is read as version 1 and is refused; versions below 3 throw and are not transformed."
  - "A session metadata format version above the build's CURRENT_SESSION_FORMAT_VERSION throws and asks the operator to upgrade, so the newer ledger is not truncated and written back."
  - "A session with a format version from 3 up to the current version is reported as migrated with unchanged ledger content; resume proceeds only when no other live process owns the session."
  - "A task board completion with blank evidence is refused by the task board store and the board is not changed."
  - "Task board persistence is best-effort for plain mutations, but an operator-linked mutation (pick, plan over open user tasks, or done on a user-origin task) returns an error when the ledger append fails."
validate:
  - "pnpm run test:file -- tests/extended/task-board-done.test.ts"
  - "pnpm run typecheck"
---

# Session domain: format gating, task board, continuity and compaction

The session domain under `src/domains/session` owns the durable record of a Clio session: its ledger of entries, the format version that governs how that ledger can be read, the live task board shown to the model and the operator, the continuity records used to hand work between sessions, and the compaction that summarizes older history. A reader needs this page to decide which module to open for a session behavior and which invariants a change must preserve.

## What the domain exports

`src/domains/session/index.ts` is the public surface. It exports `SessionDomainModule`, which pairs `SessionManifest` with `createSessionBundle` from `extension.js`. The same file re-exports the migration entry `runMigrations` and `CURRENT_SESSION_FORMAT_VERSION`, the task-board factory `createTaskBoardStore` with `foldTaskBoard` and `toTaskLedgerEntryFields`, the continuity projection and persistence ports, and the telemetry and archive readers. The module comment there states that the pure continuity fold and its validators stay reachable only through their own modules.

## Format version gating

`src/domains/session/migrations/index.ts` is the strict session-format reader. `runMigrations(meta, sessionPath)` reads `meta.sessionFormatVersion`, defaulting to 1 when it is absent, and branches in this order:

1. If the version is below `OLDEST_READABLE_SESSION_FORMAT_VERSION` (3), it throws an error telling the operator to remove the session directory.
2. If the version is above `CURRENT_SESSION_FORMAT_VERSION`, it throws an error saying the session was written by a newer Clio and to upgrade.
3. If the version is between 3 and the current version, it returns `{ migrated: true, from, to }` without changing the ledger. The file's own comment says versions 3 to 5 are additive and only the metadata is restamped.
4. Otherwise it returns `{ migrated: false, from, to: from }`.

The current version constant is imported from `src/engine/session.ts`, not defined in this domain. The reader is called from `src/domains/session/manager.ts` during resume. There, `liveSessionOwner` is checked first, and a session owned by another live process is refused before `runMigrations` runs, so migration cannot write another process's ledger. No test for `runMigrations` was found under `tests/`, so the branch behavior above is established from source only.

## Live task board

`src/domains/session/task-board.ts` holds the state behind the `tasks` tool, the footer row, and the tasks overlay. `createTaskBoardStore(deps)` returns a `TaskBoardStore` with `snapshot`, `cachedSnapshot`, `historySnapshot`, `apply`, `attachRun`, `detachRun` and `invalidate`. Store state is a closure over `board`, `dirty` and `cachedSessionId`. `syncToSession` re-folds the board from `deps.readEntries()` only when the store is dirty or the session id has changed.

`apply(mutation)` runs `applyMutation` on the current board and returns `{ ok: false, message }` on error. For an accepted result it assigns a board id when the mutation is `plan` or the board has none, then branches on `mutationRequiresAcknowledgement`:

- For `pick`, for `plan` when open user tasks exist, and for `done` on a user-origin task, the store requires `deps.appendEntry`. If it is absent, the result is an error saying durable persistence is unavailable. If the append throws, the result is an error and the in-memory board is not replaced.
- For all other mutations, the board is replaced and `persist` appends the ledger entry. `persist` swallows append errors, so the live board still updates.

The entry shape is produced by `toTaskLedgerEntryFields`, and `foldTaskBoard(entries)` rebuilds the board from ledger entries. `unverifiedTaskChecks` lists failed or unrecorded checks for a task.

The focused test `tests/extended/task-board-done.test.ts` uses a store built with `getSessionId`, `createBoardId`, `now`, `readEntries` and `appendEntry`. Its cases include: a `plan` mutation with object rows and a JSON string of rows normalizes to the titles `["First task", "Second task"]`; a `done` mutation on `t2` with evidence `"node --test tests/compaction.test.ts: 4/4 pass"` completes that task and adds a note containing `started t2 implicitly`; a `done` with whitespace-only evidence returns `ok: false`; and a `done` whose note reads `"14/16 failed; rerun pending"` keeps that note without projecting passed validation.

## Continuity fold

`src/domains/session/continuity/fold.ts` exports `foldContinuity(input: ContinuityFoldInput)`. The file keeps two transition tables: `LEGAL_PREDECESSORS`, which lists the phases each handoff phase may follow, and `LIFECYCLE_RANK`, which orders the linear phases from `absent` (0) through `acknowledged` (5) and gives side states (`paused`, `failed`, `resumed`) a rank of -1. Entries are indexed first so a resume can be checked against the position of its target. The internal `ChainState` and `newChain` track one chain per handoff id. This page describes the fold only at this level; the per-entry validation rules and the persister live in the continuity modules and are not covered here.

Continuity types consumed by callers, such as `ContinuityPhase` and `HandoffTransactionEntry`, are exported from `src/domains/session/continuity/contract.ts` through `index.ts`. See the related pages linked below for the operator-facing continuity flow.

## Compaction

`src/domains/session/compaction/compact.ts` exports `compact(input: CompactInput): Promise<CompactResult>` and `compactWithCalls`, plus the `CompactEmptyReason` union (`protected-recent`, `protected-skill`, `repeat-no-gain`). Internal helpers locate the latest compaction index, protect recent turns and activated skills (`captureSkillContext`), extract file operations, validate the history summary, and run the summary request through a model stream. this page read only the outline and the signatures of `compact` and `captureSkillContext`; the cut-point selection and summary branches were not traced, so the compaction workflow is not described beyond its exported signatures.

## Workspace probes

`src/domains/session/workspace/index.ts` only re-exports `probeGit`, `probeGitAsync`, `probeGitStatusAsync`, `probeWorkspace`, `probeWorkspaceAsync`, `emptyWorkspaceSnapshot` and `WORKSPACE_PROBE_REUSE_MS` from `src/domains/session/workspace/git-probe.ts` and `snapshot.js`. The probe implementations were not read.

## Things to watch when editing

- Keep the format-version branches in `runMigrations` ordered as they are. A version above the current build must still throw rather than fall into the restamp path, because the file comment explains that a truncated downgrade rewrites the original.
- The live-owner check in `src/domains/session/manager.ts` runs before `runMigrations`. Moving migration ahead of it would change which process can write the ledger.
- In the task board store, the distinction between persisted-required mutations and best-effort persistence determines whether a failed append reverts the UI. Changing one branch without the other changes the operator-visible outcome.
- `CURRENT_SESSION_FORMAT_VERSION` is defined in `src/engine/session.ts`. Bumping it changes the reader's upper bound, and the reader's comment documents which versions are additive.

## Related pages

- [Session control](../session-control.md) covers the operator-facing session commands.
- [Domains context](context.md) and [Domains memory](memory.md) describe adjacent consumers of session entries; this page does not restate them.
- [Tools](../tools.md) describes the `tasks` tool that calls the task board store.
- [Domains extensions](extensions.md) describes the bundle created by `createSessionBundle`.
