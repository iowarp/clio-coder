import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceDestination, listDestination, matchesText } from "../client/pages/run-inspection-model.js";
import { phasePosition, runTotals } from "../client/pages/traces/trace-model.js";
import { NOT_JOURNALED } from "../client/telemetry/quantity-model.js";
import type { TracePhase, TraceRun } from "../contracts/traces.js";

const run = {
	started_at: "2026-09-26T10:00:00Z",
	ended_at: "2026-09-26T10:01:00Z",
	status: "success",
	telemetry: null,
	runtime: "worker",
} as TraceRun;
const phase = {
	started_at: "2026-09-26T10:00:15Z",
	ended_at: "2026-09-26T10:00:30Z",
	status: "success",
} as TracePhase;
const now = Date.parse("2026-09-26T10:02:00Z");
/** A run row as the read model serves it: every quantity already carries its display (#434). */
const journaled = (tokens: string, usd: string, apiCalls: string): NonNullable<TraceRun["telemetry"]> => {
	const quantity = (display: string, metric: string) => ({
		fact: {
			measured: 0,
			estimated: 0,
			unknownCount: 1,
			absentCount: 0,
			coverage: { measured: 0, estimated: 0, unknown: 1 },
		},
		display,
		ref: `run:run-0#${metric}`,
	});
	return {
		runId: "run-0",
		sessionId: null,
		firstAt: null,
		lastAt: null,
		terminalReason: null,
		source: "calls",
		apiCalls: quantity(apiCalls, "apiCalls"),
		tokens: quantity(tokens, "total"),
		usd: quantity(usd, "usd"),
	};
};

test("trace geometry uses recorded timestamps and refuses to invent missing phase timing", () => {
	assert.deepEqual(phasePosition(phase, run, now), { left: 25, width: 25, duration: 15000 });
	assert.equal(phasePosition({ ...phase, started_at: null }, run, now), null);
	assert.equal(phasePosition({ ...phase, ended_at: null }, run, now), null);
	assert.equal(phasePosition(phase, { ...run, ended_at: null }, now), null);
	assert.equal(phasePosition({ ...phase, ended_at: null, status: "running" }, run, now), null);
	assert.equal(phasePosition({ ...phase, ended_at: "2026-09-26T10:00:00Z" }, run, now), null);
	assert.equal(phasePosition({ ...phase, started_at: "invalid" }, run, now), null);
	const activeRun = { ...run, ended_at: null, status: "running" };
	assert.deepEqual(phasePosition({ ...phase, ended_at: null, status: "running" }, activeRun, now), {
		left: 12.5,
		width: 87.5,
		duration: 105000,
	});
	const beyond = { ...phase, started_at: "2026-09-26T10:02:00Z", ended_at: "2026-09-26T10:03:00Z" };
	assert.deepEqual(phasePosition(beyond, run, now), { left: 100, width: 0, duration: 60000 });
});

test("finished records without an end retain unknown wall time, and a row without a journal says so", () => {
	const totals = runTotals({ ...run, ended_at: null }, now);
	assert.equal(totals.find((total) => total.label === "Wall time")?.value, "not recorded");
	assert.equal(totals.find((total) => total.label === "Cost")?.value, NOT_JOURNALED);
	assert.equal(totals.find((total) => total.label === "Tokens")?.value, NOT_JOURNALED);
	assert.equal(runTotals({ ...run, ended_at: null, status: "running" }, now)[3]?.value, "2m 0s");
});

test("trace detail totals show the journal's displays verbatim, partial and estimate marks included", () => {
	const totals = runTotals({ ...run, telemetry: journaled("≥24 (1 call unknown)", "~$0.25 +?", "2") }, now);
	assert.deepEqual(
		totals.slice(0, 3).map((total) => total.value),
		["≥24 (1 call unknown)", "~$0.25 +?", "2"],
	);
});

test("list navigation preserves owned filters and never propagates launch credentials", () => {
	const search = new URLSearchParams({
		q: "a/b & model",
		source: "dispatch",
		status: "fail",
		phase: "phase-1",
		token: "private",
	});
	const destination = listDestination("/traces", search, ["q", "source", "status"]);
	assert.equal(destination, "/traces?q=a%2Fb+%26+model&source=dispatch&status=fail");
	assert.doesNotMatch(destination, /token|private|phase/);
	assert.equal(listDestination("/fleet", new URLSearchParams(), ["q", "status"]), "/fleet");
	assert.equal(evidenceDestination("run a/b"), "/evidence?run=run+a%2Fb");
});

test("loaded artifact discovery is case-insensitive and requires every search term", () => {
	assert.equal(matchesText(" WORKER model ", ["worker-42", "Model-A", null]), true);
	assert.equal(matchesText("worker unknown", ["worker-42", "model-a"]), false);
	assert.equal(matchesText("", [undefined]), true);
});
