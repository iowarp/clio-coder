import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addFleetLoopObservations,
	createFleetLoopFold,
	fleetLoopMetricEntries,
	fleetLoopReceiptAgreement,
} from "../../src/domains/eval/metrics/fleet-loop-stream.js";

interface LoopLine {
	loopId: string;
	resolved: boolean;
	attempts: number;
	repairs: number;
	reason: string;
}

/** The one summary line `clio fleet run --json` writes at the end of a run. */
function fleetSummary(loops: LoopLine[], extra: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		fleet: "bounded-repair",
		rootId: "fleet-abc",
		planHash: "h".repeat(64),
		loops,
		revalidated: [],
		unneeded: [],
		skipped: [],
		needsDecision: [],
		writeBoundaries: [],
		...extra,
	})}\n`;
}

function metricsFor(stdout: string): Record<string, number | boolean> {
	const fold = createFleetLoopFold();
	fold.push(stdout);
	return fleetLoopMetricEntries(fold.observation());
}

describe("contracts/eval fleet loop metrics", () => {
	it("reads a resolved loop's attempts, repairs, and unneeded nodes", () => {
		const metrics = metricsFor(
			fleetSummary([{ loopId: "repair", resolved: true, attempts: 2, repairs: 1, reason: "resolved" }], {
				unneeded: ["repair.check.3", "repair.repair.2"],
			}),
		);

		strictEqual(metrics["loop.count"], 1);
		strictEqual(metrics["loop.attemptsSpent"], 2);
		strictEqual(metrics["loop.repairsSpent"], 1);
		strictEqual(metrics["loop.resolved"], true);
		strictEqual(metrics["loop.reasonExhausted"], true);
		strictEqual(metrics["loop.unneededNodes"], 2, "a resolved loop's later nodes are unneeded, never skipped");
		strictEqual(metrics["loop.skippedNodes"], 0);
	});

	it("reads a spent bound as a correct machinery result rather than a failure", () => {
		// Three verifications, two repairs, still red. The bound was respected and
		// the terminal report says so; nothing here is a machinery failure.
		const metrics = metricsFor(
			fleetSummary([{ loopId: "repair", resolved: false, attempts: 3, repairs: 2, reason: "loop_bound_exhausted" }]),
		);

		strictEqual(metrics["loop.attemptsSpent"], 3);
		strictEqual(metrics["loop.repairsSpent"], 2);
		strictEqual(metrics["loop.resolved"], false);
		strictEqual(metrics["loop.reasonExhausted"], true);
	});

	it("fails loop.reasonExhausted when an unresolved loop reports anything but a spent bound", () => {
		// A loop that stopped for another reason spent its bound on nothing. A
		// true here would report a bound honoured that was never reached.
		const metrics = metricsFor(
			fleetSummary([{ loopId: "repair", resolved: false, attempts: 1, repairs: 0, reason: "loop_step_failed" }]),
		);

		strictEqual(metrics["loop.reasonExhausted"], false);
	});

	it("counts nodes the scheduler refused apart from nodes a loop made unnecessary", () => {
		const metrics = metricsFor(
			fleetSummary([{ loopId: "repair", resolved: false, attempts: 1, repairs: 0, reason: "loop_step_failed" }], {
				skipped: ["publish"],
			}),
		);

		strictEqual(metrics["loop.skippedNodes"], 1, "something upstream broke, which is not a loop answering");
		strictEqual(metrics["loop.unneededNodes"], 0);
	});

	it("leaves the loop metrics absent when the stream carried no summary", () => {
		strictEqual(Object.keys(metricsFor("not json\n{}\n")).length, 0);
	});

	it("leaves the loop metrics absent when a summary declared no loop", () => {
		strictEqual(Object.keys(metricsFor(fleetSummary([]))).length, 0);
	});

	it("leaves the loop metrics absent when a malformed loop entry cannot be read", () => {
		// A negative attempt count is not a loop that ran backwards; it is a line
		// this reducer does not understand, and understanding it wrongly would
		// report a bound it never observed.
		const stdout = fleetSummary([]).replace(
			'"loops":[]',
			'"loops":[{"loopId":"repair","resolved":false,"attempts":-1,"repairs":0,"reason":"resolved"}]',
		);
		strictEqual(Object.keys(metricsFor(stdout)).length, 0);
	});

	it("leaves the loop metrics absent when two summaries crossed one stream", () => {
		// Two fleet runs in one item cannot be attributed to one bound.
		const observation = addFleetLoopObservations(
			createFold(fleetSummary([{ loopId: "a", resolved: true, attempts: 1, repairs: 0, reason: "resolved" }])),
			createFold(fleetSummary([{ loopId: "b", resolved: true, attempts: 1, repairs: 0, reason: "resolved" }])),
		);
		strictEqual(Object.keys(fleetLoopMetricEntries(observation)).length, 0);
	});

	it("folds a summary split across arbitrary chunk boundaries", () => {
		const stdout = fleetSummary([{ loopId: "repair", resolved: true, attempts: 2, repairs: 1, reason: "resolved" }]);
		const fold = createFleetLoopFold();
		for (let index = 0; index < stdout.length; index += 11) fold.push(stdout.slice(index, index + 11));

		strictEqual(fleetLoopMetricEntries(fold.observation())["loop.attemptsSpent"], 2);
	});

	it("agrees when every repair sealed its own recovery receipt", () => {
		strictEqual(
			fleetLoopReceiptAgreement({ "loop.repairsSpent": 2 }, { "receipt.recoveryCount": 2 })["loop.receiptsMatchRepairs"],
			true,
		);
	});

	it("fails loop.receiptsMatchRepairs when a repair sealed no recovery receipt", () => {
		// Two repairs beside one recovery receipt either lost a receipt or ran an
		// attempt the loop never reported. Both mean the bound does not mean what
		// it says.
		strictEqual(
			fleetLoopReceiptAgreement({ "loop.repairsSpent": 2 }, { "receipt.recoveryCount": 1 })["loop.receiptsMatchRepairs"],
			false,
		);
	});

	it("leaves the agreement absent when either side was never measured", () => {
		strictEqual(Object.keys(fleetLoopReceiptAgreement({}, { "receipt.recoveryCount": 1 })).length, 0);
		strictEqual(Object.keys(fleetLoopReceiptAgreement({ "loop.repairsSpent": 2 }, {})).length, 0);
	});
});

function createFold(stdout: string): ReturnType<ReturnType<typeof createFleetLoopFold>["observation"]> {
	const fold = createFleetLoopFold();
	fold.push(stdout);
	return fold.observation();
}
