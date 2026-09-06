import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import { buildOpenTasksMessage, createTaskNudgeRegistration } from "../../src/domains/middleware/task-nudge.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { MiddlewareEffect } from "../../src/domains/middleware/types.js";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import { createTurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

test("paired task continuation and warning deliver one model reminder while preserving the nudge", async () => {
	const board: TaskBoardSnapshot = {
		boardId: "fixture",
		title: "Deferred clamp implementation",
		tasks: [{ id: "t1", title: "RED: write test_clamp.py", status: "pending" }],
		activeRunIds: [],
	};
	const nudge = createTaskNudgeRegistration({ getBoard: () => board });
	const state = createTurnState("off");
	state.turnToolCalls = 1;
	const notices: string[] = [];
	const footer: string[] = [];
	// Source API only: no engine, provider, or subprocess is started.
	const runtime = {
		wireModelId: "fixture",
		runtimeId: "fixture",
		runtimeResolution: {},
		agent: { state: { tools: [{ name: "tasks" }], messages: [] } },
	} as unknown as AgentRuntime;
	const middleware = createTurnMiddleware({
		state,
		middleware: { runHook: (input) => runMiddlewareRegistrations(input, [nudge]) } as MiddlewareContract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: (text) => notices.push(text),
		emitFooterNotice: (_level, _text, key) => footer.push(key),
	});
	await middleware.fireTurnEnd(runtime, [], { toolCallId: "fixture", toolName: "tasks" });
	const message = buildOpenTasksMessage(board);
	strictEqual(middleware.flushPendingReminders(), `<system-reminder>\n${message}\n</system-reminder>`);
	strictEqual(middleware.flushPendingReminders(), "");
	strictEqual(state.pendingRequestContinuation, true);
	strictEqual(state.stalledTurnNudgeSpent, true);
	deepStrictEqual(notices, [message]);
	deepStrictEqual(footer, ["nudge.continuation.sent"]);
	strictEqual(board.tasks[0]?.status, "pending");
});

test("deduplicating model text preserves hard-block effects and distinct reminder order", async () => {
	const effects: MiddlewareEffect[] = [
		{ kind: "inject_reminder", message: "same finding", severity: "warn" },
		{ kind: "inject_reminder", message: "same finding", severity: "hard-block" },
		{ kind: "inject_reminder", message: "different finding", severity: "info" },
	];
	const state = createTurnState("off");
	let aborts = 0;
	const runtime = {
		wireModelId: "fixture",
		runtimeId: "fixture",
		runtimeResolution: {},
		agent: { state: { tools: [], messages: [] }, abort: () => aborts++ },
	} as unknown as AgentRuntime;
	const middleware = createTurnMiddleware({
		state,
		middleware: { runHook: () => ({ effects, ruleIds: [] }) } as unknown as MiddlewareContract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
	});
	await middleware.fireTurnEnd(runtime, [], { toolCallId: "fixture", toolName: "read" });
	strictEqual(aborts, 1);
	strictEqual(state.toolProseAbortReason, "same finding");
	strictEqual(
		middleware.flushPendingReminders(),
		"<system-reminder>\nsame finding\n\ndifferent finding\n</system-reminder>",
	);
});
