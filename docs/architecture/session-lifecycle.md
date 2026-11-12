# Session Lifecycle

The [context continuity guide](../guide/context-continuity.md) explains operator recovery after a paused handoff.

This page describes the implemented CLIO Coder interactive, headless and ACP session lifecycles, on-disk ledger structures, tree-based conversation branching, checkpoints, and recovery protocols in the current source tree.

Source implementations: [session.ts](../../src/engine/session.ts) and `src/domains/session/`.

---

## 1. On-Disk Session Layout

Sessions are persisted durably on disk under the platform state root (`clioStateDir()`, resolving to `~/.local/state/clio-coder` on Linux, `~/Library/Application Support/clio-coder/state` on macOS, or `%LOCALAPPDATA%\clio-coder\state` on Windows). `XDG_STATE_HOME` and `CLIO_CODER_STATE_DIR` move it, see [Environment variables](../guide/environment-variables.md).

```text
<stateDir>/sessions/<cwdHash>/<sessionId>/
  meta.json               # ClioSessionMeta JSON document
  current.jsonl           # Append-only structured session event ledger
  tree.json               # SessionTreeNode[] conversation tree graph
```

- `<cwdHash>`: First 16 hexadecimal characters of SHA-256 of the absolute resolved working-directory path (`createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)`).
- `<sessionId>`: UUIDv7 generated at session initialization.
- Per-turn token accounting and prompt compiles are not session files. Each turn's context snapshot is a `context.snapshotted` record and each prompt compile a `prompt.compiled` record in the session's telemetry journal, `<stateDir>/telemetry/sessions/<sessionId>/journal.jsonl` ([Telemetry](telemetry.md#journals), [Context Engine](context-engine.md#token-accounting--ledger-snapshots)). A prompt compile records prompt hashes, section token estimates, fragment content hashes and the thinking level ([prompt-manifest.ts](../../src/domains/session/prompt-manifest.ts)), never prompt text.
- Session directories are created mode `0700` and `meta.json`, `current.jsonl` and `tree.json` mode `0600`, whatever the umask. Boot also closes CLIO Coder's existing state subdirectories that are open to group or other users.
- Deleting a session removes the directory. `deleteSession` with `keepFiles` keeps `current.jsonl` and `tree.json` and renames `meta.json` to `meta.deleted.json`, which drops the session from listings. The open session cannot be deleted. A delete takes the same lock on `meta.json` that a resume takes, and refuses a session that has not ended or whose owner process is still alive; ACP `session/delete` reports that refusal as `session_open`.

`openSession` and `resumeSession` locate a session by id under any `<cwdHash>` bucket, after rejecting ids that could traverse out of the sessions root.

---

## 2. Session Metadata (`meta.json`)

Session metadata is written atomically (a temporary file, `fsync`, then rename, through `safeResourceWrite` in `src/core/safe-resource-write.ts`) by `atomicWrite` in `src/engine/session.ts` and updated without closing via `src/domains/session/manager.ts:persistSessionMeta`.

```typescript
export interface ClioSessionMeta {
  id: string;
  cwd: string;
  cwdHash: string;
  createdAt: string;
  endedAt: string | null;
  model: string | null;
  target: string | null;
  clioCoderVersion: string;
  piMonoVersion: string;
  platform: string;
  nodeVersion: string;
  sessionFormatVersion?: number; // CURRENT_SESSION_FORMAT_VERSION = 6
  owner?: { pid: number; host: string; birth: string | null };
}
```

`owner` names the process that last opened the ledger for writing, stamped on create and on every resume. With `endedAt` null it tells a session still open in another terminal from one whose process is gone. `resumeSessionState` checks the owner and publishes the new one under one cross-process lock on `meta.json`, so a resume of a session that is open in another process is refused with `session <id> is open in another process (pid <n> on <host>)`. An owner on another host cannot be probed and reads as live; the refusal then points at `clio-coder session terminate <id>`, with `--force` when its heartbeat is stale ([live-owner.ts](../../src/domains/session/live-owner.ts)).

The session domain extends the same file with `parentSessionId` and `parentTurnId` (set on forks), `lastCheckpointAt` and `lastCheckpointReason`, `pinnedLeafTurnId`, the workspace snapshot captured at session start, and the ordered `skillActivations`. The picker fields `name`, `labels`, `firstMessagePreview`, `messageCount`, `hasModelTurn` and `lastActivityAt` are derived from the ledger when sessions are listed ([history.ts](../../src/domains/session/history.ts)) and are not authoritative on disk.

New sessions use format `CURRENT_SESSION_FORMAT_VERSION = 6`
([session.ts](../../src/engine/session.ts)). The reader accepts versions 3–6.
Opening version 3, 4, or 5 restamps metadata as version 6 without transforming
the existing ledger or tree. Version 4 adds `contextEviction` and `contextRecall`;
version 5 adds `handoffTransaction`, `continuityCommit`, and optional continuity
payloads on compaction summaries; version 6 adds eviction reasons, the `reread`
recall trigger, and optional evicted-body content hashes.

A missing format or a version below 3 is refused with guidance to remove the
incompatible session directory. Versions above 6 require a newer CLIO Coder. Older
binaries may refuse a session after its metadata is restamped; upgrade clients
before reopening shared sessions.

Session admission checks metadata format before any recovering ledger read. It
validates replay entries before parking the current session. Required headerless
ledger normalization must succeed before reopened candidate metadata is published;
a refused candidate leaves the current session usable. Reopening a closed session and the format restamp publish in one atomic metadata write, so a refused resume never leaves a session marked open under its old version.

### Checkpoints

`performCheckpoint` ([checkpoint.ts](../../src/domains/session/checkpoint.ts)) is a three-stage write: the ledger appends are `fsync`ed and `tree.json` is persisted through the writer, then `meta.json` is rewritten with `lastCheckpointAt` and `lastCheckpointReason`. Reasons in use are `shutdown` (session extension stop), `context-summary` (after a compaction summary lands) and `context-handoff` (continuity transaction barriers), and `restart` (before an interactive restart). Nothing is written once `clio-coder uninstall` has removed the state root, so a late checkpoint cannot rebuild a deleted tree.

### Recovery on open

The ledger is authoritative and `tree.json` is a derived index. When `tree.json` is missing, unreadable, or differs from the `message` entries in `current.jsonl`, opening the session rebuilds the tree from the ledger. A torn trailing ledger line is skipped with one warning. A host killed before it wrote `endedAt` leaves an unended record; `endAbandonedSession` dates the end by the transcript's last write once the caller has proof that the host process is dead. It names the dead owner and runs under the lock a resume takes, so it never ends a session another process has reopened since.

---

## 3. Append-Only Context Ledger (`current.jsonl`)

The session ledger `current.jsonl` records all conversation events, model turns, tool executions, and checkpoints in strict append-only order.

### Header Line

The first line of `current.jsonl` is the canonical session header. A forked session adds `parentSession` (the path of the parent's `current.jsonl`) and `parentTurnId`:

```json
{"type":"session","version":6,"id":"01912a34-b567-7890-abcd-ef0123456789","timestamp":"2026-08-14T12:00:00.000Z","cwd":"/path/to/project"}
```

### Entry Taxonomy

Subsequent lines represent typed `SessionEntry` objects ([entries.ts](../../src/domains/session/entries.ts)). Every entry carries `kind`, `turnId`, `parentTurnId` and `timestamp`. The 19 kinds are:

| Kind | Content |
| --- | --- |
| `message` | User inputs, assistant responses, and tool calls and results. The `role` is `user`, `assistant`, `tool_call`, `tool_result`, `system` or `checkpoint`. A user payload carries the prompt `text` sent to the model, and may carry `operatorText` (the raw input before scaffold expansion) and `displayText` (the literal editor input when a prompt template or command expansion replaced it, rendered by the session picker and transcript replay). |
| `bashExecution` | An operator shell command: command, output, exit code, `cancelled`, `truncated`, an optional `fullOutputPath`, and `excludeFromContext`. |
| `custom` | Typed extension data (`customType`, `data`). `handoffSeed`, `handoffNote` and the operator recovery request are custom types. |
| `modelChange`, `thinkingLevelChange` | Route changes: provider, model id and target, or the new thinking level. |
| `fileEntry` | A file observation: path, operation (`read`, `write`, `edit`, `create`, `delete`), optional bytes and hash. |
| `branchSummary` | A summary standing in for upstream history at a branch point. Replayed as a user-role context message and counted as a turn start. |
| `compactionSummary` | The compaction checkpoint: `summary`, `tokensBefore`, optional `tokensAfter`, `firstKeptTurnId`, `trigger`, `messagesSummarized`, `usage`, `isSplitTurn`, active `userContext` and `skillContext`, and an optional `continuity` payload. |
| `sessionInfo` | The session display name, or a label for an earlier turn through `targetTurnId` and `label`. The last write wins and an empty label clears it. |
| `label` | A turn bookmark anchored to `targetTurnId`. |
| `protectedArtifact` | A path protected from later writes, with the reason and the validation command that produced it. |
| `skillActivation` | One skill activation with its source, hash and drift state. |
| `taskLedger` | Full session task-board snapshot with a stable board id, goal and subgoal states, active run ids, required validation evidence, and optional operator provenance through `origin: "user"` plus `userTaskId`. |
| `decisionLedger` | Branch-anchored snapshot of a completed or cancelled `ask_user` interview, or of a decision set the model recorded with the `decide` tool, including its timing, round count, settled values, superseded values, and operator corrections. |
| `workerRun` | A dispatched worker's identity: assignment id, run id, agent id, runtime and origin. Never worker output. |
| `contextEviction` | Policy, trigger, estimated token changes, and references to evicted observations or thinking blocks; the original bodies remain in the ledger. |
| `contextRecall` | Reference, trigger, and token readmission for explicit recall or a matching reread. |
| `handoffTransaction`, `continuityCommit` | Durable records for staged context continuity and its committed checkpoint. See [Context continuity](../guide/context-continuity.md). |

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

`taskLedger`, `decisionLedger`, `workerRun` and the continuity records are context-free bookkeeping entries. They refold the `/tasks` and `/decisions` surfaces and enter evidence projection, but do not consume model-context tokens or become model messages by themselves.

### Write Durability & Atomicity

- Appends hold an open `O_APPEND` file descriptor across the writer lifetime (`src/engine/session.ts:openSync`).
- A complete UTF-8 line is written before its entry or tree node is acknowledged. Legal short writes continue from the remaining byte offset. Zero progress or a write error fails the append and attempts to truncate its partial bytes back to the previous length; rollback and cleanup failures retain their causes.
- `fsyncSync` is debounced by 500 ms (`APPEND_FSYNC_DEBOUNCE_MS`) during high-frequency streaming turns and forced for pending ledger writes on checkpoint (`persistTree`), explicit flush and session shutdown (`close`). A failed append retains the flush obligation for previously accepted bytes and rollback changes even when its descriptor is retired. Explicit flush failures remain visible and retryable.
- Atomic ledger replacements complete, flush and close their temporary file before publication. An incomplete replacement leaves the previous canonical ledger in place. These guarantees assume one writer per ledger. The lock on `meta.json` decides which process that writer is; no lock covers an individual append, and no transaction spans all session files.
- Torn last lines resulting from abrupt system crashes or power losses are tolerated by the ledger reader (`src/engine/session.ts:readSessionFileEntries`), which logs a warning and skips the incomplete trailing record. The same damaged line is reported once per process.

---

## 4. Conversation Tree Graph (`tree.json`) & Lineage

CLIO Coder tracks all conversation turns as a directed tree graph, enabling non-destructive branching, navigation, and message forking.

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

When an operator branches or switches turns using `/tree`, the next append point changes without mutating or deleting historical entries in `current.jsonl`.

The active path filter ([active-path.ts](../../src/domains/session/tree/active-path.ts)) traces ancestry back from the active leaf:
1. Resolves all `turnId` identifiers tracing back to the root `null` parent.
2. Selects all ledger entries explicitly matching these `turnId`s.
3. Both `/tree` (in-session switch) and `/fork` (new session branch) reconstruct the exact same state, strictly excluding any unanchored sidecar entries (`taskLedger`, routing notices, leafless `workerRun`) that appear after the chosen leaf's position.
4. For a `/tree` switch, the active pin is persisted to `meta.pinnedLeafTurnId` and cleared on the next append, so a switch survives quit and `/resume` without reverting to the abandoned tip via timestamp inference.
5. Prunes abandoned sibling branches from the context window supplied to the LLM.

After a `/tree` switch or a resume, the transcript, the footer totals, `/usage` and the working-set fold all follow the active path, not the whole file.

### Branch Forking (`/fork`)

`/fork` opens the message picker for an assistant turn. The fork (`src/domains/session/tree/fork.ts:forkFromState`) initializes an independent session branched from that turn:
1. Reads the parent's ledger and traces ancestry before the parent writer is touched, so a broken fork point leaves the parent open.
2. Creates a new session directory and metadata inheriting `cwd`, `model`, and `target` from the parent.
3. Copies exactly the active path entries into the new session ledger. Entries written after the fork point are dropped when they are unanchored sidecars, compaction summaries, `handoffTransaction` or `continuityCommit` records, or an operator handoff recovery request. A fork never inherits permission to resume the parent's handoff.
4. Stamps `parentSession` (the parent's ledger path) and `parentTurnId` in the new session header, and `parentSessionId` and `parentTurnId` in the new `meta.json`.
5. Closes the parent writer last, after the child is created, seeded and stamped.

### Handoff with `/handoff`

`/handoff` mints a successor session seeded with a reviewed document describing
what the current session settled. It is a session operation and only that: it
writes no memory promotion candidate, touches no memory record, and never calls
the task-memory bank.

The goal must be at least 12 characters and cannot be one of `continue`, `keep going`, `same`, `next`, `go on`, `proceed` or `resume`. A turn in flight refuses the command. The service is shared with other hosts in [handoff-service.ts](../../src/domains/session/handoff-service.ts), and the pure rules are in [handoff.ts](../../src/domains/session/handoff.ts).

The rule that makes the document trustworthy is read-ledger validation. CLIO Coder folds
this session's persisted `read`, `edit`, `write`, `ls`, `find`, `grep`, and
`artifact` tool calls (plus its `fileEntry` records) into a set of
workspace-relative paths, through `filterEntriesToActivePath` so an abandoned
`/tree` branch contributes nothing, exactly as the task board folds its own inputs.
Every path the extraction round names is checked against that set and never against
the filesystem. A file that exists on disk but that this session never opened is
still an invention, so it is dropped and listed in the review document under
`dropped (not in this session's read ledger)`.

The extraction returns decisions (at most 24), facts (32), files (48), commands (16) and open questions (16), each string cut at 512 bytes with a visible `…[truncated]` marker. A refused answer gets one repair round that quotes the parser's complaint. The round is capped at 4,096 output tokens.

Extracted decisions merge with the session's settled decision board
([decision-board.ts](../../src/domains/session/decision-board.ts)); board entries win on conflict and are
marked as settled. Superseded board decisions are history and do not travel.

The operator reviews the document in an overlay and may edit it in `$VISUAL` or `$EDITOR`. On accept, each of the source session's `clio_coder_flow_restriction` entries is copied into the new session ahead of the seed, because the document was drawn from restricted context and no document may exist unlabeled ([handoff-service.ts](../../src/domains/session/handoff-service.ts)). The new session then holds one `custom` entry of type `handoffSeed`
carrying the reviewed document, the originating session id, and the goal. It
projects into the model's replay as one user-role context message labelled as a
handoff from the named session, on the same seam compaction and branch summaries
use; it is never written as a fabricated user turn. The old session's
`skillActivation` entries are replayed into the new session so loaded skills carry
forward. The old session gains exactly one `custom` entry of type `handoffNote`
recording the target session id, and is otherwise untouched. Esc during review
cancels the whole handoff with nothing written in either session. A seed that cannot be written resumes the source session, whose ledger still holds its labels, and removes the new one.

The extraction round itself runs on the out-of-turn seam `/btw` uses: one call
against the session's live target and model, the compiled message history as
read-only input, no tools, and no entry in the ledger. Its provider usage is
reported to `/usage` under a handoffs row and excluded from the turn count.

### Streaming Turn Settlement During Session Transitions

When an operator issues `/new`, `/resume`, `/tree`, or `/fork` during streaming, `settleChatBeforeSessionSwitch` cancels and awaits the in-flight turn so partial assistant records and completed tools settle before replacing the writer. A busy `/new` says it is cancelling the active run, and any follow-up queued behind that run goes back into the editor instead of being dropped, including one still expanding when the session changed. A slash command typed while a run is active cannot be queued or sent now with `Alt+S`, because the model would receive it as text. CLIO Coder refuses it with a notice and keeps the draft, and `Enter` runs it now, cancelling the active run. Shutdown separately stops shell admission and drains the active operator command. Shutdown hooks default to 500 ms each; the operator-shell hook allows six seconds for its five-second TERM-to-KILL escalation, and worker process-group escalation uses a 500 ms grace. Descendants in the owned process group are signaled with it. Processes that daemonize or leave the group are not covered.

---

## 5. Session Resumption (`/resume`) & Working Directory Fallback

### Entry points

| Entry point | Behavior |
| --- | --- |
| `/resume` | Opens the picker. The picker lists only sessions that reached a model turn: an assistant message with text or a tool call, or a tool call. A session that was opened and never used, or whose only assistant turns were empty failures, is hidden, and an ended session is not drawn as a success because closing it does not show the run succeeded. |
| `/resume <id\|prefix>` | Resumes directly (`src/interactive/overlay-session-lifecycle.ts`). An exact id wins; otherwise the prefix must name exactly one session. Without a match the command warns (`no session matches <target>` or `<target> matches N sessions`) and opens the picker with the argument as its filter. Matching runs over the sessions recorded for the current working directory and does not apply the picker's model-turn filter. |
| `clio-coder run --session <id>`, `clio-coder run --continue` | Headless resume. `--continue` takes the most recent session for the working directory. A session that cannot be resumed fails the run with exit code 2 instead of answering without its history. The two flags together, or either with `--agent`, are usage errors. Neither uses the picker filter. |
| `clio-coder --resume`, `--continue`, `-r`, `-c` | Refused as unknown global options with exit code 2 (#191) by `src/cli/argv.ts`. The error names `/resume` inside the app. Sessions resume from inside the app, or through `run` for headless work. |

On a clean interactive exit CLIO Coder prints a session summary whose last line is `To resume: clio-coder, then /resume <sessionId>`. `interface.exitSummary` (`auto`, `brief`, `standard`, `report`, `off`; default `auto`) sets its detail. `auto` follows `interface.outputDetail`: compact selects brief, standard selects standard, and detailed selects report. Legacy `full` reads as standard. `off` prints only the resume line ([defaults.ts](../../src/core/defaults.ts)). A session with no model turn prints nothing. `clio-coder --session-file <path>` keeps a live JSON record of the interactive session at `<path>`: it is rewritten at every turn boundary and on every move into or out of a wait (`working`, `idle`, `awaiting-approval`, `awaiting-answer`), and the exit record (`state: "ended"`, with the outcome, exit code, usage and models) replaces it when the session ends ([session-file.ts](../../src/interactive/session-file.ts)). The flag is refused with a subcommand. The snapshot is kept by [exit-summary-collector.ts](../../src/interactive/exit-summary-collector.ts) and formatted by [exit-summary.ts](../../src/interactive/exit-summary.ts); the key is listed in [Commands and modes](../guide/commands-and-modes.md).

When resuming a session via `/resume` or a headless `clio-coder run --session <id>` / `--continue`:
1. `src/domains/session/manager.ts:resumeSessionState` loads `meta.json` and runs migrations.
2. `src/domains/session/cwd-fallback.ts:resolveSessionCwd` probes the recorded `meta.cwd` against the filesystem.
3. If the directory is invalid, it returns a typed failure reason:
   - `no-cwd`: `meta.cwd` is missing or empty.
   - `missing`: The directory no longer exists on disk.
   - `not-a-directory`: The path points to a non-directory file or broken symlink.
4. The TUI displays the `cwd-fallback` overlay to choose a valid directory. A headless caller cannot display that overlay and fails the resume instead.

### What a resume restores

- **Transcript and model replay** follow the active leaf, which is `meta.pinnedLeafTurnId` when a `/tree` switch left one and the newest turn otherwise.
- **Route.** The recorded target, model and thinking level come from the session metadata and the last `modelChange` and `thinkingLevelChange` rows ([resumed-route.ts](../../src/domains/session/resumed-route.ts)). They apply as a session-scoped override and are not saved to settings. A recorded target that is no longer configured keeps the current route and prints a notice. An explicit CLI route flag wins over the recorded route.
- **Usage totals** for `/usage` and the footer come from the telemetry read model, which a resume or branch switch rebinds to the session, so a resumed session shows its own recorded numbers ([extension.ts](../../src/domains/telemetry/extension.ts)).
- **Boards and fold.** Task board, decision board and the working-set fold are refolded from the ledger.
- **Task-memory handoff offer.** Switching to a different session announces any task-memory handoff entries available from `.clio-coder/handoffs/` and tells the operator to run `/memory seed` to import them, see [Proactive memory](../guide/proactive-memory.md).

### Model-Facing Custom Entry Replay

When resumed or forked session history is replayed to the model, compaction summaries, branch summaries, and operator bash executions use standardized user-role text through [messages.ts](../../src/engine/messages.ts). Operator messages, assistant messages and tool results replay in full, byte for byte as the provider received them, so a resumed session keeps its original prefix. The 20,000-character cap in [session-replay-messages.ts](../../src/session-control/session-replay-messages.ts) applies to the standardized context text: summaries, operator bash output and system notes. Working-set projection runs before compaction counting and summary serialization, while raw ledger entries remain intact. Tool results hidden by summaries are discoverable with `context(scope="recall")` and recoverable by exact ref through the normal observation envelope; older destructive logs cannot recover removed bytes.

## How new sessions, resume and fork differ in history and workspace

CLIO Coder provides distinct lifecycle operations for managing conversation continuity, history lineage, and workspace directories:

| Operation | Session ID & Ledger | History Lineage | Workspace (`cwd`) Behavior |
| --- | --- | --- | --- |
| **New session (`/new` or fresh launch)** | Mints a new UUIDv7 `<sessionId>` in `<stateDir>/sessions/<cwdHash>/<sessionId>/` with an empty `current.jsonl` containing only the session header. | Starts at turn 0 with a clean context window. Previous session turns, compactions, and memory working sets are not carried forward. While `context.memory.enabled` is on, the prompt can still carry approved `# Memory` records for this repository. With memory on or off it can carry one `Last recorded session here` line naming an earlier session with two or more operator messages that has ended or been quiet for 10 minutes, shown in `/context`. The line quotes that session's name or first message with secrets redacted, and gives only the id and time of a session holding a flow restriction or a memory-off marker. Shared project tasks remain accessible on disk in `.clio-coder/user-tasks.json`. | Uses the active process working directory (`process.cwd()`). Computes a fresh `<cwdHash>` for the session directory. |
| **Resumed session (`/resume <id>`, or `clio-coder run --session <id>` and `--continue` headless)** | Reopens the existing session directory and writer. Continues appending new turns directly to the existing `current.jsonl` ledger. | Reconstructs the exact message history, compaction summaries, task board snapshots (`taskLedger`), and decision board states along the active leaf path (`meta.pinnedLeafTurnId` or latest tip). | Probes recorded `meta.cwd` against the filesystem (`resolveSessionCwd`). If the recorded directory was moved or deleted, the TUI offers `cwd-fallback`; a headless resume fails. |
| **Forked session (`/fork`)** | Mints a brand new UUIDv7 `<sessionId>` in a new session directory. Stamps `parentSession` and `parentTurnId` in the new session header. Leaves the parent ledger closed and immutable. | Copies the exact active path lineage up to `parentTurnId` from the parent ledger into the new session ledger, excluding later turns, abandoned sibling branches, and unanchored sidecars. Subsequent turns append only to the new ledger. | Inherits the parent session's `cwd`, `model`, and `target` settings. Operates in the same workspace directory without creating a duplicate disk workspace. |
| **Handoff (`/handoff <goal>`)** | Mints a brand new session with a new ID. The previous session receives an immutable `handoffNote` entry and closes. | Replaces raw conversation turns with a single synthesized `handoffSeed` context message containing a reviewed distillation of settled decisions and validated read-ledger paths. The source session's flow restrictions are copied ahead of the seed. Loaded skill activations are replayed so skills carry forward. | Operates in the current project workspace directory, carrying forward validated project context while shedding conversation token weight. |

---

## 6. Session Export

`/export` replays the active branch through the same transcript projection used by the live TUI and `/resume`. With no path, it writes `.clio-coder/exports/<sessionId>-<local-date>.html`. The HTML document is self-contained, carries the active CLIO Coder theme through converted ANSI styles, renders tool calls as semantic tool rows, references no external assets, and is capped at 2 MiB. If the transcript exceeds that limit, the export ends at a complete rendered row and states that later rows were omitted.

An explicit path ending in `.md` keeps the plain Markdown form: a heading, UTC export instant, and a terminal-control-free fenced transcript. Export never changes the ledger or the active tree pin. Both formats follow the pinned active leaf and omit abandoned sibling turns.

---

## 7. Directory Handbooks and Project Overrides

During session context loading, `loadProjectClioMd` ([clio-md.ts](../../src/domains/context/clio-md.ts)) captures readable authored Markdown from root `CLIO-CODER.md` handbooks and directory-scoped `CLIO-CODER.override.md` files. The capture is frozen for the session. Init, refresh, and reset invalidate captured session inputs, refresh preserves handbook bytes, and captured-source hashes are retained separately in accounting and manifest metadata.

Which file wins in a directory, how an override resets the inherited chain, the 24,000-unit and 220-line preload budget, omission notices, and worker routing are specified in [Context Engine](context-engine.md#project-handbooks--preload-hierarchy). A target with tools disabled cannot retrieve an omitted suffix through session tools, so the omission notice names source paths and line ranges instead.

---

## 8. Prompt History and Input Recovery

The interactive editor provides process-local prompt history via `Ctrl+P` (previous) and `Ctrl+N` (next), bound as `tui.editor.historyPrevious` and `tui.editor.historyNext`:
- Accepted chat prompts, slash commands, local command executions, steering inputs, follow-ups, and interrupt messages are preserved in navigation history.
- Consecutive duplicates are collapsed.
- Rejected or malformed commands remain editable in the composer without polluting navigation history.
- Navigating forward past the newest entry restores the unfinished draft prompt.

---

## 9. Protected-Artifact Write-Ahead Journal

To guarantee that protected artifacts and validation locks survive unexpected crashes between tool execution and ledger commitment, CLIO Coder maintains a write-ahead journal ([protected-artifact-journal.ts](../../src/domains/session/protected-artifact-journal.ts)):

- Location: `<stateDir>/protected-artifact-pending/<sha256(sessionId)>/<recordId>.json`
- Lifecycle:
  1. **Stage**: Before a mutating tool result is returned, the protected artifact registration is staged atomically to the journal directory.
  2. **Commit**: Once the turn completes and appends to `current.jsonl`, the staged journal file is unlinked.
  3. **Reconcile**: During session startup or resume, `reconcilePendingProtectedArtifacts` reads any leftover staged records and injects them into the protection engine before accepting user commands.

---

## 10. In-Session Task Board & Usage Accounting

- **Task Board** ([task-board.ts](../../src/domains/session/task-board.ts)): Maintains session task items as full `taskLedger` snapshots with `pending`, `active`, `completed`, `blocked`, and `cancelled` states. Stable board ids retain terminal board history; rows picked from the project operator inbox retain `origin: "user"` and `userTaskId` across `/resume`, `/fork`, `/view`, and evidence export. The project-scoped inbox itself lives at `.clio-coder/user-tasks.json`, outside the session directory.
- **Decision Board** ([decision-board.ts](../../src/domains/session/decision-board.ts)): Appends one branch-anchored `decisionLedger` snapshot when an `ask_user` interview completes or is cancelled. Superseding or correcting a value appends a new snapshot, preserving the earlier value and the operator-authored revision trail.
- **Usage Accounting** ([usage.ts](../../src/domains/session/usage.ts)): Aggregates session token counts across input, output, cache read, cache write, and reasoning tokens. Anchors against provider-reported totals on settled turns.
- **Aborted Turn Persistence**: When a turn is interrupted by `Ctrl+C` or a SIGINT signal, partial assistant output and completed tool executions are committed to `current.jsonl` before yielding the prompt, and an empty aborted assistant message is dropped.
