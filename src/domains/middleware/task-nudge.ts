import { ToolNames } from "../../core/tool-names.js";
import { type TaskBoardSnapshot, type TaskBoardTask, taskBoardCounts } from "../session/task-board.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * Open-tasks nudge, packaged as a turn_end hook registration.
 *
 * When a settled work turn (one that called tools) ends while the session
 * task board still has pending or active tasks, the turn is carried onward
 * with a `request_continuation` plus a paired reminder listing the open
 * tasks. The chat-loop's one-nudge-per-turn guard bounds it: a model that
 * stalls again after the nudge is handed back to the operator, never looped.
 *
 * Deliberate non-triggers: pure conversation turns (no tool calls — the
 * operator is discussing, not delegating), aborted or errored turns, and
 * boards where every remaining task is blocked (blocked is an honest recorded
 * state that waits for the operator, not a stall).
 */

export const TASK_NUDGE_REGISTRATION_ID = "nudge.open-tasks";

export interface CreateTaskNudgeRegistrationOptions {
	/** Live board snapshot, or null when no board has been declared. */
	getBoard: () => TaskBoardSnapshot | null;
}

function openTasks(board: TaskBoardSnapshot): TaskBoardTask[] {
	return board.tasks.filter((task) => task.status === "pending" || task.status === "active");
}

export function buildOpenTasksMessage(board: TaskBoardSnapshot): string {
	const open = openTasks(board);
	const counts = taskBoardCounts(board);
	const rows = open.map((task) => `  ${task.status === "active" ? "[>]" : "[ ]"} ${task.id} ${task.title}`);
	return (
		`[Clio Coder] task board "${board.title}" still has ${open.length} of ${counts.total} task(s) open:\n` +
		`${rows.join("\n")}\n` +
		`Continue working them, or record the honest state on the board: ` +
		`tasks action="done" with an evidence note, action="block" with a reason, or action="drop". ` +
		`Do not end the turn with a stale board.`
	);
}

export function createTaskNudgeRegistration(options: CreateTaskNudgeRegistrationOptions): MiddlewareHookRegistration {
	return {
		id: TASK_NUDGE_REGISTRATION_ID,
		description: "carry the turn onward when a work turn ends with open task-board tasks",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			const turnToolCalls = input.metadata?.turnToolCalls;
			if (typeof turnToolCalls !== "number" || turnToolCalls <= 0) return [];
			// A surface without the tasks tool can never update the board, so
			// nudging it would loop against a wall.
			const activeToolNames = input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Tasks)) return [];
			let board: TaskBoardSnapshot | null;
			try {
				board = options.getBoard();
			} catch {
				return [];
			}
			if (board === null || openTasks(board).length === 0) return [];
			const message = buildOpenTasksMessage(board);
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
