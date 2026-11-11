import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { admitCompactionSummaryCall } from "../../src/domains/session/compaction/flow.js";
import type { AdmissionHold } from "../../src/domains/telemetry/call-scope.js";

it("a compaction summary call is checked against the session cost ceiling whatever its route's pricing", async () => {
	let checked = 0;
	const scheduling = {
		admitPaidRequest: async (options: { onBlocked?: (block: never) => void; getCeilingUsd?: () => number }) => {
			checked += 1;
			strictEqual(options.getCeilingUsd?.(), 2);
			options.onBlocked?.({} as never);
		},
	} as unknown as SchedulingContract;
	const hold: AdmissionHold = {};
	await admitCompactionSummaryCall({ scheduling, headless: true, getCeilingUsd: () => 2 }, hold);
	strictEqual(checked, 1);
	strictEqual(hold.waitedOn, "budget");
});
