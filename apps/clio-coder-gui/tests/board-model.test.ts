import assert from "node:assert/strict";
import { test } from "node:test";
import { boardView, memoryLine } from "../client/chat/board-model.js";
import type { SessionBoard } from "../contracts/board.js";

const board: SessionBoard = {
	version: 1,
	operatorTasks: [
		{ id: "u1", title: "Write the report", status: "open", expectedOutputs: ["report.md"], verificationChecks: 2 },
		{ id: "u2", title: "Old idea", status: "dropped", expectedOutputs: [], verificationChecks: 0 },
		{ id: "u3", title: "Ship it", status: "picked", expectedOutputs: [], verificationChecks: 0 },
	],
	plan: {
		title: "Refactor the loader",
		tasks: [
			{ id: "1", title: "Read the loader", status: "completed", origin: "agent", reason: null },
			{ id: "2", title: "Split the parser", status: "blocked", origin: "user", reason: "waiting on review" },
			{ id: "3", title: "Mystery", status: "paused", origin: "agent", reason: null },
		],
	},
	decisions: [
		{
			ref: "i1/db",
			key: "db",
			label: "Database",
			value: "sqlite",
			status: "active",
			source: "operator",
			decidedAt: "2026-09-26T00:00:00Z",
			rationale: null,
			correction: null,
		},
		{
			ref: "agent:1/cache",
			key: "cache",
			label: null,
			value: "none",
			status: "superseded",
			source: "agent",
			decidedAt: "2026-09-26T00:00:00Z",
			rationale: "simpler",
			correction: "use redis",
		},
	],
	memory: { enabled: true, tier: "llm", entries: 1, stepInFlight: true },
	truncated: false,
};

test("operator tasks carry exactly the actions their state admits", () => {
	const view = boardView(board);
	assert.deepEqual(
		view.tasks.map((task) => [task.id, task.word, task.actions, task.acceptance]),
		[
			["u1", "Open", ["hand", "done", "drop"], "expects report.md · 2 declared checks"],
			["u2", "Dropped", [], ""],
			["u3", "In Clio Coder's plan", ["done", "drop"], ""],
		],
	);
});

test("the plan reads as Clio Coder's report and an unknown state stays unverified", () => {
	const rows = boardView(board).plan?.rows ?? [];
	assert.deepEqual(
		rows.map((row) => [row.word, row.tone, row.reason]),
		[
			["Completed", "success", null],
			["Blocked", "warn", "waiting on review"],
			["paused", "unverified", null],
		],
	);
	assert.equal(boardView({ ...board, plan: null }).plan, null);
});

test("decisions split into active and earlier, with who decided and why", () => {
	const view = boardView(board);
	assert.deepEqual(view.activeDecisions, [
		{ ref: "i1/db", name: "Database", value: "sqlite", who: "Your answer", note: null, target: null },
	]);
	assert.deepEqual(view.earlierDecisions, [
		{
			ref: "agent:1/cache",
			name: "cache",
			value: "none",
			who: "Decided by Clio Coder",
			note: "use redis",
			target: null,
		},
	]);
});

test("memory reads as a sentence and a missing report says so", () => {
	assert.equal(memoryLine(board.memory), "Task memory is on, model tier, 1 entry, updating now.");
	assert.equal(memoryLine({ enabled: false, tier: "rules", entries: 0, stepInFlight: false }), "Task memory is off.");
	assert.equal(memoryLine(null), "Task memory is not reported by this session.");
});

test("board writes are worded as what happened, and a proposal always names its review step", async () => {
	const { memoryOutcome, supersedeOutcome } = await import("../client/chat/board-model.js");
	assert.equal(
		memoryOutcome({ status: "proposed", recordId: "memory-1" }).text,
		"Proposed memory-1. Review it, then run clio-coder memory approve memory-1.",
	);
	assert.match(memoryOutcome({ status: "existing", recordId: "memory-1" }).text, /^Already proposed as memory-1\./);
	assert.equal(memoryOutcome({ status: "needs_acknowledgement", reason: "x" }).tone, "warning");
	assert.equal(memoryOutcome({ status: "refused", reason: "no session" }).text, "Not proposed: no session.");
	assert.match(supersedeOutcome({ status: "superseded" }, false).text, /stays in the record/);
	assert.match(
		supersedeOutcome({ status: "superseded", correctionTurn: "x" }, true).text,
		/sent to Clio Coder as a request/,
	);
	assert.match(supersedeOutcome({ status: "already_superseded" }, false).text, /nothing was written/);
});

test("with only superseded decisions the board says none is active, not that none was recorded", async () => {
	const { decisionsEmptyLine } = await import("../client/chat/board-model.js");
	assert.equal(
		decisionsEmptyLine({ activeDecisions: [], earlierDecisions: [] }),
		"No decision has been recorded in this session.",
	);
	assert.equal(
		decisionsEmptyLine({ activeDecisions: [], earlierDecisions: [{} as never] }),
		"No decision is active. The earlier one is below.",
	);
	assert.equal(decisionsEmptyLine({ activeDecisions: [{} as never], earlierDecisions: [] }), null);
});
