import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import type { TaskBoardSnapshot } from "../../src/domains/session/task-board.js";
import type { UserTask } from "../../src/domains/user-tasks/store.js";
import { ACP_BOARD_MAX_ITEMS, type AcpBoardSource, projectSessionBoard } from "../../src/engine/acp/board.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { createAcpLiveTelemetry } from "../../src/engine/acp/live-telemetry.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

// The terminal's /tasks, /decisions and /memory views had no ACP read path, so a GUI could add an
// operator task but never list one. The board is that read path, bounded for the stdio line.

const at = "2026-09-26T00:00:00.000Z";

test("plan replay restores unchanged and empty plans after the client resets its branch", () => {
	const updates: Array<Record<string, unknown>> = [];
	let plan: TaskBoardSnapshot | null = {
		boardId: "b1",
		title: "Ship it",
		tasks: [{ id: "1", title: "Read", status: "pending" }],
		activeRunIds: [],
	};
	const telemetry = createAcpLiveTelemetry({
		sessionId: () => "session",
		cwd: process.cwd(),
		plan: () => plan,
		notify: (_sessionId, update) => updates.push(update),
	});
	try {
		telemetry.bind(false);
		assert.equal(updates.length, 0);
		telemetry.bind(true);
		telemetry.bind(true);
		assert.equal(updates.length, 2);
		assert.deepEqual(updates[1], updates[0]);
		telemetry.toolSettled(false);
		assert.equal(updates.length, 2, "ordinary unchanged tools still coalesce the plan");
		plan = null;
		telemetry.bind(true);
		telemetry.bind(true);
		assert.equal(updates.length, 4);
		assert.deepEqual(updates[2]?.entries, []);
		assert.deepEqual(updates[3], updates[2]);
	} finally {
		telemetry.dispose();
	}
});
const task = (id: string, title = `Task ${id}`): UserTask => ({
	id,
	title,
	status: "open",
	createdAt: at,
	updatedAt: at,
	acceptance: { expectedOutputs: ["report.md"], verification: [{ check: "unit", timeoutMs: 60_000 }] },
});
const ledger = {
	kind: "decisionLedger",
	turnId: "t1",
	parentTurnId: null,
	timestamp: at,
	interviewId: "interview-1",
	interviewStatus: "complete",
	startedAt: at,
	endedAt: at,
	roundCount: 1,
	transcriptPath: "/private/transcript.json",
	decisions: [
		{ key: "db", value: "sqlite", status: "active", decidedAt: at, source: "operator" },
		{
			key: "cache",
			value: "none",
			status: "superseded",
			decidedAt: at,
			correction: "use redis",
			source: "agent",
			rationale: "simpler",
		},
	],
} as unknown as DecisionLedgerEntry;
const source = (overrides: Partial<AcpBoardSource> = {}): AcpBoardSource => ({
	operatorTasks: [task("u1")],
	plan: {
		boardId: "b1",
		title: "Ship the board",
		tasks: [{ id: "1", title: "Project it", status: "active" }],
		activeRunIds: ["run-private"],
	},
	decisions: [ledger],
	memory: {
		enabled: true,
		tier: "rules",
		bank: { status: null, knowledge: [{}, {}], procedural: [{}] } as never,
		stepInFlight: false,
	},
	...overrides,
});

test("the board projects what the terminal views show and nothing the ledger keeps for itself", () => {
	const board = projectSessionBoard(source());
	assert.deepEqual(board.operatorTasks, [
		{ id: "u1", title: "Task u1", status: "open", expectedOutputs: ["report.md"], verificationChecks: 1 },
	]);
	assert.deepEqual(board.plan, {
		title: "Ship the board",
		tasks: [{ id: "1", title: "Project it", status: "active", origin: "agent", reason: null }],
	});
	assert.deepEqual(
		board.decisions.map((row) => [row.ref, row.status, row.source, row.correction]),
		[
			["interview-1/db", "active", "operator", null],
			["interview-1/cache", "superseded", "agent", "use redis"],
		],
	);
	// Entries without an id and text are not offered for promotion; the count still reports them.
	assert.deepEqual(board.memory, { enabled: true, tier: "rules", entries: 3, stepInFlight: false, bank: [] });
	assert.deepEqual(
		board.decisions.map((row) => [row.interviewId, row.key]),
		[
			["interview-1", "db"],
			["interview-1", "cache"],
		],
	);
	assert.equal(board.truncated, false);
	const wire = JSON.stringify(board);
	for (const secret of ["/private/transcript.json", "run-private", "b1"]) assert.ok(!wire.includes(secret), secret);
});

test("lists stop at the bound and long text is cut, and the cut is reported", () => {
	const many = Array.from({ length: ACP_BOARD_MAX_ITEMS + 5 }, (_, index) => task(`u${index}`, "x".repeat(4000)));
	const board = projectSessionBoard(source({ operatorTasks: many, plan: null, memory: null }));
	assert.equal(board.operatorTasks.length, ACP_BOARD_MAX_ITEMS);
	assert.equal(board.truncated, true);
	assert.ok(Buffer.byteLength(board.operatorTasks[0]?.title ?? "", "utf8") <= 1024);
	assert.equal(board.plan, null);
	assert.equal(board.memory, null);
});

function serve(board?: () => AcpBoardSource) {
	const requests = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onRequest: (method, handler) => {
			requests.set(method, handler);
			return () => requests.delete(method);
		},
		onNotification: () => () => {},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const served = serveClioAcpAgent({
		transport,
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => false,
			getSessionId: () => null,
		},
		cwd: process.cwd(),
		...(board ? { board } : {}),
	});
	const call = async (method: string, params: unknown) => {
		const handler = requests.get(method);
		assert.ok(handler, method);
		return handler(params);
	};
	return { call, close: () => transport.close(), served };
}

test("the method is announced and answers only when the host supplies a board", async () => {
	const without = serve();
	const bare = (await without.call("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
		agentCapabilities: { _meta: Record<string, unknown> };
	};
	assert.equal(bare.agentCapabilities._meta["clio-coder/board"], undefined);
	await assert.rejects(
		async () => without.call("_clio-coder/session/board", { sessionId: "any" }),
		(error: unknown) => error instanceof AcpRequestError && error.detail?.code === "method_not_found",
	);
	without.close();
	await without.served;

	const wired = serve(() => source());
	const init = (await wired.call("initialize", { protocolVersion: 1, clientCapabilities: {} })) as {
		agentCapabilities: { _meta: Record<string, unknown> };
	};
	assert.deepEqual(init.agentCapabilities._meta["clio-coder/board"], {
		version: 1,
		method: "_clio-coder/session/board",
	});
	const session = (await wired.call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	const board = (await wired.call("_clio-coder/session/board", { sessionId: session.sessionId })) as { version: number };
	assert.equal(board.version, 1);
	await assert.rejects(async () => wired.call("_clio-coder/session/board", { sessionId: "not-a-session" }));
	wired.close();
	await wired.served;
});

test("each plan change reaches the client as a standard plan update, in order", async () => {
	const requests = new Map<string, (params: unknown) => unknown>();
	const updates: Array<Record<string, unknown>> = [];
	let close: () => void = () => {};
	let onEvent: (event: unknown) => void = () => {};
	let plan: TaskBoardSnapshot | null = null;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: (method, params) => {
			if (method === "session/update") updates.push((params as { update: Record<string, unknown> }).update);
		},
		onRequest: (method, handler) => {
			requests.set(method, handler);
			return () => requests.delete(method);
		},
		onNotification: () => () => {},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const tool = (id: string, change: () => void) => {
		onEvent({ type: "tool_execution_start", toolCallId: id, toolName: "tasks", args: {} });
		change();
		onEvent({ type: "tool_execution_end", toolCallId: id, toolName: "tasks", result: "ok", isError: false });
	};
	const board = (tasks: TaskBoardSnapshot["tasks"]): TaskBoardSnapshot => ({
		boardId: "b1",
		title: "Ship it",
		tasks,
		activeRunIds: [],
	});
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		plan: () => plan,
		chat: {
			submit: async () => {
				tool("c1", () => {
					plan = board([
						{ id: "1", title: "Read", status: "active" },
						{ id: "2", title: "Write", status: "pending" },
					]);
				});
				// A settled call that leaves the rows alone sends nothing.
				tool("c2", () => {
					plan = plan === null ? null : { ...plan, activeRunIds: ["run-1"] };
				});
				tool("c3", () => {
					plan = board([
						{ id: "1", title: "Read", status: "completed" },
						{ id: "2", title: "Write", status: "blocked", reason: "needs review" },
						{ id: "3", title: "Drop me", status: "cancelled", reason: "out of scope" },
					]);
				});
			},
			cancel: () => {},
			onEvent: (handler) => {
				onEvent = handler;
				return () => {
					onEvent = () => {};
				};
			},
			isStreaming: () => false,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) => await requests.get(method)?.(params);
	await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
	await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "plan" }] });
	const plans = updates.filter((update) => update.sessionUpdate === "plan") as Array<{
		entries: Array<{ content: string; status: string; priority: string; _meta: Record<string, unknown> }>;
		_meta: Record<string, unknown>;
	}>;
	assert.deepEqual(
		plans.map((frame) => frame.entries.map((entry) => [entry.content, entry.status, entry.priority])),
		[
			[
				["Read", "in_progress", "medium"],
				["Write", "pending", "medium"],
			],
			[
				["Read", "completed", "medium"],
				["Write", "pending", "medium"],
			],
		],
	);
	assert.deepEqual(plans[1]?.entries[1]?._meta["clio-coder/plan"], {
		id: "2",
		status: "blocked",
		origin: "agent",
		reason: "needs review",
	});
	assert.deepEqual(plans[1]?._meta["clio-coder/plan"], {
		version: 1,
		boardId: "b1",
		title: "Ship it",
		cancelled: 1,
		truncated: false,
	});
	// Each plan frame follows the tool call that changed it.
	const order = updates.map((update) =>
		update.sessionUpdate === "tool_call_update" ? `end:${update.toolCallId}` : String(update.sessionUpdate),
	);
	assert.ok(order.indexOf("end:c1") < order.indexOf("plan"));
	assert.ok(order.lastIndexOf("plan") > order.indexOf("end:c3"));
	close();
	await served;
});
