# Session Lifecycle

This document is the authoritative specification for Clio Coder interactive and headless session lifecycles, on-disk ledger structures, tree-based conversation branching, checkpoints, and recovery protocols in `v0.3.3`.

Source implementations: `src/engine/session.ts` and `src/domains/session/`.

---

## 1. On-Disk Session Layout

Sessions are persisted durably on disk under the platform state root (`clioStateDir()`, resolving to `~/.local/state/clio-coder` on Linux, `~/Library/Application Support/clio-coder/state` on macOS, or `%LOCALAPPDATA%\clio-coder\state` on Windows):

```text
<stateDir>/sessions/<cwdHash>/<sessionId>/
  meta.json        # ClioSessionMeta JSON document
  current.jsonl    # Append-only structured session event ledger
  tree.json        # SessionTreeNode[] conversation tree graph
```

- `<cwdHash>`: First 16 hexadecimal characters of SHA-256 of canonical workspace root path (`createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)`).
- `<sessionId>`: UUIDv7 generated at session initialization.

---

## 2. Session Metadata (`meta.json`)

Session metadata is written atomically (`.tmp` + `fsyncSync` + `renameSync`) by `src/engine/session.ts:atomicWrite` and updated without closing via `src/domains/session/manager.ts:persistSessionMeta`.

```typescript
export interface ClioSessionMeta {
  id: string;
  cwd: string;
  cwdHash: string;
  createdAt: string;
  endedAt: string | null;
  model: string | null;
  target: string | null;
  clioVersion: string;
  piMonoVersion: string;
  platform: string;
  nodeVersion: string;
  sessionFormatVersion?: number; // CURRENT_SESSION_FORMAT_VERSION = 3
}
```

Format version `CURRENT_SESSION_FORMAT_VERSION = 3` (`src/engine/session.ts:66`) is stamped on all sessions created in `v0.3.3`. Sessions with missing or earlier format versions trigger schema migrations in `src/domains/session/migrations/` on `/resume`.

---

## 3. Append-Only Context Ledger (`current.jsonl`)

The session ledger `current.jsonl` records all conversation events, model turns, tool executions, and checkpoints in strict append-only order.

### Header Line

The first line of `current.jsonl` is the canonical session header:

```json
{"type":"session","version":3,"id":"01912a34-b567-7890-abcd-ef0123456789","timestamp":"2026-08-14T12:00:00.000Z","cwd":"/path/to/project"}
```

### Entry Taxonomy

Subsequent lines represent typed `SessionEntry` objects (`src/domains/session/entries.ts`):

1. **`message`**: User inputs, assistant responses, and tool calls/results.
   ```typescript
   export interface MessageEntry {
     kind: "message";
     turnId: string;
     parentTurnId: string | null;
     timestamp: string;
     role: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "checkpoint";
     payload: unknown;
   }
   ```
2. **`label`**: User-defined turn bookmark or tag anchored to `targetTurnId`.
3. **`sessionInfo`**: Metadata event (such as model switch, target change, or thinking level adjustment).
4. **`compactionSummary`**: Progressive compaction snapshot retaining historical context up to `firstKeptTurnId`.
5. **`taskLedger`**: Full session task-board snapshot with a stable board id, goal and subgoal states, active run ids, required validation evidence, and optional operator provenance through `origin: "user"` plus `userTaskId`.
6. **`decisionLedger`**: Branch-anchored snapshot of a completed or cancelled `ask_user` interview, including its timing, round count, settled values, superseded values, and operator corrections.

`taskLedger` and `decisionLedger` are context-free bookkeeping entries. They refold the `/tasks` and `/decisions` surfaces and enter evidence projection, but do not consume model-context tokens or become model messages by themselves.

### Write Durability & Atomicity

- Appends hold an open `O_APPEND` file descriptor across the writer lifetime (`src/engine/session.ts:openSync`).
- Each line append is executed via a single `write(2)` call.
- `fsyncSync` is debounced during high-frequency streaming turns and unconditionally forced on checkpoint (`persistTree`) and session shutdown (`close`).
- Torn last lines resulting from abrupt system crashes or power losses are tolerated by the ledger reader (`src/engine/session.ts:readSessionFileEntries`), which logs a warning and skips the incomplete trailing record.

---

## 4. Conversation Tree Graph (`tree.json`) & Lineage

Clio Coder tracks all conversation turns as a directed tree graph, enabling non-destructive branching, navigation, and message forking.

### Tree Structure

`tree.json` stores the complete node linkage:

```typescript
export interface SessionTreeNode {
  id: string;              // UUIDv7 turn identifier
  parentId: string | null; // UUIDv7 parent turn identifier
  at: string;              // ISO-8601 creation timestamp
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "checkpoint";
}
```

### Active Path Lineage Selection

When an operator branches or switches turns using `/tree` or `Alt+T`, the next append point changes without mutating or deleting historical entries in `current.jsonl`.

The active path filter (`src/domains/session/tree/active-path.ts`) traces ancestry back from the active leaf:
1. Resolves all `turnId` identifiers tracing back to the root `null` parent.
2. Selects all ledger entries explicitly matching these `turnId`s.
3. Both `/tree` (in-session switch) and `/fork` (new session branch) reconstruct the exact same state, strictly excluding any unanchored sidecar entries (`taskLedger`, routing notices, leafless `workerRun`) that appear after the chosen leaf's position.
4. For a `/tree` switch, the active pin is persisted to `meta.pinnedLeafTurnId` and cleared on the next append, so a switch survives quit and `/resume` without reverting to the abandoned tip via timestamp inference.
5. Prunes abandoned sibling branches from the context window supplied to the LLM.

### Branch Forking (`/fork`)

The `/fork` command (`src/domains/session/tree/fork.ts:forkFromParentTurn`) initializes an independent session branched from an arbitrary turn:
1. Closes the current session writer.
2. Creates a new session directory and metadata inheriting `cwd`, `model`, and `target` from the parent.
3. Traces ancestry up to `parentTurnId` and copies exactly the active path entries (excluding later unanchored sidecars) into the new session ledger.
4. Stamps `parentSession` and `parentTurnId` in the new session header.

### Streaming Turn Settlement During Session Transitions

When an operator issues `/new`, `/resume`, `/tree`, or `/fork` while an assistant turn is actively streaming, `settleChatBeforeSessionSwitch` (`src/interactive/session-switch-settlement.ts`) cancels the in-flight stream and awaits completion. This guarantees that partial assistant records and completed tool executions seal cleanly into the active session ledger before the session writer is replaced, preventing orphaned records in new sessions or unanswered prompts in original sessions (#114). Synchronous session transitions when chat is idle continue to execute immediately.

---

## 5. Session Resumption (`/resume`) & Working Directory Fallback

When resuming a session via `/resume` or `CLIO_CODER_RESUME_SESSION_ID`:
1. `src/domains/session/manager.ts:resumeSessionState` loads `meta.json` and runs migrations.
2. `src/domains/session/cwd-fallback.ts:resolveSessionCwd` probes the recorded `meta.cwd` against the filesystem.
3. If the directory is invalid, it returns a typed failure reason:
   - `no-cwd`: `meta.cwd` is missing or empty.
   - `missing`: The directory no longer exists on disk.
   - `not-a-directory`: The path points to a non-directory file or broken symlink.
4. The interactive layer displays the `cwd-fallback` overlay prompting the operator to choose a valid workspace directory.

### Model-Facing Custom Entry Replay

When resumed or forked session history is replayed to the model, custom session entries (such as compaction summaries, branch summaries, and operator bash executions) are projected into standardized user-role message text via `src/engine/messages.ts` constants (`COMPACTION_SUMMARY_PREFIX`, `BRANCH_SUMMARY_PREFIX`, `bashExecutionToText`) rather than ad-hoc formats, ensuring deterministic prompt construction across sessions.

---

## 6. Session Export

`/export` replays the active branch through the same transcript projection used by the live TUI and `/resume`. With no path, it writes `.clio-coder/exports/<sessionId>-<local-date>.html`. The HTML document is self-contained, carries the active Clio theme through converted ANSI styles, renders tool calls as semantic tool rows, references no external assets, and is capped at 2 MiB. If the transcript exceeds that limit, the export ends at a complete rendered row and states that later rows were omitted.

An explicit path ending in `.md` keeps the plain Markdown form: a heading, UTC export instant, and a terminal-control-free fenced transcript. Export never changes the ledger or the active tree pin. Both formats follow the pinned active leaf and omit abandoned sibling turns.

---

## 7. Directory Handbooks and Project Overrides

During session context loading, `loadProjectContextFiles` (`src/domains/context/clio-md.ts`) discovers root `CLIO-CODER.md` handbooks and directory-scoped `CLIO-CODER.override.md` files:
- An override handbook replaces inherited project instructions for its directory and all subdirectories, establishing an explicit subtree boundary.
- Sibling directories remain unaffected.
- Subdirectories within the subtree may supply narrower instructions with additional override files.
- Prompt blocks preserve explicit source paths for provenance.
- Malformed override files fail closed, and context resets never delete override files.

---

## 8. Prompt History and Input Recovery

The interactive editor provides process-local prompt history via `Ctrl+P` (previous) and `Ctrl+N` (next):
- Accepted chat prompts, slash commands, local command executions, steering inputs, follow-ups, and interrupt messages are preserved in navigation history.
- Consecutive duplicates are collapsed.
- Rejected or malformed commands remain editable in the composer without polluting navigation history.
- Navigating forward past the newest entry restores the unfinished draft prompt.

---

## 9. Protected-Artifact Write-Ahead Journal

To guarantee that protected artifacts and validation locks survive unexpected crashes between tool execution and ledger commitment, Clio Coder maintains a write-ahead journal (`src/domains/session/protected-artifact-journal.ts`):

- Location: `<stateDir>/protected-artifact-pending/<sessionKey>/<recordId>.json`
- Lifecycle:
  1. **Stage**: Before a mutating tool result is returned, the protected artifact registration is staged atomically to the journal directory.
  2. **Commit**: Once the turn completes and appends to `current.jsonl`, the staged journal file is unlinked.
  3. **Reconcile**: During session startup or resume, `reconcilePendingProtectedArtifacts` reads any leftover staged records and injects them into the protection engine before accepting user commands.

---

## 10. In-Session Task Board & Usage Accounting

- **Task Board** (`src/domains/session/task-board.ts`): Maintains session task items as full `taskLedger` snapshots with `pending`, `active`, `completed`, `blocked`, and `cancelled` states. Stable board ids retain terminal board history; rows picked from the project operator inbox retain `origin: "user"` and `userTaskId` across `/resume`, `/fork`, `/view`, and evidence export. The project-scoped inbox itself lives at `.clio-coder/user-tasks.json`, outside the session directory.
- **Decision Board** (`src/domains/session/decision-board.ts`): Appends one branch-anchored `decisionLedger` snapshot when an `ask_user` interview completes or is cancelled. Superseding or correcting a value appends a new snapshot, preserving the earlier value and the operator-authored revision trail.
- **Usage Accounting** (`src/domains/session/usage.ts`): Aggregates session token counts across input, output, cache read, cache write, and reasoning tokens. Anchors against provider-reported totals on settled turns.
- **Aborted Turn Persistence**: When a turn is interrupted by `Ctrl+C` or a SIGINT signal, partial assistant output and completed tool executions are committed to `current.jsonl` with `interrupted: true` before yielding the prompt.
