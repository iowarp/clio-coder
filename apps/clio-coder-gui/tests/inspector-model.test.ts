import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedCount } from "../client/design/facts-model.js";
import { toolCandidateNote, toolResolution } from "../client/pages/toolchain-model.js";
import { histogram, orderedPhases, runTone, runTotals } from "../client/pages/traces/trace-model.js";
import { NOT_JOURNALED } from "../client/telemetry/quantity-model.js";
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
	telemetry: null,
	source: "dispatch",
	...over,
});

/** A run row as the read model serves it: every quantity already carries its display (#434). */
const journaled = (tokens: string, usd: string, apiCalls: string): NonNullable<TraceRun["telemetry"]> => {
	const quantity = (display: string, metric: string, value: number) => ({
		fact: {
			measured: value,
			estimated: 0,
			unknownCount: 0,
			absentCount: 0,
			coverage: { measured: 1, estimated: 0, unknown: 0 },
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
		apiCalls: quantity(apiCalls, "apiCalls", 1),
		tokens: quantity(tokens, "total", 4200),
		usd: quantity(usd, "usd", 0),
	};
};

test("a run's totals are its journal's tokens, cost and model calls, then wall time and the runtime", () => {
	assert.deepEqual(
		runTotals(run({ telemetry: journaled("4,200", "$0.00 local", "1") }), Date.parse("2026-09-20T10:05:00.000Z")),
		[
			{ label: "Tokens", value: "4,200" },
			{ label: "Cost", value: "$0.00 local" },
			{ label: "Model calls", value: "1" },
			{ label: "Wall time", value: "30s" },
			{ label: "Runtime", value: "openai" },
		],
	);
	// A live run measures against now, not against a missing end; a session row has no run journal to show.
	const live = runTotals(
		run({ status: "running", ended_at: null, source: "session" }),
		Date.parse("2026-09-20T10:01:00.000Z"),
	);
	assert.deepEqual(live.slice(0, 4), [
		{ label: "Tokens", value: NOT_JOURNALED },
		{ label: "Cost", value: NOT_JOURNALED },
		{ label: "Model calls", value: NOT_JOURNALED },
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
