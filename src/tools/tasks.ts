import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import {
	type TaskBoardMutation,
	type TaskBoardSnapshot,
	type TaskBoardStore,
	type TaskBoardTask,
	taskBoardCounts,
} from "../domains/session/task-board.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";

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

const TASKS_ACTIONS = ["plan", "add", "start", "done", "block", "drop", "list"] as const;
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
}

export function renderTaskBoardText(board: TaskBoardSnapshot): string {
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
	return lines.join("\n");
}

function boardDetails(action: TasksAction, board: TaskBoardSnapshot | null): Record<string, unknown> {
	if (!board) return { action };
	const counts = taskBoardCounts(board);
	return {
		action,
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
	return {
		name: ToolNames.Tasks,
		description:
			"Session task board. plan declares a titled board (replaces any prior board); add appends tasks; " +
			"start marks one task active (the current focus); done completes a started task and requires note as the " +
			"evidence the work actually finished; block parks it with a required reason; drop cancels it; list shows the board. " +
			"Work that did not happen is blocked or dropped, never done.",
		parameters: Type.Object({
			action: stringEnum(TASKS_ACTIONS, "Board action."),
			title: Type.Optional(Type.String({ description: "Board title (plan)." })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: "Task titles (plan, add)." })),
			id: Type.Optional(Type.String({ description: 'Task id like "t2" (start, done, block, drop).' })),
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
			if (typeof prepared.id === "number" && Number.isFinite(prepared.id)) prepared.id = `t${prepared.id}`;
			if (typeof prepared.id === "string" && /^\d+$/.test(prepared.id.trim())) prepared.id = `t${prepared.id.trim()}`;
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
			if (typedAction === "list") {
				const board = deps.board.snapshot();
				if (!board) {
					return {
						kind: "ok",
						output: 'no task board yet; declare one with action="plan"',
						details: boardDetails("list", null),
					};
				}
				return { kind: "ok", output: renderTaskBoardText(board), details: boardDetails("list", board) };
			}
			const mutation = mutationFromArgs(typedAction, args);
			if ("error" in mutation) return { kind: "error", message: mutation.error };
			const result = deps.board.apply(mutation);
			if (!result.ok) return { kind: "error", message: `tasks: ${result.message}` };
			const noteLines = result.notes.map((note) => `note: ${note}`);
			const output = [...noteLines, renderTaskBoardText(result.board)].join("\n");
			return { kind: "ok", output, details: boardDetails(typedAction, result.board) };
		},
	};
}
