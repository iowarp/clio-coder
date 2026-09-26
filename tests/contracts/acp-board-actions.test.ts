import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMemoryRecords } from "../../src/domains/memory/index.js";
import type { TaskMemorySnapshot } from "../../src/domains/memory/task-bank.js";
import { createDecisionBoardStore, type DecisionLedgerEntryFields } from "../../src/domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../../src/domains/session/entries.js";
import { AcpRequestError } from "../../src/engine/acp/errors.js";
import { bindBoardActions } from "../../src/engine/acp/host-members.js";
import { type AcpBoardActions, serveClioAcpAgent } from "../../src/engine/acp/server.js";
import type { AcpJsonRpcPeerTransport } from "../../src/engine/acp/transport.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const INTERVIEW: DecisionLedgerEntry = {
	kind: "decisionLedger",
	turnId: "interview-entry",
	parentTurnId: "turn-1",
	timestamp: "2026-09-26T00:00:00.000Z",
	interviewId: "interview-1",
	interviewStatus: "complete",
	startedAt: "2026-09-26T00:00:00.000Z",
	endedAt: "2026-09-26T00:00:01.000Z",
	roundCount: 1,
	exposure: "local",
	decisions: [
		{ key: "format", label: "Report format", value: "Markdown", status: "active", decidedAt: "2026-09-26T00:00:01.000Z" },
	],
};

const BANK: TaskMemorySnapshot = {
	version: 1,
	status: null,
	knowledge: [
		{
			id: "k1",
			kind: "knowledge",
			content: "Sample B reads 4.2 on the field instrument.",
			createdAt: "2026-09-26T00:00:00.000Z",
			lastTouchedAt: "2026-09-26T00:00:00.000Z",
			injectionCount: 0,
		},
	],
	procedural: [],
};

function board() {
	const entries: DecisionLedgerEntry[] = [INTERVIEW];
	let sequence = 0;
	const store = createDecisionBoardStore({
		getSessionId: () => "session-1",
		readEntries: () => entries,
		getActiveLeafTurnId: () => "turn-9",
		appendEntry: (entry: DecisionLedgerEntryFields) => {
			sequence += 1;
			entries.push({ ...entry, turnId: `revision-${sequence}`, timestamp: `2026-09-26T00:00:0${sequence}.000Z` });
		},
		now: () => new Date("2026-09-26T00:05:00.000Z"),
	});
	return { entries, store };
}

test("superseding keeps the decision in the record, a correction yields the terminal's turn, and a retry writes nothing", () => {
	const { entries, store } = board();
	const actions = bindBoardActions({
		decisionBoard: store,
		taskBank: () => BANK,
		currentSession: () => ({ id: "session-1", cwd: process.cwd() }),
		dataDir: "/nonexistent",
	});
	const corrected = actions.supersedeDecision("interview-1", "format", "Use HTML with one table");
	assert.equal(corrected.status, "superseded");
	assert.equal(
		corrected.correctionTurn,
		'Decision "Report format" (previously: Markdown) is superseded by the operator. New direction: Use HTML with one table. Acknowledge and adjust the plan.',
	);
	assert.equal(entries.length, 2, "one revision appended");
	const revised = store.snapshot().find((row) => row.interviewId === "interview-1")?.decisions[0];
	assert.equal(revised?.status, "superseded");
	assert.equal(revised?.correction, "Use HTML with one table");
	assert.deepEqual(actions.supersedeDecision("interview-1", "format"), { status: "already_superseded" });
	assert.equal(entries.length, 2, "a retried supersede appends nothing");
	assert.throws(() => actions.supersedeDecision("interview-1", "missing"), /not on the board/);
});

test("a task-bank proposal is a reviewable candidate and a retry finds it instead of writing a second", async () => {
	const scratch = await isolateClioEnv("clio-coder-acp-board-");
	try {
		const actions = bindBoardActions({
			decisionBoard: board().store,
			taskBank: () => BANK,
			currentSession: () => ({ id: "session-1", cwd: scratch.dir }),
			dataDir: scratch.dir,
		});
		const first = await actions.proposeMemory("k1", "global");
		assert.equal(first.created, true);
		const again = await actions.proposeMemory("k1", "global");
		assert.deepEqual(again, { created: false, recordId: first.recordId });
		const records = await loadMemoryRecords(scratch.dir);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.id, first.recordId);
		await assert.rejects(actions.proposeMemory("k9", "global"), /not in this session/);
	} finally {
		scratch.restore();
	}
});

test("the board methods refuse an unacknowledged global proposal, report refusals as results, and wait for idle", async () => {
	const calls: string[] = [];
	const actions: AcpBoardActions = {
		supersedeDecision: (interviewId, key) => {
			calls.push(`supersede:${interviewId}:${key}`);
			if (key === "missing") throw new Error("decision missing is not on the board");
			return { status: "superseded" };
		},
		proposeMemory: async (entryId, scope) => {
			calls.push(`propose:${entryId}:${scope}`);
			return { created: true, recordId: "memory-1" };
		},
	};
	const handlers = new Map<string, (params: unknown) => unknown>();
	let close: () => void = () => {};
	let streaming = false;
	const transport: AcpJsonRpcPeerTransport = {
		closed: false,
		request: async () => ({}) as never,
		notify: () => {},
		onNotification: () => () => {},
		onRequest: (method, handler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		},
		onClose: (handler) => {
			close = handler;
			return () => {};
		},
		close: () => close(),
	};
	const served = serveClioAcpAgent({
		transport,
		cwd: process.cwd(),
		autonomy: () => "default",
		board: () => ({ operatorTasks: [], plan: null, decisions: [], memory: null }),
		boardActions: actions,
		chat: {
			submit: async () => {},
			cancel: () => {},
			onEvent: () => () => {},
			isStreaming: () => streaming,
			getSessionId: () => null,
		},
	});
	const call = async (method: string, params: unknown) =>
		(await handlers.get(method)?.(params)) as Record<string, unknown>;
	try {
		const init = await call("initialize", { protocolVersion: 1 });
		assert.deepEqual((init.agentCapabilities as { _meta: Record<string, unknown> })._meta["clio-coder/board"], {
			version: 1,
			method: "_clio-coder/session/board",
			supersede: "_clio-coder/decisions/supersede",
			proposeMemory: "_clio-coder/memory/propose",
		});
		const { sessionId } = (await call("session/new", { cwd: process.cwd(), mcpServers: [] })) as { sessionId: string };
		const unacknowledged = await call("_clio-coder/memory/propose", { sessionId, entryId: "k1", scope: "global" });
		assert.equal(unacknowledged.status, "needs_acknowledgement");
		assert.deepEqual(calls, [], "nothing is proposed before the operator acknowledges global scope");
		assert.deepEqual(
			await call("_clio-coder/memory/propose", { sessionId, entryId: "k1", scope: "global", acknowledgeGlobal: true }),
			{ status: "proposed", recordId: "memory-1" },
		);
		assert.deepEqual(await call("_clio-coder/decisions/supersede", { sessionId, interviewId: "i1", key: "missing" }), {
			status: "refused",
			reason: "decision missing is not on the board",
		});
		streaming = true;
		await assert.rejects(
			call("_clio-coder/decisions/supersede", { sessionId, interviewId: "i1", key: "format" }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "prompt_active",
		);
		streaming = false;
		await assert.rejects(
			call("_clio-coder/decisions/supersede", { sessionId, interviewId: "i1", key: "format", correction: "   " }),
			(error: unknown) => error instanceof AcpRequestError && error.detail.code === "invalid_params",
		);
	} finally {
		close();
		await served;
	}
});
