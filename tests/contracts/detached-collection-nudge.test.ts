import assert from "node:assert/strict";
import { test } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
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
