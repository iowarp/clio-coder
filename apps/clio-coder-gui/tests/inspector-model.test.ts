import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedCount } from "../client/design/facts-model.js";
import { toolCandidateNote, toolResolution } from "../client/pages/toolchain-model.js";
import { histogram, orderedPhases, runTone, runTotals } from "../client/pages/traces/trace-model.js";
import type { TracePhase, TraceRun } from "../contracts/traces.js";

const tool = (supported: boolean, source: "path" | "vendored" | "none") => ({
	supported,
	resolution: {
		source,
		binaryPath: null,
		version: null,
		description: "",
		vendoredPath: null,
		pathCandidate: null,
	},
});

test("a tool's resolution is a deliberate three-way split, and an unsupported platform is not a failure", () => {
	assert.deepEqual(toolResolution(tool(false, "none")), { label: "Platform unsupported", tone: "neutral" });
	// An unsupported platform stays neutral even when a copy happens to resolve.
	assert.deepEqual(toolResolution(tool(false, "path")), { label: "Platform unsupported", tone: "neutral" });
	assert.deepEqual(toolResolution(tool(true, "path")), { label: "Using PATH", tone: "success" });
	assert.deepEqual(toolResolution(tool(true, "vendored")), { label: "Using pinned copy", tone: "success" });
	assert.deepEqual(toolResolution(tool(true, "none")), { label: "Not available", tone: "warn" });
});

test("a PATH copy that lost to the pin says why", () => {
	const base = tool(true, "vendored");
	assert.equal(toolCandidateNote(base), null);
	assert.equal(
		toolCandidateNote({
			resolution: {
				...base.resolution,
				pathCandidate: { path: "/usr/bin/herdr", version: "0.1.0", satisfiesMinimum: false },
			},
		}),
		"A copy at /usr/bin/herdr reports 0.1.0, which is below the pinned minimum, so Clio does not use it.",
	);
	assert.equal(
		toolCandidateNote({
			resolution: {
				...base.resolution,
				pathCandidate: { path: "/usr/bin/herdr", version: "9.9.9", satisfiesMinimum: true },
			},
		}),
		null,
	);
});

test("an offline inventory reports a capability or says it did not, and never reads as a limit of zero", () => {
	assert.equal(reportedCount(200_000), "200,000");
	assert.equal(reportedCount(0), "Not reported");
	assert.equal(reportedCount(null), "Not reported");
	assert.equal(reportedCount(undefined), "Not reported");
	assert.equal(reportedCount(Number.NaN), "Not reported");
});

const run = (over: Partial<TraceRun> = {}): TraceRun => ({
	run_id: "run-0",
	assignment_id: "a-0",
	request: "Inspect fixture 0",
	status: "success",
	agent: "coder",
	target: "local",
	model: "model-a",
	runtime: "openai",
	node: null,
	started_at: "2026-09-20T10:00:00.000Z",
	ended_at: "2026-09-20T10:00:30.000Z",
	total_tokens: 4200,
	total_cost_usd: 0,
	source: "dispatch",
	...over,
});

test("a run's four totals are tokens, cost, wall time and the runtime that produced them", () => {
	assert.deepEqual(runTotals(run(), Date.parse("2026-09-20T10:05:00.000Z")), [
		{ label: "Tokens", value: "4,200" },
		// A local runtime that prices at zero is not a run whose cost was never recorded.
		{ label: "Cost", value: "$0.00" },
		{ label: "Wall time", value: "30s" },
		{ label: "Runtime", value: "openai" },
	]);
	// A live run measures against now, not against a missing end.
	const live = runTotals(
		run({ ended_at: null, total_tokens: null, total_cost_usd: null }),
		Date.parse("2026-09-20T10:01:00.000Z"),
	);
	assert.deepEqual(live.slice(0, 3), [
		{ label: "Tokens", value: "not recorded" },
		{ label: "Cost", value: "not recorded" },
		{ label: "Wall time", value: "1m 0s" },
	]);
});

test("run status keeps the trace database's own vocabulary on the shared ramp", () => {
	assert.equal(runTone("success"), "success");
	assert.equal(runTone("fail"), "fail");
	assert.equal(runTone("queued"), "warn");
	assert.equal(runTone("running"), "running");
	assert.equal(runTone("something-else"), "neutral");
});

test("phases render in their recorded order whatever order the wire returned them in", () => {
	const phase = (seq: number, name: string) => ({ seq, name }) as TracePhase;
	assert.deepEqual(
		orderedPhases([phase(3, "c"), phase(1, "a"), phase(2, "b")]).map((item) => item.name),
		["a", "b", "c"],
	);
	assert.deepEqual(
		orderedPhases([phase(1, "b"), phase(1, "a")]).map((item) => item.name),
		["a", "b"],
		"a tie orders by name so two runs with the same shape render the same",
	);
});

test("a histogram counts kinds, commonest first, and says how many rarer kinds it left out", () => {
	const kinds = ["tool_call", "tool_call", "tool_call", "error", "message", "message"];
	const { rows, omitted } = histogram(kinds);
	assert.deepEqual(rows, [
		{ label: "tool_call", count: 3, share: 1 },
		{ label: "message", count: 2, share: 2 / 3 },
		{ label: "error", count: 1, share: 1 / 3 },
	]);
	assert.equal(omitted, "");

	const wide = histogram(["a", "b", "c", "d"], 2);
	assert.deepEqual(
		wide.rows.map((row) => row.label),
		["a", "b"],
	);
	assert.equal(wide.omitted, "2 more kinds are outside this bounded view.");
	assert.deepEqual(histogram([]).rows, []);
});
