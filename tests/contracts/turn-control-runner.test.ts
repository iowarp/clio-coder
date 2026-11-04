import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DetachedBatchRecord } from "../../src/domains/dispatch/batch-store.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { TurnControlRunnerDeps } from "../../src/session-control/turn-control-runner.js";
import { createTurnControlRunner } from "../../src/session-control/turn-control-runner.js";

function harness(overrides: Partial<TurnControlRunnerDeps> = {}) {
	const notices: string[] = [];
	const deps: TurnControlRunnerDeps = {
		getSettings: () => DEFAULT_SETTINGS,
		dispatch: undefined,
		getTurnConstraints: () => undefined,
		finishedDetachedBatchIds: () => [],
		emitNotice: (text) => notices.push(text),
		...overrides,
	};
	return { runner: createTurnControlRunner(deps), notices };
}
const input = () => ({ userTurnId: "turn-1", signal: new AbortController().signal });

test("nothing finished is a recorded no-op with no block", async () => {
	const h = harness();
	const result = await h.runner.run(input());
	assert.equal(result.block, null);
	assert.deepEqual(result.record.decision, { kind: "none", reason: "nothing-finished" });
	assert.equal(result.record.executed, null);
	assert.deepEqual(h.notices, []);
});

test("a run already cancelled collects nothing", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness({ finishedDetachedBatchIds: () => ["batch"] });
	const result = await h.runner.run({ userTurnId: "turn-1", signal: controller.signal });
	assert.equal(result.block, null);
	assert.deepEqual(result.record.executed, { refused: "canceled" });
});

test("collect combines two finished batches and durably marks both", async () => {
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
	const h = harness({
		dispatch,
		finishedDetachedBatchIds: () => records.filter((record) => record.collectedAt === null).map((record) => record.id),
	});
	const result = await h.runner.run(input());
	assert.match(result.block ?? "", /^\[Collected\]/u);
	assert.match(result.block ?? "", /collect complete for batch batch-a/u);
	assert.match(result.block ?? "", /collect complete for batch batch-b/u);
	assert.deepEqual(marked, ["batch-a", "batch-b"]);
	assert.deepEqual(h.notices, ["[Collected] 2 batch(es)"]);
	assert.ok(result.record.executed && "runIds" in result.record.executed);
	assert.deepEqual(result.record.executed.runIds, ["batch-a", "batch-b"]);
	const next = await h.runner.run(input());
	assert.deepEqual(next.record.decision, { kind: "none", reason: "nothing-finished" });
});
