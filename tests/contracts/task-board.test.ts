import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createTaskNudgeRegistration, TASK_NUDGE_REGISTRATION_ID } from "../../src/domains/middleware/task-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { isSessionEntry } from "../../src/domains/session/entries.js";
import {
	createTaskBoardStore,
	foldSessionTaskHistory,
	foldTaskBoard,
	LEGACY_TASK_BOARD_ID,
	type TaskBoardSnapshot,
	type TaskBoardStore,
	type TaskLedgerEntryFields,
	taskBoardCounts,
	toTaskLedgerEntryFields,
} from "../../src/domains/session/task-board.js";
import { createTasksTool } from "../../src/tools/tasks.js";

function storeWithLog(): { store: TaskBoardStore; appended: TaskLedgerEntryFields[] } {
	const appended: TaskLedgerEntryFields[] = [];
	let nextBoardId = 1;
	const store = createTaskBoardStore({
		getSessionId: () => "session-1",
		readEntries: () => [],
		appendEntry: (entry) => appended.push(entry),
		createBoardId: () => `board-${nextBoardId++}`,
	});
	return { store, appended };
}

function plannedStore(): { store: TaskBoardStore; appended: TaskLedgerEntryFields[] } {
	const { store, appended } = storeWithLog();
	const result = store.apply({ op: "plan", title: "Ship the feature", tasks: ["design it", "build it", "verify it"] });
	ok(result.ok);
	return { store, appended };
}

function turnEndInput(overrides: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput {
	return {
		hook: "turn_end",
		text: "All done.",
		metadata: {
			stopReason: "stop",
			turnToolCalls: 3,
			activeToolNames: "edit,read,tasks,write",
		},
		...overrides,
	};
}

describe("contracts/task-board store", () => {
	it("plans a board with sequential ids and pending tasks", () => {
		const { store } = storeWithLog();
		const result = store.apply({ op: "plan", title: "Ship it", tasks: ["one", "two"] });
		ok(result.ok);
		deepStrictEqual(
			result.board.tasks.map((task) => [task.id, task.status]),
			[
				["t1", "pending"],
				["t2", "pending"],
			],
		);
		strictEqual(store.snapshot()?.title, "Ship it");
		strictEqual(result.board.boardId, "board-1");
	});

	it("keeps one stable board identity across mutations and mints a new one for plan", () => {
		const { store, appended } = plannedStore();
		strictEqual(store.snapshot()?.boardId, "board-1");
		ok(store.apply({ op: "add", tasks: ["follow-up"] }).ok);
		ok(store.apply({ op: "start", id: "t1" }).ok);
		strictEqual(store.snapshot()?.boardId, "board-1");
		ok(appended.every((entry) => entry.boardId === "board-1"));

		const replanned = store.apply({ op: "plan", title: "Second board", tasks: ["new work"] });
		ok(replanned.ok);
		strictEqual(replanned.board.boardId, "board-2");
		strictEqual(appended.at(-1)?.boardId, "board-2");
	});

	it("keeps exactly one task active and reports the parked one", () => {
		const { store } = plannedStore();
		ok(store.apply({ op: "start", id: "t1" }).ok);
		const second = store.apply({ op: "start", id: "t2" });
		ok(second.ok);
		deepStrictEqual(
			second.board.tasks.map((task) => task.status),
			["pending", "active", "pending"],
		);
		deepStrictEqual(second.notes, ["parked t1 back to pending (one task active at a time)"]);
	});

	it("records completion evidence and block reasons on the board", () => {
		const { store } = plannedStore();
		ok(store.apply({ op: "start", id: "t1" }).ok);
		const done = store.apply({ op: "done", id: "t1", evidence: "npm test green" });
		ok(done.ok);
		strictEqual(done.board.tasks[0]?.evidence, "npm test green");
		const blocked = store.apply({ op: "block", id: "t2", reason: "waiting on operator credentials" });
		ok(blocked.ok);
		strictEqual(blocked.board.tasks[1]?.status, "blocked");
		strictEqual(blocked.board.tasks[1]?.reason, "waiting on operator credentials");
		const counts = taskBoardCounts(blocked.board);
		strictEqual(counts.open, 1);
		strictEqual(counts.blocked, 1);
	});

	it("refuses to complete a task that was never started", () => {
		const { store } = plannedStore();
		const unstarted = store.apply({ op: "done", id: "t1", evidence: "npm test green" });
		ok(!unstarted.ok);
		ok(unstarted.message.includes("never started"));
		// The honest closes for work that did not happen stay available.
		ok(store.apply({ op: "block", id: "t1", reason: "capacity was full" }).ok);
		ok(store.apply({ op: "drop", id: "t2", reason: "superseded" }).ok);
	});

	it("refuses to complete a task without evidence", () => {
		const { store } = plannedStore();
		ok(store.apply({ op: "start", id: "t1" }).ok);
		const bare = store.apply({ op: "done", id: "t1", evidence: "   " });
		ok(!bare.ok);
		ok(bare.message.includes("evidence"));
		strictEqual(store.snapshot()?.tasks[0]?.status, "active");
	});

	it("rejects a block without a reason and mutations against unknown ids", () => {
		const { store } = plannedStore();
		const noReason = store.apply({ op: "block", id: "t1", reason: "  " });
		ok(!noReason.ok);
		const missing = store.apply({ op: "start", id: "t9" });
		ok(!missing.ok);
		ok(missing.message.includes("t9"));
	});

	it("continues task ids across add so a dropped task never frees its id", () => {
		const { store } = plannedStore();
		ok(store.apply({ op: "drop", id: "t3", reason: "superseded" }).ok);
		const added = store.apply({ op: "add", tasks: ["follow-up"] });
		ok(added.ok);
		strictEqual(added.board.tasks[3]?.id, "t4");
	});

	it("persists valid full-snapshot taskLedger entries on every mutation", () => {
		const { store, appended } = plannedStore();
		ok(store.apply({ op: "start", id: "t1" }).ok);
		ok(store.apply({ op: "done", id: "t1", evidence: "verified by hand" }).ok);
		strictEqual(appended.length, 3);
		for (const fields of appended) {
			const entry = { ...fields, turnId: "turn-1", timestamp: new Date().toISOString() };
			ok(isSessionEntry(entry), "persisted taskLedger snapshot must satisfy the session entry guard");
		}
		const last = appended[appended.length - 1];
		ok(last);
		strictEqual(last?.goals[0]?.title, "Ship the feature");
		strictEqual(last?.subgoals[0]?.status, "completed");
		deepStrictEqual(
			last?.requiredValidationEvidence.map((item) => [item.id, item.status, item.description]),
			[["t1.evidence", "passed", "verified by hand"]],
		);
		const envelope = { ...last, turnId: "turn-2", timestamp: new Date().toISOString() };
		ok(isSessionEntry(envelope));
		ok(isSessionEntry({ ...envelope, subgoals: [{ ...envelope.subgoals[0], origin: "user", userTaskId: "u1" }] }));
		ok(!isSessionEntry({ ...envelope, boardId: 7 }));
		ok(!isSessionEntry({ ...envelope, subgoals: [{ ...envelope.subgoals[0], origin: "operator" }] }));
	});

	it("folds the last ledger snapshot back into the identical board", () => {
		const { store, appended } = plannedStore();
		ok(store.apply({ op: "start", id: "t2" }).ok);
		ok(store.apply({ op: "block", id: "t1", reason: "blocked on review" }).ok);
		const live = store.snapshot();
		const entries = appended.map((fields) => ({
			...fields,
			turnId: "turn-1",
			timestamp: "2026-07-03T00:00:00.000Z",
		}));
		deepStrictEqual(foldTaskBoard(entries), live);
	});

	it("retains completed work from prior board generations in session history", () => {
		const { store, appended } = plannedStore();
		ok(store.apply({ op: "start", id: "t1" }).ok);
		ok(store.apply({ op: "done", id: "t1", evidence: "verified" }).ok);
		ok(store.apply({ op: "plan", title: "Follow-up", tasks: ["publish"] }).ok);
		ok(store.apply({ op: "start", id: "t1" }).ok);
		const entries = appended.map((fields, index) => ({
			...fields,
			turnId: `turn-${index}`,
			timestamp: `2026-07-03T00:0${index}:00.000Z`,
		}));

		const history = foldSessionTaskHistory(entries);
		deepStrictEqual(
			history.map((item) => [item.boardId, item.title]),
			[
				["board-2", "Follow-up"],
				["board-1", "Ship the feature"],
			],
		);
		strictEqual(history[0]?.tasks[0]?.status, "active");
		strictEqual(history[1]?.tasks[0]?.status, "completed");
	});

	it("folds old snapshots as one newest legacy board without aliasing generations", () => {
		const first: TaskBoardSnapshot = {
			boardId: "ignored",
			title: "Old plan",
			tasks: [{ id: "t1", title: "old identity", status: "completed", evidence: "done" }],
			activeRunIds: [],
		};
		const second: TaskBoardSnapshot = {
			boardId: "ignored",
			title: "New plan",
			tasks: [{ id: "t1", title: "new identity", status: "pending" }],
			activeRunIds: [],
		};
		const withoutBoardId = (board: TaskBoardSnapshot, timestamp: string): unknown => {
			const { boardId: _boardId, ...fields } = toTaskLedgerEntryFields(board, new Date(timestamp));
			return { ...fields, turnId: timestamp, timestamp };
		};
		const history = foldSessionTaskHistory([
			withoutBoardId(first, "2026-07-03T00:00:00.000Z"),
			withoutBoardId(second, "2026-07-03T00:01:00.000Z"),
		]);
		strictEqual(history.length, 1);
		strictEqual(history[0]?.boardId, LEGACY_TASK_BOARD_ID);
		strictEqual(history[0]?.title, "New plan");
		deepStrictEqual(
			history[0]?.tasks.map((task) => task.title),
			["new identity"],
		);
	});

	it("refolds from the session ledger when the session switches", () => {
		let sessionId = "session-a";
		const boardA: TaskBoardSnapshot = {
			boardId: "board-a",
			title: "Board A",
			tasks: [{ id: "t1", title: "a", status: "pending" }],
			activeRunIds: [],
		};
		const entriesBySession: Record<string, unknown[]> = {
			"session-a": [
				{ ...toTaskLedgerEntryFields(boardA, new Date()), turnId: "turn-1", timestamp: "2026-07-03T00:00:00.000Z" },
			],
			"session-b": [],
		};
		const store = createTaskBoardStore({
			getSessionId: () => sessionId,
			readEntries: () => entriesBySession[sessionId] ?? [],
		});
		deepStrictEqual(store.snapshot(), boardA);
		sessionId = "session-b";
		strictEqual(store.snapshot(), null);
	});

	// issue #94: a /tree switch moves the active append point inside the same
	// session, so getSessionId() alone never noticed the branch changed and the
	// cache kept showing the abandoned branch's board. invalidate() is what the
	// SessionTurnSwitched bus signal calls to force the next read to refold.
	it("does not refold on its own when the session id is unchanged, and does after invalidate()", () => {
		const boardA: TaskBoardSnapshot = {
			boardId: "board-a",
			title: "Board A",
			tasks: [{ id: "t1", title: "a", status: "pending" }],
			activeRunIds: [],
		};
		const boardB: TaskBoardSnapshot = {
			boardId: "board-b",
			title: "Board B (abandoned branch)",
			tasks: [{ id: "t1", title: "b", status: "active" }],
			activeRunIds: [],
		};
		let entries: unknown[] = [
			{ ...toTaskLedgerEntryFields(boardA, new Date()), turnId: "turn-1", timestamp: "2026-07-03T00:00:00.000Z" },
		];
		const store = createTaskBoardStore({
			getSessionId: () => "session-a",
			readEntries: () => entries,
		});
		deepStrictEqual(store.snapshot(), boardA);

		// The ledger now folds to a different board (the /tree switch's filtered
		// active-path read), but the session id is still "session-a".
		entries = [
			{ ...toTaskLedgerEntryFields(boardB, new Date()), turnId: "turn-2", timestamp: "2026-07-03T00:01:00.000Z" },
		];
		deepStrictEqual(store.snapshot(), boardA, "same session id: cache is not stale by that signal alone");

		store.invalidate();
		deepStrictEqual(store.snapshot(), boardB, "invalidate() forces the next read to refold");
	});

	it("links and unlinks dispatch runs through the board's activeRunIds", () => {
		const { store, appended } = plannedStore();
		store.attachRun("run-01H");
		store.attachRun("run-02K");
		store.attachRun("run-01H"); // duplicate is ignored
		deepStrictEqual(store.snapshot()?.activeRunIds, ["run-01H", "run-02K"]);
		// Each real transition persists a full snapshot carrying the linkage.
		const lastAttach = appended[appended.length - 1];
		deepStrictEqual(lastAttach?.activeRunIds, ["run-01H", "run-02K"]);
		store.detachRun("run-01H");
		store.detachRun("never-linked"); // no-op
		deepStrictEqual(store.snapshot()?.activeRunIds, ["run-02K"]);
	});

	it("carries in-flight runs onto a freshly planned board and drops them on refold", () => {
		const { store, appended } = plannedStore();
		store.attachRun("run-77");
		ok(store.apply({ op: "plan", title: "New plan", tasks: ["fresh"] }).ok);
		// A run in flight belongs to the session, so a board swap keeps the linkage.
		deepStrictEqual(store.snapshot()?.activeRunIds, ["run-77"]);
		// Replay is a different process: the linkage restores empty even though the
		// persisted entry recorded it, because those runs ended with their process.
		const entries = appended.map((fields) => ({
			...fields,
			turnId: "turn-1",
			timestamp: "2026-07-03T00:00:00.000Z",
		}));
		strictEqual(foldTaskBoard(entries)?.activeRunIds.length, 0);
	});

	it("ignores run linkage when no board is declared", () => {
		const { store, appended } = storeWithLog();
		store.attachRun("run-99");
		strictEqual(store.snapshot(), null);
		strictEqual(appended.length, 0);
	});
});

describe("contracts/task-board tool", () => {
	it("returns the whole rendered board after every mutation", async () => {
		const { store } = storeWithLog();
		const tool = createTasksTool({ board: store });
		const planned = await tool.run({ action: "plan", title: "Ship it", tasks: ["one", "two"] });
		strictEqual(planned.kind, "ok");
		ok(planned.kind === "ok" && planned.output.includes('board "Ship it" 0/2 done'));
		ok(planned.kind === "ok" && planned.output.includes("[ ] t1 one"));
		ok((await tool.run({ action: "start", id: "t1" })).kind === "ok");
		const done = await tool.run({ action: "done", id: "t1", note: "lint green" });
		strictEqual(done.kind, "ok");
		ok(done.kind === "ok" && done.output.includes("[x] t1 one — evidence: lint green"));
	});

	it("refuses done for unexecuted work and points at block or drop", async () => {
		const { store } = storeWithLog();
		const tool = createTasksTool({ board: store });
		await tool.run({ action: "plan", title: "Board", tasks: ["one", "two"] });
		const unstarted = await tool.run({ action: "done", id: "t1", note: "not executed" });
		strictEqual(unstarted.kind, "error");
		await tool.run({ action: "start", id: "t1" });
		const noEvidence = await tool.run({ action: "done", id: "t1" });
		strictEqual(noEvidence.kind, "error");
		ok(noEvidence.kind === "error" && noEvidence.message.includes("block"));
		const blocked = await tool.run({ action: "block", id: "t1", note: "capacity was full" });
		strictEqual(blocked.kind, "ok");
		ok(blocked.kind === "ok" && blocked.output.includes("[!] t1 one — blocked: capacity was full"));
	});

	it("reports actionable errors for missing arguments and an empty board", async () => {
		const { store } = storeWithLog();
		const tool = createTasksTool({ board: store });
		const noTitle = await tool.run({ action: "plan" });
		strictEqual(noTitle.kind, "error");
		const noBoard = await tool.run({ action: "start", id: "t1" });
		strictEqual(noBoard.kind, "error");
		const list = await tool.run({ action: "list" });
		strictEqual(list.kind, "ok");
		ok(list.kind === "ok" && list.output.includes('action="plan"'));
	});

	it("normalizes weak-model argument shapes through prepareArguments", async () => {
		const { store } = storeWithLog();
		const tool = createTasksTool({ board: store });
		const prepare = tool.prepareArguments;
		ok(prepare);
		deepStrictEqual(prepare({ action: "start", id: 2 }).id, "t2");
		deepStrictEqual(prepare({ action: "start", id: "2" }).id, "t2");
		deepStrictEqual(prepare({ action: "plan", tasks: '["one","two"]' }).tasks, ["one", "two"]);
		const planned = await tool.run(prepare({ action: "plan", title: "Board", tasks: '["one","two"]' }));
		strictEqual(planned.kind, "ok");
		const started = await tool.run(prepare({ action: "start", id: 2 }));
		strictEqual(started.kind, "ok");
		strictEqual(store.snapshot()?.tasks[1]?.status, "active");
	});

	it("exposes board counts in details for the transcript ledger tail", async () => {
		const { store } = storeWithLog();
		const tool = createTasksTool({ board: store });
		await tool.run({ action: "plan", title: "Board", tasks: ["one", "two"] });
		await tool.run({ action: "start", id: "t1" });
		const done = await tool.run({ action: "done", id: "t1", note: "npm test green" });
		ok(done.kind === "ok");
		const counts = (done.details as { counts: { completed: number; total: number } }).counts;
		strictEqual(counts.completed, 1);
		strictEqual(counts.total, 2);
	});
});

describe("contracts/task-board nudge", () => {
	it("carries the turn onward when a work turn ends with open tasks", () => {
		const { store } = plannedStore();
		const registration = createTaskNudgeRegistration({ getBoard: () => store.snapshot() });
		strictEqual(registration.id, TASK_NUDGE_REGISTRATION_ID);
		const effects = registration.evaluate(turnEndInput(), undefined);
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["request_continuation", "inject_reminder"],
		);
		const first = effects[0];
		ok(first?.kind === "request_continuation");
		ok(first.message.includes('"Ship the feature"'));
		ok(first.message.includes("t1 design it"));
	});

	it("stays silent for conversation turns, absent boards, and settled boards", () => {
		const { store } = plannedStore();
		const registration = createTaskNudgeRegistration({ getBoard: () => store.snapshot() });
		// Pure chat turn: no tool calls means the operator is discussing.
		deepStrictEqual(
			registration.evaluate(turnEndInput({ metadata: { stopReason: "stop", turnToolCalls: 0 } }), undefined),
			[],
		);
		// Aborted turn: no completion claim to hold open.
		deepStrictEqual(
			registration.evaluate(
				turnEndInput({ metadata: { stopReason: "aborted", turnToolCalls: 3, activeToolNames: "tasks" } }),
				undefined,
			),
			[],
		);
		// Tool surface without tasks: nudging would loop against a wall.
		deepStrictEqual(
			registration.evaluate(
				turnEndInput({ metadata: { stopReason: "stop", turnToolCalls: 3, activeToolNames: "read,edit" } }),
				undefined,
			),
			[],
		);
		// No board declared at all.
		const bare = createTaskNudgeRegistration({ getBoard: () => null });
		deepStrictEqual(bare.evaluate(turnEndInput(), undefined), []);
		// Every task closed or honestly parked: completed/blocked/dropped is settled.
		ok(store.apply({ op: "start", id: "t1" }).ok);
		ok(store.apply({ op: "done", id: "t1", evidence: "tests green" }).ok);
		ok(store.apply({ op: "block", id: "t2", reason: "needs operator decision" }).ok);
		ok(store.apply({ op: "drop", id: "t3", reason: "superseded" }).ok);
		deepStrictEqual(registration.evaluate(turnEndInput(), undefined), []);
	});
});
