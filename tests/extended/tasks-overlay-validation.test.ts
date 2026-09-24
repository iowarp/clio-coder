import { match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import { formatCompositeTasksOverlayBodyLines } from "../../src/interactive/tasks-overlay.js";

test("tasks overlay visibly qualifies completed work with failed or missing checks, including history", () => {
	const board: TaskBoardSnapshot = {
		boardId: "b1",
		title: "Headless API",
		activeRunIds: [],
		tasks: [
			{
				id: "t1",
				title: "Implement headless API",
				status: "completed",
				evidence: "Implementation delivered; rerun pending",
				requiredValidationEvidence: [
					{ id: "c1", description: "headless", status: "failed", observedAt: "2026-09-24T00:00:00Z" },
					{ id: "c2", description: "full suite", status: "missing" },
				],
			},
		],
	};
	const lines = formatCompositeTasksOverlayBodyLines({ board, history: [], artifacts: [], userTasks: [] });
	const text = lines.join("\n");
	match(text, /1\/1 done/);
	match(text, /1 unverified/);
	match(text, /headless failed/);
	match(text, /full suite has no recorded pass/);
	match(text, /completion claim/);
	const historyLines = formatCompositeTasksOverlayBodyLines({
		board: null,
		history: [{ boardId: "old", title: board.title, tasks: board.tasks, lastSnapshotAt: "2026-09-24T00:00:00Z" }],
		artifacts: [],
		userTasks: [],
	});
	match(historyLines.join("\n"), /headless failed/);
	strictEqual(
		historyLines.some((line) => line.includes("unverified")),
		true,
	);
});
