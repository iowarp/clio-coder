import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceDestination, listDestination, matchesText } from "../client/pages/run-inspection-model.js";
import { callPosition, runTotals, stageBars } from "../client/pages/traces/trace-model.js";
import type { TraceRun } from "../contracts/traces.js";
import type { RunTimelineEntry } from "../contracts/wire.js";

/** A run row as the read model serves it: every quantity already carries its display (#434). */
const journaled = (tokens: string, usd: string, apiCalls: string): TraceRun["telemetry"] => {
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
		firstAt: "2026-09-26T10:00:00Z",
		lastAt: null,
		terminalReason: null,
		source: "calls",
		apiCalls: quantity(apiCalls, "apiCalls"),
		tokens: quantity(tokens, "total"),
		usd: quantity(usd, "usd"),
	};
};
const run: TraceRun = {
	runId: "run-0",
	status: "success",
	writtenAt: null,
	identity: {
		agentId: "coder",
		task: "Inspect",
		targetId: "local",
		model: "m",
		runtimeId: "worker",
		node: null,
		status: "completed",
		outcome: null,
		startedAt: "2026-09-26T10:00:00Z",
		endedAt: "2026-09-26T10:01:00Z",
		sessionId: null,
		parentRunId: null,
		rootRunId: null,
	},
	telemetry: journaled("not journaled", "not journaled", "not journaled"),
};
const identity = run.identity as NonNullable<TraceRun["identity"]>;
const now = Date.parse("2026-09-26T10:02:00Z");
const call = {
	kind: "call",
	at: "2026-09-26T10:00:15Z",
	endAt: "2026-09-26T10:00:30Z",
	disposition: "settled",
	stages: { admission: { start: 0, end: 1500 }, send: { start: 1500, end: 3000 }, firstToken: 6000, settle: 15000 },
} as unknown as Extract<RunTimelineEntry, { kind: "call" }>;

test("call geometry uses recorded times and offsets and refuses to invent missing timing", () => {
	const span = { start: Date.parse("2026-09-26T10:00:00Z"), end: Date.parse("2026-09-26T10:01:00Z") };
	assert.deepEqual(callPosition(call, span, now), { left: 25, width: 25 });
	assert.equal(callPosition({ ...call, endAt: null }, span, now), null);
	assert.equal(callPosition({ ...call, at: "invalid" }, span, now), null);
	assert.deepEqual(callPosition({ ...call, endAt: null, disposition: "incomplete" }, span, now), {
		left: 25,
		width: 75,
	});
	assert.deepEqual(
		stageBars(call).map((bar) => [bar.stage, bar.left, bar.width]),
		[
			["admission", 0, 10],
			["send", 10, 10],
			["model", 40, 60],
		],
	);
	assert.deepEqual(stageBars({ ...call, stages: null }), []);
	assert.deepEqual(stageBars({ ...call, stages: { ...call.stages, settle: null } as typeof call.stages }), []);
});

test("finished records without an end retain unknown wall time, and a live run measures to now", () => {
	const ended = { ...run, identity: { ...identity, endedAt: null } };
	assert.equal(runTotals(ended, undefined, now).find((total) => total.label === "Wall time")?.value, "not recorded");
	assert.equal(runTotals({ ...ended, status: "running" }, undefined, now)[3]?.value, "2m 0s");
});

test("trace detail totals show the journal's displays verbatim, partial and estimate marks included", () => {
	const totals = runTotals({ ...run, telemetry: journaled("≥24 (1 call unknown)", "~$0.25 +?", "2") }, undefined, now);
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
