import assert from "node:assert/strict";
import { test } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
	claimsWorkerResults,
	createDetachedDispatchNudgeRegistration,
	finishedDetachedBatchIds,
} from "../../src/domains/middleware/dispatch-nudge.js";
import { fixtureEnvelope } from "../harness/receipt.js";

test("finished detached batches retain ownership filtering and request continuation without reminder text", () => {
	const dispatch = {
		owner: () => ({ sessionId: "owner", cwd: "/workspace" }),
		getRun: () => fixtureEnvelope(),
		detached: {
			list: () => [
				{ id: "owned", sessionId: "owner", runs: [{ runId: "done" }] },
				{ id: "foreign", sessionId: "other", runs: [{ runId: "done" }] },
			],
		},
	} as unknown as DispatchContract;
	assert.deepEqual(finishedDetachedBatchIds(dispatch), ["owned"]);
	const registration = createDetachedDispatchNudgeRegistration({
		getOpenBatches: () => [{ id: "owned", total: 1, terminal: 1 }],
	});
	const effects = registration.evaluate?.({
		hook: "turn_end",
		metadata: { stopReason: "stop", activeCapabilityNames: "monitor" },
	});
	assert.deepEqual(
		effects?.map((effect) => effect.kind),
		["request_continuation"],
	);
});

test("worker result claims need a definite worker and a result, not an explanation of dispatch", () => {
	assert.equal(claimsWorkerResults("The scout found three issues in src/a.ts."), true);
	assert.equal(claimsWorkerResults("## Scout Shadow Report\nfindings follow"), true);
	assert.equal(
		claimsWorkerResults(
			"A worker returns a receipt when it has completed; the coordinator reads the worker summary then.",
		),
		false,
	);
	assert.equal(claimsWorkerResults("When the worker has completed, results arrive through monitor."), false);
	assert.equal(claimsWorkerResults("Workers report findings to the coordinator."), false);
});
