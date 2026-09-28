import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DetachedBatchRecord } from "../../src/domains/dispatch/batch-store.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { TurnInterpretation } from "../../src/domains/turn-control/index.js";
import type { TurnControlRunnerDeps } from "../../src/interactive/turn-control-runner.js";
import { createTurnControlRunner } from "../../src/interactive/turn-control-runner.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const interpretation: TurnInterpretation = {
	version: "turn-interpretation-v1",
	intent: "inspect",
	intentCertainty: 1,
	orientation: { wanted: 1, breadth: "repository", subject: null },
	direction: { requested: 0 },
	shape: "single",
};
const report = {
	findings: [{ claim: "Entry point", path: "src/cli/index.ts", line: 1 }],
	needsSplit: false,
	proposedSubtasks: [],
};
async function* events() {
	/* S6: no synthetic worker events are needed for these contract facts. */
}
function receipt(data: unknown = report): RunReceipt {
	return {
		runId: "scout-1",
		agentId: "scout",
		outcome: "succeeded",
		exitCode: 0,
		toolCalls: 3,
		output: { state: "final", text: JSON.stringify(data) },
		integrity: { digest: "a".repeat(64) },
	} as RunReceipt;
}
function harness(overrides: Partial<TurnControlRunnerDeps> = {}, receiptData: unknown = report) {
	const cwd = mkdtempSync(join(tmpdir(), "clio-orientation-"));
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.turnControl.workflows = ["orientation"];
	const requests: DispatchRequest[] = [];
	const aborted: string[] = [];
	const notices: string[] = [];
	const context = dispatchStubContext({ settings });
	const dispatch = {
		async dispatch(request: DispatchRequest) {
			requests.push(request);
			return { runId: "scout-1", events: events(), finalPromise: Promise.resolve(receipt(receiptData)) };
		},
		async dispatchBatch() {
			throw new Error("unexpected split");
		},
		abort(id: string) {
			aborted.push(id);
		},
		getRun: () => null,
	} as unknown as DispatchContract;
	const deps: TurnControlRunnerDeps = {
		cwd,
		getSettings: () => settings,
		getAutonomy: () => "default",
		dispatch,
		agents: context.getContract("agents"),
		toolRegistry: {
			invoke: async () => ({ kind: "not_visible", reason: "fixture" }),
			get: (() => ({ name: "dispatch" })) as unknown as NonNullable<TurnControlRunnerDeps["toolRegistry"]>["get"],
		},
		getTurnConstraints: () => undefined,
		isContinuation: () => false,
		readInterpretation: () => interpretation,
		fallback: async () => ({ interpretation: null }),
		facts: {
			turnIndex: () => 0,
			taskEstablished: () => false,
			clarificationStreak: () => 0,
			finishedDetachedBatchIds: () => [],
		},
		emitNotice: (text) => notices.push(text),
		...overrides,
	};
	return {
		runner: createTurnControlRunner(deps),
		deps,
		requests,
		aborted,
		notices,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}
const input = (signal = new AbortController().signal) => ({
	operatorText: "explore this repo",
	previous: "",
	userTurnId: "u-1",
	signal,
});

test("orientation dispatches read-only from the harness once, renders findings and reuses the original snapshot", async () => {
	const h = harness();
	try {
		const first = await h.runner.run(input());
		assert.equal(h.requests.length, 1);
		assert.equal(h.requests[0]?.requestOrigin, "harness");
		assert.equal(h.requests[0]?.readOnly, true);
		assert.deepEqual(h.requests[0]?.intent, {
			version: 2,
			readRoots: [],
			writeRoots: [],
			relevantPaths: [],
			pathProvenance: [],
			expectedOutputs: [],
			verification: [],
		});
		assert.match(first.block ?? "", /scout-1/);
		assert.match(first.block ?? "", /Entry point.*src\/cli\/index.ts:1/);
		assert.equal(first.record.producer, "decision-site");
		const second = await h.runner.run({ ...input(), userTurnId: "u-2" });
		assert.equal(h.requests.length, 1);
		assert.equal(second.block, first.block);
		assert.deepEqual(second.record.orientation, first.record.orientation);
		const resumed = createTurnControlRunner(h.deps);
		resumed.seedOrientation(first.record.orientation ?? null);
		const third = await resumed.run({ ...input(), userTurnId: "u-3" });
		assert.equal(third.block, first.block);
		assert.equal(h.requests.length, 1);
		resumed.seedOrientation(null);
		await resumed.run(input());
		assert.equal(h.requests.length, 2);
	} finally {
		h.cleanup();
	}
});
test("throwing admission records a refusal and one notice without a block", async () => {
	const h = harness({
		dispatch: {
			dispatch: async () => {
				throw new Error("admission refused");
			},
		} as unknown as DispatchContract,
	});
	try {
		const result = await h.runner.run(input());
		assert.equal(result.block, null);
		assert.deepEqual(result.record.executed, { refused: "admission refused" });
		assert.deepEqual(h.notices, ["[Orientation] not started: admission refused"]);
	} finally {
		h.cleanup();
	}
});
test("canceling in-flight orientation aborts its run and leaves no block", async () => {
	let started!: () => void;
	const admitted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const h = harness();
	assert.ok(h.deps.dispatch);
	h.deps.dispatch.dispatch = async () => ({
		runId: "scout-1",
		events: events(),
		finalPromise: new Promise<RunReceipt>(() => {}),
	});
	h.deps.emitNotice = () => started();
	const controller = new AbortController();
	try {
		const pending = h.runner.run(input(controller.signal));
		await admitted;
		controller.abort();
		const result = await pending;
		assert.deepEqual(h.aborted, ["scout-1"]);
		assert.equal(result.block, null);
		assert.deepEqual(result.record.executed, { refused: "canceled" });
	} finally {
		h.cleanup();
	}
});
test("a strict split asking for write authority is refused and only the first Scout is rendered", async () => {
	const h = harness(
		{},
		{
			findings: [],
			needsSplit: true,
			proposedSubtasks: [
				{
					id: "write",
					task: "Change code",
					dependencies: [],
					expectedResultContract: "mutation-report",
					requestedAuthority: "workspace-edit",
				},
			],
		},
	);
	try {
		const result = await h.runner.run(input());
		assert.equal(h.requests.length, 1);
		assert.match(result.block ?? "", /Limitations:.*split refused: harness orientation permits read-only subtasks only/);
		assert.equal(result.record.orientation?.runId, "scout-1");
	} finally {
		h.cleanup();
	}
});

test("direction provides admitted workspace observations without dispatching a worker", async () => {
	const h = harness({
		readInterpretation: () => ({
			...interpretation,
			orientation: { wanted: 0, breadth: null, subject: null },
			direction: { requested: 1 },
		}),
		facts: {
			turnIndex: () => 2,
			taskEstablished: () => false,
			clarificationStreak: () => 1,
			finishedDetachedBatchIds: () => [],
		},
	});
	const calls: string[] = [];
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.turnControl.workflows = ["direction"];
	h.deps.getSettings = () => settings;
	assert.ok(h.deps.toolRegistry);
	h.deps.toolRegistry.invoke = async (call, options) => {
		assert.equal(options?.origin, "harness");
		calls.push(call.tool);
		return { kind: "not_visible", reason: "unavailable fixture observation" };
	};
	try {
		const result = await h.runner.run(input());
		assert.match(result.block ?? "", /^\[Direction\]/u);
		assert.equal(h.requests.length, 0);
		assert.deepEqual(calls, ["git", "git", "ls", "read"]);
		assert.ok(result.record.executed && "runIds" in result.record.executed);
		assert.deepEqual(result.record.executed.runIds, []);
		assert.deepEqual(h.notices, ["[Direction] observed 0 read-only facts"]);
	} finally {
		h.cleanup();
	}
});

test("collect combines two finished batches on a continuation and durably marks both", async () => {
	const { fixtureEnvelope } = await import("../harness/receipt.js");
	const records: DetachedBatchRecord[] = ["batch-a", "batch-b"].map((id) => ({
		id,
		runs: [{ runId: id, assignmentId: id, agentId: "scout" }],
		sessionId: "owner",
		createdAt: "fixture",
		collectedAt: null,
	}));
	const runs = records.map((record) => fixtureEnvelope(record.id));
	const marked: string[] = [];
	const dispatch = {
		owner: () => ({ sessionId: "owner", cwd: "/workspace" }),
		getRun: (id: string) => runs.find((run) => run.id === id) ?? null,
		listRuns: () => runs,
		detached: {
			get: (id: string) => records.find((record) => record.id === id) ?? null,
			async markCollected(id: string) {
				marked.push(id);
				const record = records.find((record) => record.id === id);
				if (record) record.collectedAt = "collected";
				return record ?? null;
			},
		},
	} as unknown as DispatchContract;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.turnControl.workflows = ["detached-collection"];
	const h = harness({
		dispatch,
		getSettings: () => settings,
		readInterpretation: () => undefined,
		facts: {
			turnIndex: () => 2,
			taskEstablished: () => false,
			clarificationStreak: () => 0,
			finishedDetachedBatchIds: () => records.filter((record) => record.collectedAt === null).map((record) => record.id),
		},
	});
	try {
		const result = await h.runner.run({ ...input(), continuation: true });
		assert.match(result.block ?? "", /^\[Collected\]/u);
		assert.match(result.block ?? "", /collect complete for batch batch-a/u);
		assert.match(result.block ?? "", /collect complete for batch batch-b/u);
		assert.deepEqual(marked, ["batch-a", "batch-b"]);
		assert.deepEqual(h.notices, ["[Collected] 2 batch(es)"]);
		assert.ok(result.record.executed && "runIds" in result.record.executed);
		assert.deepEqual(result.record.executed.runIds, ["batch-a", "batch-b"]);
		assert.equal(h.requests.length, 0);
		const next = await h.runner.run({ ...input(), continuation: true });
		assert.deepEqual(next.record.decision, { kind: "none", reason: "continuation" });
	} finally {
		h.cleanup();
	}
});
