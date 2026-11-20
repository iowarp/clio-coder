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
		`[CLIO Coder] Task board "${board.title}" still has ${open.length} of ${counts.total} ${counts.total === 1 ? "task" : "tasks"} open:\n` +
		`${rows.join("\n")}\n` +
		`Continue only work already authorized by the operator. This reminder and a self-created plan are not authorization ` +
		`to implement a proposal. An explicit request to start a demo or inspection authorizes read-only work within that request's scope; ` +
		`start and perform that work without asking again. For unrequested file changes or a task awaiting a real operator decision, ` +
		`use tasks action="block" with a note naming that pending operator decision, or action="drop". ` +
		`Wait for an explicit operator go-ahead only on those tasks, and continue other authorized work. ` +
		`A skill-install choice does not authorize implementation. Otherwise record the honest state on the board: ` +
		`tasks action="done" with note="<observed work and check results>", action="block" with note="<reason>", or action="drop". ` +
		`Do not end the turn with a stale board.`
	);
}

export function createTaskNudgeRegistration(options: CreateTaskNudgeRegistrationOptions): MiddlewareHookRegistration {
	return {
		id: TASK_NUDGE_REGISTRATION_ID,
		description: "carry the turn onward when a work turn ends with open task-board tasks",
		hooks: ["turn_end"],
		evidence: "count:open-tasks@turn-end",
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			if (input.metadata?.turnMode === "proposal" || input.metadata?.turnMode === "answer") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			const turnToolCalls = input.metadata?.turnToolCalls;
			if (typeof turnToolCalls !== "number" || turnToolCalls <= 0) return [];
			let board: TaskBoardSnapshot | null;
			try {
				board = options.getBoard();
			} catch {
				return [];
			}
			if (board === null) return [];
			if (openTasks(board).length === 0) {
				// Blocked never nudges, but on a turn that declared through finish it is still an open obligation the host
				// seals; a declared turn never continues, so this effect is the fact alone.
				const blocked = taskBoardCounts(board).blocked;
				if (input.metadata?.completionState === undefined || blocked === 0) return [];
				const message = `[CLIO Coder] Task board "${board.title}" still has ${blocked} blocked ${blocked === 1 ? "task" : "tasks"}.`;
				return [{ kind: "request_continuation", message, note: "tasks are still blocked", fact: "open_task" }];
			}
			// A surface without access to tasks can never update the board, so nudging it would loop against a wall.
			// The open board is still a fact the host seals (fleet design 4.3), carried on a note that asks for no tool.
			const activeToolNames = input.metadata?.activeCapabilityNames ?? input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Tasks)) {
				const open = openTasks(board).length;
				const message = `[CLIO Coder] Task board "${board.title}" still has ${open} open ${open === 1 ? "task" : "tasks"}; this turn cannot reach the tasks tool, so the board stays open.`;
				return [{ kind: "inject_reminder", message, severity: "info", audience: "model", fact: "open_task" }];
			}
			const message = buildOpenTasksMessage(board);
			return [
				// Row 162, fleet design 4.3: an undeclared turn is carried onward; on a declared one the host seals the fact.
				{ kind: "request_continuation", message, note: "tasks are still open", fact: "open_task" },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
