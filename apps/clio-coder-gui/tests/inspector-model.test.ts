import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedCount } from "../client/design/facts-model.js";
import { toolCandidateNote, toolResolution } from "../client/pages/toolchain-model.js";
import { histogram, runTone, runTotals } from "../client/pages/traces/trace-model.js";
import type { TraceRun } from "../contracts/traces.js";

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

/** A run row as the read model serves it: every quantity already carries its display (#434). */
const journaled = (tokens: string, usd: string, apiCalls: string): TraceRun["telemetry"] => {
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
		turnId: null,
		firstAt: "2026-09-20T10:00:00.000Z",
		lastAt: "2026-09-20T10:00:30.000Z",
		terminalReason: null,
		source: "calls",
		apiCalls: quantity(apiCalls, "apiCalls", 1),
		tokens: quantity(tokens, "total", 4200),
		usd: quantity(usd, "usd", 0),
	};
};
const run = (over: Partial<TraceRun> = {}): TraceRun => ({
	runId: "run-0",
	status: "success",
	writtenAt: "2026-09-20T10:00:30.000Z",
	identity: {
		agentId: "coder",
		task: "Inspect fixture 0",
		targetId: "local",
		model: "model-a",
		runtimeId: "openai",
		node: null,
		status: "completed",
		outcome: "succeeded",
		startedAt: "2026-09-20T10:00:00.000Z",
		endedAt: "2026-09-20T10:00:30.000Z",
		sessionId: null,
		parentRunId: null,
		rootRunId: null,
	},
	telemetry: journaled("4,200", "$0.00 local", "1"),
	...over,
});

test("a run's totals are its journal's tokens, cost and model calls, then wall time and the runtime", () => {
	assert.deepEqual(runTotals(run(), undefined, Date.parse("2026-09-20T10:05:00.000Z")), [
		{ label: "Tokens", value: "4,200", ref: "run:run-0#total" },
		{ label: "Cost", value: "$0.00 local", ref: "run:run-0#usd" },
		{ label: "Model calls", value: "1", ref: "run:run-0#apiCalls" },
		{ label: "Wall time", value: "30s", ref: null },
		{ label: "Runtime", value: "openai", ref: null },
	]);
	// A live run measures against now; a run the ledger does not hold spans its journal and names no runtime.
	const base = run();
	const live = runTotals(
		run({ status: "running", identity: base.identity ? { ...base.identity, endedAt: null } : null }),
		undefined,
		Date.parse("2026-09-20T10:01:00.000Z"),
	);
	assert.deepEqual(live[3], { label: "Wall time", value: "1m 0s", ref: null });
	assert.deepEqual(runTotals(run({ identity: null }), undefined, 0).slice(3), [
		{ label: "Wall time", value: "30s", ref: null },
		{ label: "Runtime", value: "not recorded", ref: null },
	]);
});

test("run status reads on the shared ramp, and an unknown status is neither success nor failure", () => {
	assert.equal(runTone("success"), "success");
	assert.equal(runTone("fail"), "fail");
	assert.equal(runTone("queued"), "warn");
	assert.equal(runTone("running"), "running");
	assert.equal(runTone("unknown"), "neutral");
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
