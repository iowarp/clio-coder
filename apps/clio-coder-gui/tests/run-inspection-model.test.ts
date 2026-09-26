import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceDestination, listDestination, matchesText } from "../client/pages/run-inspection-model.js";
import { phasePosition, runTotals } from "../client/pages/traces/trace-model.js";
import type { TracePhase, TraceRun } from "../contracts/traces.js";

const run = {
	started_at: "2026-09-26T10:00:00Z",
	ended_at: "2026-09-26T10:01:00Z",
	status: "success",
	total_tokens: null,
	total_cost_usd: null,
	runtime: "worker",
} as TraceRun;
const phase = {
	started_at: "2026-09-26T10:00:15Z",
	ended_at: "2026-09-26T10:00:30Z",
	status: "success",
} as TracePhase;
const now = Date.parse("2026-09-26T10:02:00Z");

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

test("finished records without an end retain unknown wall time and accounting", () => {
	const totals = runTotals({ ...run, ended_at: null }, now);
	assert.equal(totals.find((total) => total.label === "Wall time")?.value, "not recorded");
	assert.equal(totals.find((total) => total.label === "Cost")?.value, "not recorded");
	assert.equal(totals.find((total) => total.label === "Tokens")?.value, "not recorded");
	assert.equal(runTotals({ ...run, ended_at: null, status: "running" }, now)[2]?.value, "2m 0s");
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
