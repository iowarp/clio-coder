import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
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
