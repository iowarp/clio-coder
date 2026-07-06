import { ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { finalizeObservation, OBSERVATION_TURN_BUDGET_ENV, reserveObservation } from "../../src/tools/observation.js";

// Regression for the v0.2.8 demo session: ~28 docs searches drained the shared
// per-turn pool, after which every JSON observation collapsed to a bare
// `{"error":"result exceeded 2.9KB"}` stub. The stub read as a transient size
// error and invited a retry that could never fit (the pool only shrinks within
// a turn), and the envelope still claimed sections were shown, so the model
// retried into the loop guard while the operator saw "5/288 sections OK" rows
// for zero-content results.

function jsonBody(bytes: number): string {
	return JSON.stringify({ results: "x".repeat(bytes) });
}

describe("contracts/observation JSON cap stub", () => {
	afterEach(() => {
		delete process.env[OBSERVATION_TURN_BUDGET_ENV];
	});

	it("carries the budget directive and drops the continuation when the pool bound the call", () => {
		process.env[OBSERVATION_TURN_BUDGET_ENV] = String(8 * 1024);
		const options = { sessionId: "s-json-stub", turnId: `turn-pool-${Date.now()}`, toolCallId: "ctx-1" };
		const reservation = reserveObservation(16 * 1024, options);
		ok(reservation.limited, "an 8KB pool must bound a 16KB self cap");
		const result = finalizeObservation({
			tool: "context",
			unit: "sections",
			format: "json",
			output: jsonBody(12 * 1024),
			shownCount: 5,
			totalCount: 288,
			truncated: false,
			next: "limit=3",
			reservation,
			options,
		});
		strictEqual(result.kind, "ok");
		const stub = JSON.parse(result.kind === "ok" ? result.output : "{}") as {
			error?: string;
			budget?: string;
			next?: string;
		};
		ok(stub.error?.includes("result exceeded"), "still names the exceeded cap");
		ok(stub.budget?.includes("observation budget"), "says the shared pool is the constraint");
		ok(stub.budget?.includes("Do not retry"), "directs the model away from the retry spiral");
		strictEqual(stub.next, undefined, "no continuation: nothing narrower can fit this turn");
		const observation = result.details?.observation as { shownCount?: number; truncated?: boolean } | undefined;
		strictEqual(observation?.shownCount, 0, "the stub showed the model nothing");
		strictEqual(observation?.truncated, true);
	});

	it("keeps the narrowing continuation when only the tool's self cap was exceeded", () => {
		process.env[OBSERVATION_TURN_BUDGET_ENV] = String(1024 * 1024);
		const options = { sessionId: "s-json-stub", turnId: `turn-selfcap-${Date.now()}`, toolCallId: "ctx-2" };
		const reservation = reserveObservation(2 * 1024, options);
		strictEqual(reservation.limited, false, "a huge pool leaves the self cap binding");
		const result = finalizeObservation({
			tool: "code_nav",
			unit: "results",
			format: "json",
			output: jsonBody(4 * 1024),
			shownCount: 9,
			totalCount: 9,
			truncated: false,
			next: "limit=4",
			reservation,
			options,
		});
		strictEqual(result.kind, "ok");
		const stub = JSON.parse(result.kind === "ok" ? result.output : "{}") as {
			error?: string;
			budget?: string;
			next?: string;
		};
		ok(stub.error?.includes("result exceeded"), "names the exceeded cap");
		strictEqual(stub.budget, undefined, "no budget directive when the pool is not the constraint");
		strictEqual(stub.next, "limit=4", "the tool's own narrowing continuation survives");
		const observation = result.details?.observation as { shownCount?: number } | undefined;
		strictEqual(observation?.shownCount, 0, "a stub never claims items were shown");
	});
});
