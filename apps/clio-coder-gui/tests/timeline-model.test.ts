import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CacheBreak,
	TIMELINE_KINDS,
	timelineKinds,
	timelinePage,
	timelineRows,
} from "../client/telemetry/timeline-model.js";
import type { Quantity, TimelineEntry } from "../contracts/wire.js";

const unknown = { kind: "unknown", reason: "not-observed" } as const;
const quantity = (display: string, ref: string): Quantity => ({ fact: unknown, display, ref: ref as Quantity["ref"] });
const shown = (display: string, value: number) => ({
	fact: { kind: "measured", value, source: "local-count" } as const,
	display,
});

const call = {
	kind: "call",
	at: "2026-10-30T10:00:01.000Z",
	endAt: "2026-10-30T10:00:03.000Z",
	callId: "call-1",
	attemptId: "attempt-1",
	label: "main",
	turnId: "turn-1",
	runId: null,
	disposition: "settled",
	failure: null,
	stages: { settle: 2000, firstToken: 500, send: { start: 100, end: 200 } },
	timing: {
		ttft: quantity("500ms", "session:s#ttft"),
		modelTime: quantity("1.50s", "session:s#modelTime"),
		settle: quantity("2.00s", "session:s#settle"),
		admissionWait: quantity("none", "session:s#admissionWait"),
	},
	tokens: quantity("~5,050 (chars/4)", "session:s#tokens"),
	usd: quantity("not measured", "session:s#usd"),
	cacheVerdict: "hot",
} as unknown as TimelineEntry;
const entries: TimelineEntry[] = [
	{ kind: "session", at: "2026-10-30T10:00:00.000Z", event: "opened", detail: null },
	call,
	{
		kind: "context",
		at: "2026-10-30T10:00:02.000Z",
		snapshotId: "snap-1",
		source: "reconciled",
		window: {
			desired: 200_000,
			effective: 128_000,
			source: "catalog",
			display: { desired: "200,000", effective: "128,000" },
		},
		estimated: null,
		reconciled: shown("9,342", 9342),
		turnId: "turn-1",
		callId: null,
	},
	{
		kind: "gap",
		at: "2026-10-30T10:00:04.000Z",
		sink: "calls",
		reason: "writer-drop",
		count: 3,
		countShown: shown("3", 3),
	},
	{
		kind: "gap",
		at: "2026-10-30T10:00:04.000Z",
		sink: "calls",
		reason: "torn-tail",
		count: 1,
		countShown: shown("1", 1),
	},
	{
		kind: "turn",
		at: "2026-10-30T10:00:05.000Z",
		turnId: "turn-1",
		stopReason: "error",
		cause: "provider_error",
		stage: "send",
		retries: 2,
		retriesShown: shown("2", 2),
		callIds: [],
	},
] as TimelineEntry[];

test("a timeline row carries the server's words for every figure, and a call's quantities keep their references", () => {
	const rows = timelineRows(entries);
	assert.deepEqual(
		rows.map((row) => row.kind),
		["Session", "Model call", "Context", "Journal gap", "Journal gap", "Turn"],
	);
	const [, model, context, gap, , turn] = rows;
	assert.deepEqual(model?.details.slice(0, 2), [
		{ label: "Tokens", value: "~5,050 (chars/4)", ref: "session:s#tokens" },
		{ label: "Cost", value: "not measured", ref: "session:s#usd" },
	]);
	assert.deepEqual(
		model?.stages.map((bar) => bar.stage),
		["send", "model"],
	);
	assert.deepEqual(
		context?.details.map((detail) => [detail.label, detail.value]),
		[
			["Window", "128,000"],
			["Window asked for", "200,000"],
			["Window from", "catalog"],
			["Provider count", "9,342"],
		],
	);
	assert.deepEqual(gap?.details, [{ label: "Records lost", value: "3", ref: null }]);
	assert.equal(turn?.tone, "fail");
	assert.deepEqual(turn?.details.at(-1), { label: "Retries", value: "2", ref: null });
	// Two entries of a kind at one instant keep distinct keys.
	assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test("a call the cache report lists as a break names its bill and where its prefix diverged", () => {
	const cacheBreak = {
		callId: "call-1",
		attemptId: "attempt-1",
		at: "2026-10-30T10:00:03.000Z",
		verdict: "cold",
		expectedColdReasons: ["prompt_recompiled"],
		firstDivergentSection: { fact: { kind: "measured", value: "memory", source: "provider" }, display: "memory" },
		rePrefilled: quantity("4,000", "session:s#rePrefilled"),
		uncachedPrefill: quantity("4,000", "session:s#uncachedPrefill"),
		breakUsd: quantity("$0.0120", "session:s#breakUsd"),
	} as unknown as CacheBreak;
	const model = timelineRows(entries, [cacheBreak]).find((row) => row.kind === "Model call");
	assert.equal(model?.tone, "warn");
	assert.match(model?.title ?? "", / · cache break$/);
	assert.deepEqual(model?.details.slice(-4), [
		{ label: "Re-prefilled", value: "4,000", ref: "session:s#rePrefilled" },
		{ label: "Break cost", value: "$0.0120", ref: "session:s#breakUsd" },
		{ label: "Diverged at", value: "memory", ref: null },
		{ label: "Expected cold", value: "prompt recompiled", ref: null },
	]);
});

test("the timeline pages newest first, says how many earlier rows a page left out, and filters by kind", () => {
	const rows = timelineRows(entries);
	const first = timelinePage(rows, "", 2);
	assert.deepEqual(
		first.rows.map((row) => row.kind),
		["Turn", "Journal gap"],
	);
	assert.equal(first.earlier, 4);
	const gaps = timelinePage(rows, "Journal gap", 100);
	assert.equal(gaps.rows.length, 2);
	assert.equal(gaps.earlier, 0);
	assert.deepEqual(timelineKinds(rows), ["Model call", "Turn", "Session", "Journal gap", "Context"]);
	assert.equal(Object.keys(TIMELINE_KINDS).length, 16);
});
