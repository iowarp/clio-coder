---
title: "Workspace snapshots and rewind"
summary: "How Clio Coder records recoverable Git snapshots of the work tree before mutating or destructive tool calls, pins refs that a destructive Git command would lose, and restores or previews a rewind. Read this when changing snapshot timing, rewind behavior, ref pinning, or retention."
sources:
  - "src/domains/workspace-snapshots/index.ts"
  - "src/domains/workspace-snapshots/store.ts"
  - "src/domains/workspace-snapshots/pins.ts"
  - "src/domains/workspace-snapshots/trigger.ts"
  - "src/domains/workspace-snapshots/git.ts"
symbols:
  - "createWorkspaceSnapshots"
  - "pruneWorkspaceSnapshots"
  - "workspaceSnapshotRepositoryPresent"
  - "workspaceSnapshotTrigger"
  - "snapshotPins"
  - "rewindRefs"
  - "runGit"
tests:
  - "tests/contracts/workspace-snapshots.test.ts"
invariants:
  - "A snapshot is built in a private per-session index, so the operator's index, HEAD, branches and worktree are not changed by taking one."
  - "A snapshot of an unchanged tree that already pins every current ref reuses the previous record instead of writing a new one."
  - "Untracked files above the size limit and nested repositories are excluded from a snapshot and listed in its skipped entries."
  - "A rewind never moves a ref; it writes or removes working-tree files and reports pins with a recovery command for the operator to run."
  - "An unavailable snapshot (no Git work tree, bare repository, timeout, or Git failure) is reported as unavailable and does not hold the tool call that asked for it."
validate:
  - "pnpm run test:file tests/contracts/workspace-snapshots.test.ts"
---

# Workspace snapshots and rewind

Workspace snapshots are the recoverability layer under autonomy. Before an admitted tool call that mutates the workspace, or one that can discard work, Clio Coder records a Git commit of the work tree as it stands. A reader needs this page when changing when snapshots are taken, how a rewind restores files, how refs are pinned so that a dropped stash or deleted branch stays recoverable, or how old snapshot state is pruned.

The area lives in `src/domains/workspace-snapshots/`. Its files are:

- `src/domains/workspace-snapshots/index.ts`: re-exports the public types and functions. It contains no logic.
- `src/domains/workspace-snapshots/store.ts`: the snapshot store, which owns staging, commit creation, the session log, preview, and restore.
- `src/domains/workspace-snapshots/pins.ts`: reads ref state and computes the pins each snapshot holds, plus the recovery command for each pin.
- `src/domains/workspace-snapshots/trigger.ts`: a pure function that decides whether an admitted call needs a snapshot, and why.
- `src/domains/workspace-snapshots/git.ts`: the Git subprocess wrapper used by all of the above.

## What the area does

A snapshot is a commit whose tree is built from the worktree (tracked files, plus untracked files that are not ignored). It is written under `refs/clio-coder/snapshots/<session>/<n>`. Git keeps `refs/clio-coder/` in the common directory of a linked worktree, so the refs are shared across worktrees of one repository. The snapshot's pins are written under `refs/clio-coder/snapshots/<session>/pins/<n>/`, one ref per pinned object (HEAD, each stash entry, and each branch named by a delete). The pins keep those commits reachable after a destructive command, so `git gc` does not drop them.

The session's records are kept in a `log.json` file under the snapshot state directory, with `next` as the next snapshot number. The log is capped at `SNAPSHOT_KEEP` (50) records by default, and the older records and their refs are dropped as new ones are taken.

Only a Git work tree can be snapshotted. Every other case returns `kind: "unavailable"` with a reason, and the caller proceeds without a snapshot.

## Entry points and wiring

There are three operations that matter to callers, all on the object returned by `createWorkspaceSnapshots` in `src/domains/workspace-snapshots/store.ts:368:createWorkspaceSnapshots`:

- `snapshot(request)` takes a snapshot. It is called with a `WorkspaceSnapshotRequest` carrying a `reason`, optional `tool`, `toolCallId`, `turnId`, and `refs` (an `RefsAtRisk` value).
- `preview(n)` and `restore(n)` plan and perform a rewind to snapshot `n`.
- `list()`, and `differences()`, which counts how many files each snapshot differs from the current tree.

The main session's tool registry calls the snapshot operation through a `workspaceSnapshot` hook. The hook is defined in `src/entry/orchestrator.ts` near `workspaceSnapshot: async ({ sessionId: requested, ...request })`. That hook returns `null` when `safety.snapshots` is `"off"` or no session is open. Otherwise it calls `createWorkspaceSnapshots({ stateDir: clioStateDir(), sessionId, cwd: process.cwd() }).snapshot(request)`. The first snapshot of a session also schedules `pruneWorkspaceSnapshots` in the background, passing `keepSessionId` so the starting session is never pruned. The hook's own comment states that workers never snapshot; the registry hook is wired only for the main session.

The registry consumer is `src/tools/registry.ts`. Its `workspaceSnapshot` option is documented around line 432 as taking a snapshot before an admitted call's body runs. Around line 1005 the registry calls `workspaceSnapshotTrigger(effect, decision)`. A call admitted because a snapshot would undo it is forced to `{ kind: "always", reason: "destructive" }`, whatever the trigger says otherwise. An `unavailable` outcome does not stop the call: the tool result says that no snapshot was taken and why.

The admission path reads `workspaceSnapshotRepositoryPresent(cwd)` in two places: the orchestrator's containment callback at `src/entry/orchestrator.ts` (the `containment` property sets `snapshots` from `safety.snapshots !== "off"` and that check), and `src/cli/doctor.ts` around line 231. Both only test for a `.git` entry at or above the working directory. The snapshot itself still asks Git whether the directory is a work tree.

`src/interactive/overlay-general-openers.ts` also constructs a snapshot object with `createWorkspaceSnapshots` around line 370, to back the interactive rewind overlay. That consumer is not covered on this page; see [interactive overlays](../interactive/overlays.md) for the surface.

## Trigger: when a call gets a snapshot

`workspaceSnapshotTrigger` in `src/domains/workspace-snapshots/trigger.ts:169:workspaceSnapshotTrigger` is pure. It reads the call's effect (`ClassifierCall`) and the admitted `SafetyDecision`, and returns one of three kinds:

- `none`: the action class is not mutating, the tool's effect never lands in the workspace (`web_fetch` and `configure_clio` are listed in `OUTSIDE_WORKSPACE_TOOLS`), or the bash command is recognized read-only.
- `turn`: a mutating call covered by the turn's first snapshot.
- `always`, with a `reason` of `destructive`, `delete`, `git-discard`, `git-ref-delete`, or `git-ref-move`, and optionally `refs`. The call gets its own snapshot before its body runs, whatever the turn already holds.

The order of checks in `workspaceSnapshotTrigger` is fixed by the code. First, a `git-discard` check (`gitDiscards`) runs, which matches either a damage-control rule id from `GIT_DISCARD_RULE_IDS` or the normalized command against `GIT_DISCARD_COMMANDS`, a list of patterns covering checkout with a pathspec or force, restore, clean, reset with `--hard`, `--merge` or `--keep`, and stash drop, clear or pop. Next comes a `git-ref-delete` check on the result of `deletedBranches`, then `git-ref-move` on `movesBranchTip`. Then a `destructive` check on the action class, then a `delete` check using `extractCommandPathWalks`. Only after these checks does the function consider `recognizedReadOnly`, which returns `none` for the read-only rules.

The `refs` field is set only when a branch delete, a stash loss, or a reset that moves HEAD was found. It tells the snapshot which refs the call is about to destroy or move, so `snapshotLocked` can pin them.

Tests for this behavior are in `tests/contracts/workspace-snapshots.test.ts`, in the `describe("registry snapshot trigger")` block. That test invokes a registry with a fixture safety contract that admits every call with its base class. It asserts that the first mutating call of a turn gets `turn-start` with `toolCallId: "c-1"`, that `git checkout -- .` gets `git-discard`, that `rm notes.txt` gets `delete`, and that `git branch -D feature-x` gets `git-ref-delete` with `refs` naming `feature-x`. The same test checks that a later `unavailable` outcome leaves the write running and adds `no snapshot: not a git repository` to the tool output.

## Taking a snapshot

`snapshot` in `createWorkspaceSnapshots` first checks the session id. `sessionIdProblem` in `src/domains/workspace-snapshots/store.ts` requires an id that matches `^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$`, is at most 128 characters, and does not end in `.lock`. A bad id returns `unavailable` immediately.

The snapshot runs under `withSessionLock`, a per-directory promise queue. The queue exists because the private index and `log.json` are shared between the tool registry and `/rewind`. `snapshotLocked` then runs with a deadline of `timeoutMs` (default 20 seconds):

1. `resolveRepository` runs one `git rev-parse` call that prints bare, inside-work-tree, toplevel, common dir and the operator's index path. A bare repository or a path outside a work tree throws `SnapshotUnavailableError`.
2. If the session log exists and its `workspace` differs from the repository root, the snapshot is refused.
3. `stageWorkspace` and `readRefState` run in parallel. Staging creates the private index under `dir`, seeds it by copying the operator's index (or from HEAD's tree when there is none), lists untracked files with `ls-files --others --exclude-standard`, and excludes files over `maxUntrackedBytes` and nested repositories. It then runs `git add -A` with the excluded paths as `:(exclude,literal)` pathspecs, removes any excluded paths from the private index, and runs `write-tree`. If `git add` fails with a copied index, it reseeds from HEAD and retries once. Ref reading failure does not fail the snapshot; it leaves the pins empty and sets a `pinNote`.
4. If the last record has the same tree and already holds every pin `snapshotPins` would now produce, that record is returned with `reused: true`. A changed pin set writes a new record even when the tree matches.
5. Otherwise the commit is created with `commit-tree --no-gpg-sign` under a fixed identity, the ref is updated, and the pins are written in one `update-ref --stdin` transaction. If the pin write fails, the snapshot stands with `pins` empty and a `pinNote`.
6. The log is rewritten with the new record. Records beyond `keep` are dropped, and their snapshot refs and pins are deleted on a best-effort basis.

The test in `tests/contracts/workspace-snapshots.test.ts`, named "captures tracked and untracked files, skips ignored and oversized ones, dedups, and leaves the index alone", uses a `maxUntrackedBytes` of 1024 and a 2048-byte `big.bin`. It asserts that `skipped` is `[{ path: "big.bin", why: "too-large", bytes: 2048 }]`, that the commit's tree contains `.gitignore`, `a.txt` and `u.txt` but not the ignored `z.log`, and that a second call returns `reused: true` with `n` still 1. It also checks that the operator's `.git/index` bytes and `HEAD` are unchanged.

## Pins

`src/domains/workspace-snapshots/pins.ts` defines `SnapshotPin` with three kinds: `head` (the commit, plus `branch` when HEAD is on one), `stash` (an entry with its index and reflog message), and `branch` (a named tip). `readRefState` reads HEAD with `rev-parse`, the stash with `stash list -z`, and the named branches with `for-each-ref`. Only exact branch names count, because a `for-each-ref` pattern also matches refs beneath it. `snapshotPins` turns the state into pins, with at most `STASH_PIN_LIMIT` (64) stash entries. The branch pins are sorted by name.

`rewindRefs` places each pin against the refs as they stand now. It returns `in-place`, `moved`, `gone`, or `unknown` (when refs could not be read), with a `recover` command that the operator runs by hand. Recovery commands are `git branch <name> <sha>`, `git reset <sha>` (for the checked-out branch), `git branch -f`, `git switch --detach`, or `git stash store -m <message> <sha>`. Stash pins are returned in oldest-first order, because `git stash store` pushes onto the stack top.

`unpinnedRefs` lists the refs at risk that a record does not cover. In `snapshotLocked`, a call whose refs could not be pinned still gets a snapshot, and its outcome names those refs in `unpinned`.

The focused test "pins HEAD and the stash, so the preview names the command that brings a dropped entry back" in `tests/contracts/workspace-snapshots.test.ts` creates a stash with the message `keep me`, takes a snapshot with reason `git-discard`, and asserts the exact pin list: a `head` pin with `branch` set to the current branch, and a `stash` pin whose `message` is `On <branch>: keep me`. After `git stash drop`, a later `turn-start` snapshot reuses record 1. The preview then reports the `stash` pin as `gone` with the recovery command `git stash store -m 'On <branch>: keep me' <sha>`, and running that command restores `stash@{0}`.

The test "pins the branches a delete names at their tips" creates a branch `feature-x`, takes a `git-ref-delete` snapshot with `refs.branches` set to `["feature-x"]`, and checks that record 2 is written (not reused) with the pin at `refs/clio-coder/snapshots/s-1/pins/2/branch/feature-x`. After `git branch -D`, the preview reports that branch as `gone` with `git branch feature-x <tip>`.

## Rewind

`preview(n)` locks the session, finds record `n` in the log, stages the current worktree, and calls `planRewind`. `planRewind` diffs the target tree against the current tree with `diff-tree -r -z --no-renames`. For each raw entry:

- Entries involving a gitlink (mode `160000`) are kept, with the reason `nested repository`.
- Entries with status `A` (only in the current tree) go into `remove`.
- Entries with status `D` (only in the snapshot) go into `restore`, unless an ignored or untracked file occupies the path, in which case they are kept with `an ignored or untracked file is in the way`.
- All other entries go into `restore`.

Candidates for `remove` and `restore` are then passed through `git check-ignore`, and ignored files that exist on disk are kept (`ignored by .gitignore`). A directory that restore would overwrite is checked by `outsideRemoval`, which walks its children; if any child is not in the removal plan, the directory is kept with the reason `directory contains <path> outside the rewind removal plan`. The comment in the code cites this as a fix to an audit finding, and the directory check runs before deletions.

`restore(n)` runs `restoreLocked` under the same session lock. It first takes a snapshot with reason `pre-rewind`, so the rewind itself is recorded and can be undone. If that snapshot fails, it returns `unavailable` and changes nothing. It then recomputes the plan against the new pre-rewind tree, deletes the files in `remove`, and for each path in `restore` runs `writeBlocker`. That check refuses a path whose parent is a symlink or a file, or a directory that cannot be pruned empty. Files that pass are written with `checkout-index -f -z --stdin` against a throwaway index that holds the target tree, so modes and filters are restored. The throwaway index is removed afterward. The result lists `restored`, `removed`, `kept` and `failed`, plus `refs` from `placePins`. A rewind never calls a ref-moving Git command; the pins are only reported.

`restoreLocked` returns `kind: "failed"` with `preRewind` when an error happens after the pre-rewind snapshot is taken, so the operator still has that snapshot to undo the partial change.

The contract test "rewinds by overwriting, recreating and removing files, never touching ignored or oversized ones" changes `a.txt`, removes `u.txt`, adds "src/new.txt", and edits the ignored `z.log`. The preview's `plan.restore` is `["a.txt", "u.txt"]` and `plan.remove` is `["src/new.txt"]`. After `restore(1)`, `a.txt` and `u.txt` have their snapshot content, `src` no longer exists, `z.log` keeps its edited content, `big.bin` is still present, the operator's index is unchanged, and `outcome.preRewind.n` is 2. A second `restore(2)` brings back the edited content, which shows that the pre-rewind snapshot can be rewound.

## Pruning

`pruneWorkspaceSnapshots` in `src/domains/workspace-snapshots/store.ts` removes session state and refs for sessions idle for more than 14 days (`SNAPSHOT_MAX_AGE_MS`). It skips `keepSessionId`. For each idle session directory, it reads the log's `commonDir` and deletes that session's snapshot refs from the repository, then removes the directory. It then scans every `refs/clio-coder/snapshots/` ref in the current repository. Refs belonging to a session whose state directory no longer exists are deleted when their commit date is older than the cutoff. A pin's age is taken from the snapshot it belongs to, while that snapshot's ref still exists. Unreferenced objects are not removed here; the code comment says they are left for `git gc`.

The contract test "removes pin refs with their snapshot, by retention and by the idle-session prune" uses `keep: 1`. After two snapshots, the test expects the refs `refs/clio-coder/snapshots/s-1/2` and `refs/clio-coder/snapshots/s-1/pins/2/head`. It then calls `pruneWorkspaceSnapshots` with `now` set 15 days ahead, and asserts that no `refs/clio-coder/` refs remain.

## Git subprocess layer

`src/domains/workspace-snapshots/git.ts` runs every snapshot Git call through `runGit`. It prepends `-c core.hooksPath=/dev/null` and any caller `config` pairs, uses `internalGitArgv`, and runs with `buildSafeToolEnv` plus `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`. A private index is passed through `GIT_INDEX_FILE` when `indexFile` is set. The comment in the file explains why the layer bypasses the tool command runner: its commit-attribution wrapper would add synchronous Git probes to every call.

`runGit` enforces a deadline: a call whose remaining time is zero or less rejects with `timed out`. Output is capped at 256 MiB (`MAX_GIT_OUTPUT_BYTES`), and the call is killed when the cap is exceeded. A non-zero exit fails with the first stderr line unless the exit code is listed in `allowExit`. Callers use `allowExit` where a non-zero status is an answer, for example `rev-parse` against a repository that is not present, `check-ignore` with no matches (exit 1), and the stash and branch reads.

`parseRawDiff` parses `diff-tree -z` output and the `--stdin` pair headers. The `pair` field of each entry is the input line index, which `differences()` uses to attribute counts to a snapshot.

## Enforced boundaries

- The private index is named explicitly for every snapshot Git call (`GIT_INDEX_FILE`). Staging and rewinds never write the operator's `.git/index`.
- Snapshot Git calls run with `core.hooksPath` set to `/dev/null`, and with `core.fsmonitor=false` and filter clean, smudge, process and required settings neutralized by `plumbingConfig`. `plumbingConfig` reads the repository's filter configuration once a minute per common directory. The contract test checks that the operator's index is unchanged, not the filter behavior, so the filter neutralization is established by source only.
- Path arguments from Git are checked by `insideRoot`, which throws `SnapshotUnavailableError` for a path that resolves outside the work tree. `restoreLocked` runs that check on every planned path before any deletion.
- A ref is never moved by a rewind. `placePins` only reads refs.
- `withSessionLock` serializes snapshot, differences, preview and restore for one session directory.

## Extension seams

To change which calls get a snapshot, edit `workspaceSnapshotTrigger` in `src/domains/workspace-snapshots/trigger.ts`. New discard or ref-delete command shapes belong in `GIT_DISCARD_COMMANDS`, `GIT_DISCARD_RULE_IDS` or `deletedBranches`. The registry (`src/tools/registry.ts`) decides how the trigger result is used, including the override that forces `always` for recoverable calls.

To pin additional refs, extend `RefState`, `snapshotPins` and `rewindRef` in `src/domains/workspace-snapshots/pins.ts`, and add the matching `RefsAtRisk` field that `src/domains/workspace-snapshots/trigger.ts` sets. The `SnapshotPin` union is what gets stored in `log.json`, so a new kind must be read back from records that predate it: `pins` is optional on `WorkspaceSnapshotRecord` for that reason.

Additional snapshot exclusions (paths the operator never wants captured) would be added in `stageWorkspace`, next to the `too-large` and `nested-repository` rules. The `SnapshotSkip.why` union in `src/domains/workspace-snapshots/store.ts` would also need the new value.

## Things to watch when editing

- `workspaceSnapshotRepositoryPresent` is synchronous and only checks for a `.git` entry. It is used during admission on every call, so it must stay cheap. The authoritative check is in `resolveRepository`.
- Trigger order matters. `gitDiscards` runs before `deletedBranches`, and a `git-discard` result takes precedence over a `git-ref-delete` for the same call. The trigger's tests only cover the cases listed above, so changing the order would change behavior that no test pins down exactly.
- A reused record can hold pins that are not the refs as they stand now. The reuse check requires every current pin to be present in the last record before it reuses it, so a moved HEAD or a changed stash writes a new record.
- Pins are stored in `log.json` and refs. Deleting a session's state without deleting its refs leaves the refs in the repository until the age prune removes them, because `pruneWorkspaceSnapshots` matches refs by the session directory's presence.
- `RewindOutcome` with `kind: "failed"` still leaves the pre-rewind snapshot on disk. Callers that display the outcome should show `preRewind.n` so the operator can rewind again.
