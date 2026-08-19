import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import {
	type TaskBoardMutation,
	type TaskBoardSnapshot,
	type TaskBoardStore,
	type TaskBoardTask,
	taskBoardCounts,
} from "../domains/session/task-board.js";
import type { UserTask, UserTasksStore } from "../domains/user-tasks/store.js";
import { StringEnum } from "../engine/ai.js";
import type { ToolResult, ToolSpec } from "./registry.js";

/**
 * The tasks tool: the session task board. The agent declares what it is
 * about to do (action="plan"), names its current focus ("start"), and closes
 * each task with a receipt ("done" + evidence note) or an honest reason
 * ("block"/"drop"). Every mutation persists a full taskLedger snapshot to the
 * session, so the board is replayable, survives resume, and feeds the footer
 * tasks row, the /tasks overlay, and the turn-end open-tasks nudge.
 *
 * Every action returns the whole rendered board, not just an ack: local
 * models keep the current state in the tool result instead of having to
 * track it across turns.
 */

const TASKS_ACTIONS = ["plan", "add", "pick", "start", "done", "block", "drop", "list"] as const;
type TasksAction = (typeof TASKS_ACTIONS)[number];

/** Plain-text status markers for model-facing output; the TUI owns glyphs. */
const STATUS_MARK: Record<TaskBoardTask["status"], string> = {
	pending: "[ ]",
	active: "[>]",
	completed: "[x]",
	blocked: "[!]",
	cancelled: "[-]",
};

export interface TasksToolDeps {
	board: TaskBoardStore;
	userTasks?: UserTasksStore;
	getSessionId?: () => string | null;
}

function waitingTrailer(tasks: ReadonlyArray<UserTask>): string[] {
	return tasks
		.filter((task) => task.status === "open" || task.status === "handed")
		.map(
			(task) =>
				`operator tasks waiting: ${task.id} ${JSON.stringify(task.title)} — pick up with action="pick" id="${task.id}"`,
		);
}

function renderTaskBoardText(board: TaskBoardSnapshot, userTasks: ReadonlyArray<UserTask> = []): string {
	const counts = taskBoardCounts(board);
	const lines: string[] = [`board "${board.title}" ${counts.completed}/${counts.total} done`];
	for (const task of board.tasks) {
		let line = `${STATUS_MARK[task.status]} ${task.id} ${task.title}`;
		if (task.status === "completed" && task.evidence) line += ` — evidence: ${task.evidence}`;
		if (task.status === "blocked" && task.reason) line += ` — blocked: ${task.reason}`;
		if (task.status === "cancelled" && task.reason) line += ` — dropped: ${task.reason}`;
		lines.push(line);
	}
	if (counts.open > 0 && counts.active === 0) {
		lines.push(`next: start a task with action="start" before working it`);
	}
	lines.push(...waitingTrailer(userTasks));
	return lines.join("\n");
}

function boardDetails(action: TasksAction, board: TaskBoardSnapshot | null): Record<string, unknown> {
	if (!board) return { action };
	const counts = taskBoardCounts(board);
	return {
		action,
		boardId: board.boardId,
		title: board.title,
		counts,
		tasks: board.tasks.map((task) => ({ ...task })),
	};
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function taskTitlesArg(args: Record<string, unknown>): string[] {
	const value = args.tasks;
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string" && value.trim().length > 0) return [value];
	return [];
}

function mutationFromArgs(action: TasksAction, args: Record<string, unknown>): TaskBoardMutation | { error: string } {
	switch (action) {
		case "plan": {
			const title = stringArg(args, "title");
			if (!title) return { error: 'tasks: plan requires title (the board name), e.g. title="Fix the flaky test"' };
			return { op: "plan", title, tasks: taskTitlesArg(args) };
		}
		case "add":
			return { op: "add", tasks: taskTitlesArg(args) };
		case "pick":
			return { error: "pick is resolved from the durable operator task inbox" };
		case "start":
		case "done":
		case "block":
		case "drop": {
			const id = stringArg(args, "id");
			if (!id) return { error: `tasks: ${action} requires id (e.g. id="t2")` };
			const note = stringArg(args, "note");
			if (action === "start") return { op: "start", id };
			if (action === "done") return { op: "done", id, evidence: note ?? "" };
			if (action === "block") return { op: "block", id, reason: note ?? "" };
			return note ? { op: "drop", id, reason: note } : { op: "drop", id };
		}
		case "list":
			return { error: "unreachable" };
	}
}

export function createTasksTool(deps: TasksToolDeps): ToolSpec {
	const reconcileUserTasks = (): ReadonlyArray<UserTask> => {
		if (!deps.userTasks) return [];
		const sessionId = deps.getSessionId?.();
		if (!sessionId) return deps.userTasks.snapshot();
		const links =
			deps.board
				.snapshot()
				?.tasks.flatMap((task) =>
					task.userTaskId ? [{ userTaskId: task.userTaskId, boardTaskId: task.id, status: task.status }] : [],
				) ?? [];
		return deps.userTasks.reconcile(links, sessionId);
	};

	return {
		name: ToolNames.Tasks,
		description:
			"Session task board. plan declares a titled board (replaces any prior board); add appends tasks; " +
			"pick moves one operator task uN onto the board; start marks one task active (the current focus); " +
			"done completes a started task and requires note as the " +
			"evidence the work actually finished; block parks it with a required reason; drop cancels it; list shows the board. " +
			"Work that did not happen is blocked or dropped, never done.",
		parameters: Type.Object({
			action: StringEnum(TASKS_ACTIONS, { description: "Board action." }),
			title: Type.Optional(Type.String({ description: "Board title (plan)." })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "Task titles (plan, add)." })),
			id: Type.Optional(Type.String({ description: 'Task id like "t2", or operator id "u2" for pick.' })),
			note: Type.Optional(
				Type.String({ description: "Evidence of completion (required for done) or the reason (block, drop)." }),
			),
		}),
		baseActionClass: "read",
		executionMode: "sequential",
		prepareArguments(args) {
			const prepared = { ...args };
			// Weak-model shapes: a numeric or bare-number id becomes "tN", and a
			// JSON-string tasks array is parsed back into a real array.
			const idPrefix = prepared.action === "pick" ? "u" : "t";
			if (typeof prepared.id === "number" && Number.isFinite(prepared.id)) prepared.id = `${idPrefix}${prepared.id}`;
			if (typeof prepared.id === "string" && /^\d+$/.test(prepared.id.trim())) {
				prepared.id = `${idPrefix}${prepared.id.trim()}`;
			}
			if (typeof prepared.tasks === "string" && prepared.tasks.trim().startsWith("[")) {
				try {
					const parsed = JSON.parse(prepared.tasks);
					if (Array.isArray(parsed)) prepared.tasks = parsed;
				} catch {
					// leave the raw string; taskTitlesArg treats it as one title
				}
			}
			return prepared;
		},
		async run(args): Promise<ToolResult> {
			const action = typeof args.action === "string" ? args.action : "";
			if (!(TASKS_ACTIONS as ReadonlyArray<string>).includes(action)) {
				return { kind: "error", message: `tasks: action must be one of ${TASKS_ACTIONS.join(", ")}; got '${action}'` };
			}
			const typedAction = action as TasksAction;
			let userTasks: ReadonlyArray<UserTask>;
			try {
				userTasks = reconcileUserTasks();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { kind: "error", message: `tasks: could not reconcile the operator task inbox: ${message}` };
			}
			if (typedAction === "list") {
				const board = deps.board.snapshot();
				if (!board) {
					const output = ['no task board yet; declare one with action="plan"', ...waitingTrailer(userTasks)].join("\n");
					return {
						kind: "ok",
						output,
						details: boardDetails("list", null),
					};
				}
				return { kind: "ok", output: renderTaskBoardText(board, userTasks), details: boardDetails("list", board) };
			}
			if (typedAction === "pick") {
				if (!deps.userTasks) return { kind: "error", message: "tasks: operator task inbox is unavailable" };
				const sessionId = deps.getSessionId?.();
				if (!sessionId) return { kind: "error", message: "tasks: pick requires an active session" };
				const id = stringArg(args, "id");
				if (!id || !/^u[1-9]\d*$/.test(id)) {
					return { kind: "error", message: 'tasks: pick requires an operator task id (e.g. id="u3")' };
				}
				const userTask = userTasks.find((task) => task.id === id);
				if (!userTask) return { kind: "error", message: `tasks: operator task ${id} was not found` };
				if (userTask.status !== "open" && userTask.status !== "handed") {
					return { kind: "error", message: `tasks: operator task ${id} is ${userTask.status}; it cannot be picked` };
				}
				const result = deps.board.apply({ op: "pick", title: userTask.title, userTaskId: userTask.id });
				if (!result.ok) return { kind: "error", message: `tasks: ${result.message}` };
				const picked = result.board.tasks.find((task) => task.userTaskId === userTask.id && task.status === "pending");
				if (!picked) return { kind: "error", message: `tasks: durable pickup for ${id} did not produce a board row` };
				try {
					deps.userTasks.recordPicked(userTask.id, sessionId, picked.id);
					userTasks = deps.userTasks.snapshot();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						kind: "error",
						message: `tasks: ${picked.id} durably picked up ${id}, but the operator inbox update failed: ${message}`,
						details: boardDetails("pick", result.board),
					};
				}
				return {
					kind: "ok",
					output: renderTaskBoardText(result.board, userTasks),
					details: boardDetails("pick", result.board),
				};
			}
			const before = deps.board.snapshot();
			const mutation = mutationFromArgs(typedAction, args);
			if ("error" in mutation) return { kind: "error", message: mutation.error };
			const completedUserTask =
				typedAction === "done" && mutation.op === "done"
					? before?.tasks.find((task) => task.id === mutation.id && task.userTaskId)
					: undefined;
			const completionSessionId = completedUserTask?.userTaskId && deps.userTasks ? deps.getSessionId?.() : undefined;
			if (completedUserTask?.userTaskId && deps.userTasks && !completionSessionId) {
				return { kind: "error", message: "tasks: durable completion requires an active session" };
			}
			const result = deps.board.apply(mutation);
			if (!result.ok) return { kind: "error", message: `tasks: ${result.message}` };
			if (completedUserTask?.userTaskId && deps.userTasks && completionSessionId) {
				try {
					deps.userTasks.recordDone(completedUserTask.userTaskId, completionSessionId, completedUserTask.id);
					userTasks = deps.userTasks.snapshot();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						kind: "error",
						message: `tasks: ${completedUserTask.id} completed durably, but operator task ${completedUserTask.userTaskId} could not be updated: ${message}`,
						details: boardDetails("done", result.board),
					};
				}
			}
			const noteLines = result.notes.map((note) => `note: ${note}`);
			const output = [...noteLines, renderTaskBoardText(result.board, userTasks)].join("\n");
			return { kind: "ok", output, details: boardDetails(typedAction, result.board) };
		},
	};
}
