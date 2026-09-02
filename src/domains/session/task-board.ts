import { randomUUID } from "node:crypto";
import {
	isSessionEntry,
	type TaskLedgerGoal,
	type TaskLedgerStatus,
	type TaskLedgerValidationEvidence,
} from "./entries.js";

/**
 * The session task board: the live state behind the `tasks` tool, the footer
 * tasks row, and the /tasks overlay. Every mutation persists a full-snapshot
 * `taskLedger` entry (the dormant Phase 12 entry kind gains its producer
 * here), so the board is replayable from the JSONL alone and survives
 * resume/fork without any side-car state.
 *
 * Shape mapping onto TaskLedgerEntry:
 *   - the board title is the single top-level goal
 *   - tasks are subgoals with parentGoalId pointing at that goal
 *   - a completion note becomes a passed requiredValidationEvidence row,
 *     so "done" carries its receipt instead of a bare status flip
 */

const TASK_BOARD_GOAL_ID = "board";
export const LEGACY_TASK_BOARD_ID = "legacy";

export interface TaskBoardTask {
	id: string;
	title: string;
	status: TaskLedgerStatus;
	origin?: "agent" | "user";
	userTaskId?: string;
	/** Block or drop reason; empty for pending/active/completed tasks. */
	reason?: string;
	/** Evidence note recorded when the task was completed. */
	evidence?: string;
}

export interface TaskBoardSnapshot {
	/** Stable identity for this plan generation; task display ids are reusable. */
	boardId: string;
	title: string;
	tasks: ReadonlyArray<TaskBoardTask>;
	/**
	 * Dispatch runs currently in flight while this board is live, attached by
	 * the orchestrator from the dispatch bus. Process-local linkage: it is
	 * persisted on every snapshot so the JSONL records which runs served the
	 * board, but a refold after resume/fork restores it empty because those
	 * runs belong to the process that dispatched them.
	 */
	activeRunIds: ReadonlyArray<string>;
}

export interface TaskBoardCounts {
	total: number;
	completed: number;
	active: number;
	pending: number;
	blocked: number;
	cancelled: number;
	/** Tasks still owed work: pending + active. */
	open: number;
}

export type TaskBoardMutation =
	| { op: "plan"; title: string; tasks: ReadonlyArray<string> }
	| { op: "add"; tasks: ReadonlyArray<string> }
	| { op: "pick"; title: string; userTaskId: string }
	| { op: "start"; id: string }
	| { op: "done"; id: string; evidence: string }
	| { op: "block"; id: string; reason: string }
	| { op: "drop"; id: string; reason?: string };

export type TaskBoardMutationResult =
	| { ok: true; board: TaskBoardSnapshot; notes: ReadonlyArray<string> }
	| { ok: false; message: string };

/**
 * The fields a `taskLedger` entry carries beyond the BaseSessionEntry
 * envelope. `appendEntry` fills turnId/timestamp; parentTurnId stays null
 * because ledger snapshots are side-car bookkeeping (like label entries)
 * that never project into tree.json.
 */
export interface TaskLedgerEntryFields {
	kind: "taskLedger";
	parentTurnId: null;
	boardId: string;
	goals: TaskLedgerGoal[];
	subgoals: TaskLedgerGoal[];
	activeRunIds: string[];
	requiredValidationEvidence: TaskLedgerValidationEvidence[];
}

export interface TaskBoardStoreDeps {
	/**
	 * Current session id, or null when no session is bound. The store keys its
	 * in-memory board on this: a resume/fork/new-session switch invalidates the
	 * cache and the next read refolds the board from the session's entries.
	 */
	getSessionId?: () => string | null;
	/** Session entries for refolding after a session switch. */
	readEntries?: () => ReadonlyArray<unknown>;
	/** Persist one full-snapshot taskLedger entry. Absent means in-memory only. */
	appendEntry?: (entry: TaskLedgerEntryFields) => void;
	/** Stable board-id source; injectable for deterministic contract tests. */
	createBoardId?: () => string;
	now?: () => Date;
}

export interface SessionTaskHistoryBoard {
	boardId: string;
	title: string;
	tasks: ReadonlyArray<TaskBoardTask>;
	lastSnapshotAt: string;
}

export interface TaskBoardStore {
	/** Current board, refolded from the session ledger after a session switch. */
	snapshot(): TaskBoardSnapshot | null;
	/**
	 * Current in-memory projection only. Unlike snapshot(), this never reads or
	 * folds the session ledger and returns null rather than leaking a stale board
	 * when the session id changed or invalidate() has marked the cache dirty.
	 */
	cachedSnapshot(): TaskBoardSnapshot | null;
	/** Durable board generations on the active session path, newest first. */
	historySnapshot(): ReadonlyArray<SessionTaskHistoryBoard>;
	/** Apply one mutation, persist the resulting snapshot, and return it. */
	apply(mutation: TaskBoardMutation): TaskBoardMutationResult;
	/** Link an in-flight dispatch run to the board; a no-op without a board. */
	attachRun(runId: string): void;
	/** Unlink a finished dispatch run; a no-op when it was never attached. */
	detachRun(runId: string): void;
	/**
	 * Force the next read to refold from the ledger even if `getSessionId()`
	 * reports the same id it did last time. A `/tree` switch moves the active
	 * append point without changing which session is open, so the id-keyed
	 * cache alone never noticed the branch change and kept showing the
	 * abandoned branch's board (issue #94). Callers invalidate on the bus
	 * signal that switch emits.
	 */
	invalidate(): void;
}

function isOpenUserTask(task: TaskBoardTask): boolean {
	return task.origin === "user" && (task.status === "pending" || task.status === "active");
}

export function taskBoardCounts(board: Pick<TaskBoardSnapshot, "tasks">): TaskBoardCounts {
	const counts: TaskBoardCounts = {
		total: board.tasks.length,
		completed: 0,
		active: 0,
		pending: 0,
		blocked: 0,
		cancelled: 0,
		open: 0,
	};
	for (const task of board.tasks) {
		if (task.status === "completed") counts.completed += 1;
		else if (task.status === "active") counts.active += 1;
		else if (task.status === "pending") counts.pending += 1;
		else if (task.status === "blocked") counts.blocked += 1;
		else counts.cancelled += 1;
	}
	counts.open = counts.pending + counts.active;
	return counts;
}

/** Board status for the ledger's top-level goal, derived from its tasks. */
function boardStatus(tasks: ReadonlyArray<TaskBoardTask>): TaskLedgerStatus {
	const counts = taskBoardCounts({ tasks });
	if (counts.total === 0) return "pending";
	if (counts.active > 0) return "active";
	if (counts.open === 0 && counts.blocked === 0) return "completed";
	if (counts.blocked > 0 && counts.open === 0) return "blocked";
	return "pending";
}

export function toTaskLedgerEntryFields(board: TaskBoardSnapshot, now: Date): TaskLedgerEntryFields {
	const evidence: TaskLedgerValidationEvidence[] = [];
	const subgoals: TaskLedgerGoal[] = board.tasks.map((task) => {
		if (task.status === "completed" && task.evidence) {
			evidence.push({
				id: `${task.id}.evidence`,
				description: task.evidence,
				status: "passed",
				observedAt: now.toISOString(),
			});
		}
		const goal: TaskLedgerGoal = {
			id: task.id,
			title: task.title,
			status: task.status,
			parentGoalId: TASK_BOARD_GOAL_ID,
		};
		if (task.origin) goal.origin = task.origin;
		if (task.userTaskId) goal.userTaskId = task.userTaskId;
		if (task.reason) goal.description = task.reason;
		return goal;
	});
	return {
		kind: "taskLedger",
		parentTurnId: null,
		boardId: board.boardId,
		goals: [{ id: TASK_BOARD_GOAL_ID, title: board.title, status: boardStatus(board.tasks) }],
		subgoals,
		activeRunIds: [...board.activeRunIds],
		requiredValidationEvidence: evidence,
	};
}

function isTaskLedgerShaped(value: unknown): value is {
	kind: "taskLedger";
	boardId?: string;
	timestamp?: string;
	goals: TaskLedgerGoal[];
	subgoals: TaskLedgerGoal[];
	requiredValidationEvidence: TaskLedgerValidationEvidence[];
} {
	return isSessionEntry(value) && value.kind === "taskLedger";
}

/**
 * Fold a session's entries back into a board. Each taskLedger entry is a full
 * snapshot, so the last one wins; earlier entries are history, not deltas.
 */
export function foldTaskBoard(entries: ReadonlyArray<unknown>): TaskBoardSnapshot | null {
	let last: ReturnType<typeof toEntryView> = null;
	for (const raw of entries) {
		if (isTaskLedgerShaped(raw)) last = toEntryView(raw);
	}
	return last;
}

/**
 * Fold every safely identifiable board generation in a session. New ledgers
 * key generations by boardId; pre-boardId ledgers collapse to the newest
 * legacy snapshot because reusable tN ids cannot safely distinguish their
 * older plan generations.
 */
export function foldSessionTaskHistory(entries: ReadonlyArray<unknown>): SessionTaskHistoryBoard[] {
	type MutableHistoryBoard = {
		boardId: string;
		title: string;
		tasks: Map<string, TaskBoardTask>;
		lastSnapshotAt: string;
		lastIndex: number;
	};
	const boards = new Map<string, MutableHistoryBoard>();
	for (const [index, raw] of entries.entries()) {
		if (!isTaskLedgerShaped(raw)) continue;
		const view = toEntryView(raw);
		if (!view) continue;
		const boardId = typeof raw.boardId === "string" && raw.boardId.length > 0 ? raw.boardId : LEGACY_TASK_BOARD_ID;
		const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
		if (boardId === LEGACY_TASK_BOARD_ID) {
			boards.set(boardId, {
				boardId,
				title: view.title,
				tasks: new Map(view.tasks.map((task) => [task.id, task])),
				lastSnapshotAt: timestamp,
				lastIndex: index,
			});
			continue;
		}
		const existing = boards.get(boardId);
		if (!existing) {
			boards.set(boardId, {
				boardId,
				title: view.title,
				tasks: new Map(view.tasks.map((task) => [task.id, task])),
				lastSnapshotAt: timestamp,
				lastIndex: index,
			});
			continue;
		}
		existing.title = view.title;
		for (const task of view.tasks) existing.tasks.set(task.id, task);
		existing.lastSnapshotAt = timestamp;
		existing.lastIndex = index;
	}
	return [...boards.values()]
		.sort((left, right) => right.lastIndex - left.lastIndex)
		.map(({ lastIndex: _lastIndex, tasks, ...board }) => ({ ...board, tasks: [...tasks.values()] }));
}

function toEntryView(entry: {
	boardId?: string;
	goals: TaskLedgerGoal[];
	subgoals: TaskLedgerGoal[];
	requiredValidationEvidence: TaskLedgerValidationEvidence[];
}): TaskBoardSnapshot | null {
	const boardGoal = entry.goals[0];
	if (!boardGoal) return null;
	const evidenceByTask = new Map<string, string>();
	for (const item of entry.requiredValidationEvidence) {
		const taskId = item.id.endsWith(".evidence") ? item.id.slice(0, -".evidence".length) : item.id;
		evidenceByTask.set(taskId, item.description);
	}
	return {
		boardId: entry.boardId ?? LEGACY_TASK_BOARD_ID,
		title: boardGoal.title,
		tasks: entry.subgoals.map((goal) => {
			const task: TaskBoardTask = {
				id: goal.id,
				title: goal.title,
				status: goal.status,
				origin: goal.origin ?? "agent",
			};
			if (goal.userTaskId) task.userTaskId = goal.userTaskId;
			if (goal.description) task.reason = goal.description;
			const evidence = evidenceByTask.get(goal.id);
			if (evidence) task.evidence = evidence;
			return task;
		}),
		// Run linkage is process-live: the runs recorded in old entries ended
		// with the process that dispatched them, so a refold starts empty and
		// the historical linkage stays readable in the earlier entries.
		activeRunIds: [],
	};
}

function nextTaskId(tasks: ReadonlyArray<TaskBoardTask>): number {
	let max = 0;
	for (const task of tasks) {
		const match = /^t(\d+)$/.exec(task.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

function normalizeTitles(titles: ReadonlyArray<string>): string[] {
	return titles.map((title) => title.trim()).filter((title) => title.length > 0);
}

function applyMutation(
	board: TaskBoardSnapshot | null,
	mutation: TaskBoardMutation,
): { board: TaskBoardSnapshot; notes: string[] } | { error: string } {
	if (mutation.op === "plan") {
		const titles = normalizeTitles(mutation.tasks);
		if (mutation.title.trim().length === 0) return { error: "plan requires a non-empty title" };
		if (titles.length === 0) return { error: "plan requires at least one task" };
		const retained = board?.tasks.filter(isOpenUserTask) ?? [];
		const notes: string[] = [];
		const replacedOpen = board ? taskBoardCounts(board).open - retained.length : 0;
		if (board && replacedOpen > 0) {
			notes.push(`replaced board "${board.title}" with ${replacedOpen} agent task(s) still open`);
		}
		if (retained.length > 0) notes.push(`preserved ${retained.length} open operator task(s)`);
		const start = nextTaskId(retained);
		return {
			board: {
				boardId: "",
				title: mutation.title.trim(),
				tasks: [
					...retained,
					...titles.map((title, index) => ({
						id: `t${start + index}`,
						title,
						status: "pending" as const,
						origin: "agent" as const,
					})),
				],
				// Runs in flight outlive a board swap: they belong to the session,
				// so the fresh board inherits the linkage until the runs finish.
				activeRunIds: board?.activeRunIds ?? [],
			},
			notes,
		};
	}
	if (mutation.op === "pick") {
		const title = mutation.title.trim();
		if (title.length === 0) return { error: "pick requires a non-empty operator task title" };
		if (!/^u[1-9]\d*$/.test(mutation.userTaskId)) return { error: "pick requires an operator task id like u3" };
		if (
			board?.tasks.some(
				(task) =>
					task.userTaskId === mutation.userTaskId &&
					(task.status === "pending" || task.status === "active" || task.status === "completed"),
			)
		) {
			return { error: `operator task ${mutation.userTaskId} is already linked to durable board work` };
		}
		const tasks = board?.tasks ?? [];
		const picked: TaskBoardTask = {
			id: `t${nextTaskId(tasks)}`,
			title,
			status: "pending",
			origin: "user",
			userTaskId: mutation.userTaskId,
		};
		return {
			board: {
				boardId: board?.boardId ?? "",
				title: board?.title ?? "Operator tasks",
				tasks: [...tasks, picked],
				activeRunIds: board?.activeRunIds ?? [],
			},
			notes: [],
		};
	}
	if (board === null) return { error: 'no task board yet; declare one with action="plan" first' };
	if (mutation.op === "add") {
		const titles = normalizeTitles(mutation.tasks);
		if (titles.length === 0) return { error: "add requires at least one task" };
		const start = nextTaskId(board.tasks);
		const added = titles.map((title, index) => ({
			id: `t${start + index}`,
			title,
			status: "pending" as const,
			origin: "agent" as const,
		}));
		return { board: { ...board, tasks: [...board.tasks, ...added] }, notes: [] };
	}
	const target = board.tasks.find((task) => task.id === mutation.id);
	if (!target) return { error: `task ${mutation.id} not found on the board` };
	if (mutation.op === "block" && mutation.reason.trim().length === 0) {
		return { error: "block requires a reason so the ledger records why work stopped" };
	}
	// Completion is the ledger's only load-bearing claim, so it carries two
	// structural conditions rather than a bare status flip. Evidence is
	// mandatory: a completed row becomes a passed validation record, and a row
	// without evidence would assert a validation that nobody performed. Work
	// that did not happen is closed with block or drop, which record a reason.
	if (mutation.op === "done") {
		if (mutation.evidence.trim().length === 0) {
			return {
				error:
					"done requires note as the evidence that the task actually finished (the command you ran, the file:line you verified). If the work did not happen, use block with a reason or drop it.",
			};
		}
	}
	const notes: string[] = [];
	// A model that did the work without announcing it on the board closes
	// several tasks in a row at the end of the turn. Refusing done on a pending
	// task cost a live session six start/done pairs of pure ceremony; the
	// evidence note is the load-bearing claim, so the start is recorded
	// implicitly and named in the notes.
	if (mutation.op === "done" && target.status === "pending") {
		notes.push(`started ${target.id} implicitly: done on a pending task records the start and the completion together`);
	}
	const tasks = board.tasks.map((task): TaskBoardTask => {
		if (task.id !== target.id) {
			// One active task at a time: starting a task parks any other active
			// task back to pending so the board always names the current focus.
			if (mutation.op === "start" && task.status === "active") {
				notes.push(`parked ${task.id} back to pending (one task active at a time)`);
				return { ...task, status: "pending" };
			}
			return task;
		}
		return applyStatusMutation(task, mutation);
	});
	return { board: { ...board, tasks }, notes };
}

function applyStatusMutation(
	task: TaskBoardTask,
	mutation: Extract<TaskBoardMutation, { op: "start" | "done" | "block" | "drop" }>,
): TaskBoardTask {
	switch (mutation.op) {
		case "start":
			return { ...task, status: "active" };
		case "done": {
			const done: TaskBoardTask = { ...task, status: "completed", evidence: mutation.evidence.trim() };
			delete done.reason;
			return done;
		}
		case "block":
			return { ...task, status: "blocked", reason: mutation.reason.trim() };
		case "drop": {
			const dropped: TaskBoardTask = { ...task, status: "cancelled" };
			if (mutation.reason?.trim()) dropped.reason = mutation.reason.trim();
			return dropped;
		}
	}
}

export function createTaskBoardStore(deps: TaskBoardStoreDeps = {}): TaskBoardStore {
	let cachedSessionId: string | null | undefined;
	let dirty = true;
	let board: TaskBoardSnapshot | null = null;

	const syncToSession = (): void => {
		const sessionId = deps.getSessionId?.() ?? null;
		if (!dirty && cachedSessionId === sessionId) return;
		dirty = false;
		cachedSessionId = sessionId;
		try {
			board = deps.readEntries ? foldTaskBoard(deps.readEntries()) : null;
		} catch {
			board = null;
		}
	};

	const persist = (next: TaskBoardSnapshot): void => {
		try {
			deps.appendEntry?.(toTaskLedgerEntryFields(next, deps.now?.() ?? new Date()));
		} catch {
			// Persistence is best-effort: the live board still drives the UI
			// and the model; a failed ledger write only costs replay fidelity.
		}
	};

	const mutationRequiresAcknowledgement = (current: TaskBoardSnapshot | null, mutation: TaskBoardMutation): boolean => {
		if (mutation.op === "pick") return true;
		if (mutation.op === "plan") return current?.tasks.some(isOpenUserTask) ?? false;
		if (mutation.op !== "done") return false;
		return current?.tasks.some((task) => task.id === mutation.id && task.origin === "user") ?? false;
	};

	return {
		snapshot(): TaskBoardSnapshot | null {
			syncToSession();
			return board;
		},
		cachedSnapshot(): TaskBoardSnapshot | null {
			const sessionId = deps.getSessionId?.() ?? null;
			return !dirty && cachedSessionId === sessionId ? board : null;
		},
		historySnapshot(): ReadonlyArray<SessionTaskHistoryBoard> {
			syncToSession();
			try {
				return deps.readEntries ? foldSessionTaskHistory(deps.readEntries()) : [];
			} catch {
				return [];
			}
		},
		apply(mutation: TaskBoardMutation): TaskBoardMutationResult {
			syncToSession();
			const result = applyMutation(board, mutation);
			if ("error" in result) return { ok: false, message: result.error };
			const needsBoardId = mutation.op === "plan" || result.board.boardId.length === 0;
			const nextBoard = needsBoardId ? { ...result.board, boardId: deps.createBoardId?.() ?? randomUUID() } : result.board;
			if (mutationRequiresAcknowledgement(board, mutation)) {
				if (!deps.appendEntry) {
					return { ok: false, message: "durable task-ledger persistence is unavailable for operator-linked work" };
				}
				try {
					deps.appendEntry(toTaskLedgerEntryFields(nextBoard, deps.now?.() ?? new Date()));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { ok: false, message: `could not persist operator-linked task board: ${message}` };
				}
				board = nextBoard;
				return { ok: true, board: nextBoard, notes: result.notes };
			}
			board = nextBoard;
			persist(nextBoard);
			return { ok: true, board: nextBoard, notes: result.notes };
		},
		attachRun(runId: string): void {
			syncToSession();
			// A run can only link to a live board; without one, nothing tracks it.
			if (board === null || runId.length === 0 || board.activeRunIds.includes(runId)) return;
			board = { ...board, activeRunIds: [...board.activeRunIds, runId] };
			persist(board);
		},
		detachRun(runId: string): void {
			syncToSession();
			if (board === null || !board.activeRunIds.includes(runId)) return;
			board = { ...board, activeRunIds: board.activeRunIds.filter((id) => id !== runId) };
			persist(board);
		},
		invalidate(): void {
			dirty = true;
		},
	};
}
