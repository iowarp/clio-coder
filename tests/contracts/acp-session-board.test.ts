import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import type { UserTask } from "../../src/domains/user-tasks/store.js";
import { ACP_BOARD_MAX_ITEMS, type AcpBoardSource, projectSessionBoard } from "../../src/engine/acp/board.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";

// The terminal's /tasks, /decisions and /memory views had no ACP read path, so a GUI could add an
// operator task but never list one. The board is that read path, bounded for the stdio line.

const at = "2026-09-26T00:00:00.000Z";
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
	assert.deepEqual(board.memory, { enabled: true, tier: "rules", entries: 3, stepInFlight: false });
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
