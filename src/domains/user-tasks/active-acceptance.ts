import { isSessionEntry } from "../session/entries.js";
import type { TaskBoardSnapshot } from "../session/task-board.js";
import type { UserTaskAcceptance } from "./acceptance.js";
import type { UserTask } from "./store.js";

/** Keep a task's acceptance through the turn that finishes or blocks its board row. */
export function activeUserTaskAcceptance(
	tasks: ReadonlyArray<UserTask>,
	board: TaskBoardSnapshot | null,
	sessionId: string | null,
	window: ReadonlyArray<unknown>,
): UserTaskAcceptance | undefined {
	if (!board || !sessionId) return undefined;
	const touched = new Set<string>();
	for (const entry of window) {
		if (!isSessionEntry(entry) || entry.kind !== "message" || entry.role !== "tool_call") continue;
		if (!entry.payload || typeof entry.payload !== "object") continue;
		const payload = entry.payload as { name?: string; toolName?: string; args?: { action?: string; id?: string } };
		if (
			(payload.name ?? payload.toolName) === "tasks" &&
			payload.args?.id &&
			["done", "block", "drop"].includes(payload.args.action ?? "")
		)
			touched.add(payload.args.id);
	}
	const linked = new Set(
		board.tasks
			.filter((task) => task.status === "pending" || task.status === "active" || touched.has(task.id))
			.map((task) => task.userTaskId),
	);
	const acceptance = tasks
		.filter((task) => task.handedSessionId === sessionId && linked.has(task.id))
		.flatMap((task) => (task.acceptance ? [task.acceptance] : []));
	return acceptance.length > 0
		? {
				expectedOutputs: [...new Set(acceptance.flatMap((item) => item.expectedOutputs))],
				verification: acceptance.flatMap((item) => item.verification),
			}
		: undefined;
}
