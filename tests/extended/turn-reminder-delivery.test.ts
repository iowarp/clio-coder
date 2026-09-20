import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelResponse } from "../../src/domains/memory/task-memory-policy.js";
import type { TaskMemoryTelemetryStep } from "../../src/domains/memory/task-memory-telemetry.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { runMiddlewareRegistrations } from "../../src/domains/middleware/runtime.js";
import { buildOpenTasksMessage, createTaskNudgeRegistration } from "../../src/domains/middleware/task-nudge.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

test("empty failed and canceled turns reach memory observers without resuming foreground work", async () => {
	for (const stopReason of ["error", "aborted"] as const) {
		let calls = 0;
		const rows: TaskMemoryTelemetryStep[] = [];
		const memory = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			telemetry: { record: (row) => rows.push(row) },
			getModelClient: () => ({
				complete: async () => {
					calls++;
					return { text: "<operations>[]</operations><no_intervention/>" };
				},
			}),
		});
		const { contract } = createMiddlewareBundle({
			registrations: [
				memory,
				{
					id: "fixture.continuation",
					description: "assert interrupted turns cannot resume",
					hooks: ["turn_end"],
					evaluate: () => [{ kind: "request_continuation", message: "must not resume" }],
				},
			],
		});
		const state = createTurnState("off");
		state.turnToolCalls = 10;
		const runtime = {
			wireModelId: "fixture",
			runtimeId: "fixture",
			runtimeResolution: {},
			agent: { state: { tools: [], messages: [] } },
		} as unknown as AgentRuntime;
		const turn = createTurnMiddleware({
			state,
			middleware: contract,
			middlewareToolChoice: createMiddlewareToolChoiceControl(),
			emitNotice: () => {},
			emitFooterNotice: () => {},
		});
		try {
			turn.fireTurnStart(runtime, "Inspect source");
			for (let i = 0; i < 10; i++)
				contract.runHook({
					hook: "after_tool",
					toolName: "read",
					toolCallId: String(i),
					toolArgs: { path: `file-${i}` },
					metadata: { resultKind: "ok" },
				});
			await turn.fireTurnEnd(runtime, [
				{ role: "assistant", content: [], stopReason, timestamp: 1 } as unknown as AgentMessage,
			]);
			await memory.whenIdle();
			strictEqual(rows.length > 0, true, stopReason);
			strictEqual(calls, stopReason === "error" ? 1 : 0, stopReason);
			strictEqual(state.pendingRequestContinuation, false);
			strictEqual(turn.flushPendingReminders(), "");
		} finally {
			memory.dispose();
		}
	}
});

test("tool-batch cadence starts one detached step and delivers completed memory without a new user turn", async () => {
	let complete!: (response: TaskMemoryModelResponse) => void;
	let calls = 0;
	let finishes = 0;
	const receipts: unknown[] = [];
	const pending = new Promise<TaskMemoryModelResponse>((resolve) => {
		complete = resolve;
	});
	let turn!: ReturnType<typeof createTurnMiddleware>;
	const memory = createMemoryInterventionRegistration({
		bank: new TaskMemoryBank(),
		getModelClient: () => ({
			complete: () => {
				calls++;
				return pending;
			},
		}),
		onDeferredReminder: (message) => turn.injectDeferredReminder(message),
	});
	const { contract } = createMiddlewareBundle({
		registrations: [
			memory,
			{
				id: "fixture.finish",
				description: "count final user-turn hooks",
				hooks: ["turn_end"],
				evaluate: () => {
					finishes++;
					return [];
				},
			},
		],
	});
	const state = createTurnState("off");
	state.activeUserTurnId = "operator-turn";
	const { agent } = createEngineAgent();
	const runtime = { agent, wireModelId: "fixture" } as AgentRuntime;
	turn = createTurnMiddleware({
		state,
		middleware: contract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		session: {
			current: () => ({ id: "session" }),
			appendEntry: (entry: unknown) => receipts.push(entry),
		} as unknown as SessionContract,
		emitNotice: () => {},
		emitFooterNotice: () => {},
	});
	try {
		turn.fireTurnStart(runtime, "Inspect source");
		for (let i = 0; i < 10; i++)
			contract.runHook({
				hook: "after_tool",
				sessionId: "session",
				toolName: "read",
				toolCallId: String(i),
				metadata: { resultKind: "ok" },
			});
		state.lastTurnId = "batch-1";
		strictEqual(await turn.prepareToolContinuation(runtime), false, "must return while completion is unresolved");
		strictEqual(calls, 1);
		strictEqual(memory.stepInFlight(), true);
		state.lastTurnId = "batch-2";
		strictEqual(await turn.prepareToolContinuation(runtime), false);
		strictEqual(calls, 1, "no duplicate in-flight step");
		complete({
			text:
				'<operations>[{"op":"save_knowledge","content":"Fixture observation"}]</operations><context_for_action>[tm-k-1] Use fixture observation.</context_for_action>',
		});
		await memory.whenIdle();
		state.lastTurnId = "batch-3";
		strictEqual(await turn.prepareToolContinuation(runtime), true);
		strictEqual(await turn.prepareToolContinuation(runtime), false, "deliver once");
		strictEqual(calls, 1);
		strictEqual(agent.state.messages.length, 1);
		strictEqual(JSON.stringify(agent.state.messages).includes("Use fixture observation"), true);
		strictEqual(receipts.length, 1, "one middleware receipt, no fabricated operator turn");
		strictEqual((receipts[0] as { customType: string }).customType, "middlewareReminder");
		strictEqual(state.activeUserTurnId, "operator-turn");
		strictEqual(state.pendingRequestContinuation, false);
		strictEqual(finishes, 0);
		const abort = new AbortController();
		abort.abort();
		memory.signalLoop();
		state.lastTurnId = "batch-4";
		strictEqual(await turn.prepareToolContinuation(runtime, abort.signal), false);
		strictEqual(calls, 1, "no launch after abort");
	} finally {
		memory.dispose();
	}
});

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

test("a Pi system baseline does not make the first substantive turn look like existing conversation", () => {
	const counts: unknown[] = [];
	const { agent } = createEngineAgent({ initialState: { systemPrompt: "session policy" } });
	const runtime = { agent, wireModelId: "fixture" } as AgentRuntime;
	const middleware = createTurnMiddleware({
		state: createTurnState("off"),
		middleware: {
			runHook: (input: MiddlewareHookInput) => {
				counts.push(input.metadata?.conversationMessages);
				return { effects: [], ruleIds: [] };
			},
		} as unknown as MiddlewareContract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
	});
	middleware.fireTurnStart(runtime, "inspect source");
	agent.state.messages.push({ role: "user", content: "inspect source", timestamp: 1 });
	middleware.fireTurnStart(runtime, "continue");
	deepStrictEqual(counts, [0, 1]);
});
