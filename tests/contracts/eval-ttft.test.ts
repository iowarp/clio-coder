import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { projectHeadlessJsonEvent } from "../../src/cli/modes/json-stream.js";
import { aggregateEvalVerdicts } from "../../src/domains/eval/metrics/aggregate.js";
import { createEvalCallLedgerFold } from "../../src/domains/eval/metrics/call-ledger-stream.js";
import {
	buildEvalTrackedMetrics,
	emptyEvalTrackedMetrics,
	readEvalLedgerSnapshot,
} from "../../src/domains/eval/metrics/tracked.js";
import { adaptSuiteV2ResultToVerdictV1 } from "../../src/domains/eval/schema/adapter.js";
import { parseEvalVerdictEnvelopeV1 } from "../../src/domains/eval/schema/verdict.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const USAGE = { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };

function call(id: string, timestamp: string, timing: unknown): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId: id,
		parentTurnId: null,
		timestamp,
		payload: { usage: USAGE, ...(timing === undefined ? {} : { timing }) },
	};
}

function metrics(entries: SessionEntry[]) {
	return buildEvalTrackedMetrics({ ledgerEntries: entries, receipt: null, fallbackWallClockMs: 300 });
}

const EARLY = "2026-09-04T01:00:00.000Z";
const LATE = "2026-09-04T02:00:00.000Z";

test("TTFT preserves absent, malformed and measured-zero readings", () => {
	for (const timing of [undefined, null, {}, { ttftMs: null }, { ttftMs: -1 }, { ttftMs: Number.NaN }]) {
		assert.deepEqual(metrics([call("first", EARLY, timing)]).ttftMsFirstCall, { value: null, source: "estimated" });
	}
	assert.deepEqual(metrics([]).ttftMsFirstCall, { value: null, source: "estimated" });
	assert.deepEqual(emptyEvalTrackedMetrics().ttftMsFirstCall, { value: null, source: "estimated" });
	assert.deepEqual(metrics([call("first", EARLY, { ttftMs: 0 })]).ttftMsFirstCall, { value: 0, source: "ledger" });
});

test("TTFT chooses the chronological first call and never borrows a later timing", () => {
	const later = call("later", LATE, { ttftMs: 91 });
	const first = call("first", EARLY, { ttftMs: 17 });
	const entries = [later, first];
	assert.deepEqual(metrics(entries).ttftMsFirstCall, { value: 17, source: "ledger" });
	assert.equal(entries[0], later, "metric collection must not reorder the caller's evidence");
	assert.deepEqual(metrics([later, call("first", EARLY, null)]).ttftMsFirstCall, { value: null, source: "estimated" });
	assert.deepEqual(metrics([first, call("same-time", EARLY, { ttftMs: 99 })]).ttftMsFirstCall, {
		value: 17,
		source: "ledger",
	});
	assert.deepEqual(metrics([first, call("unknown-order", "invalid", { ttftMs: 99 })]).ttftMsFirstCall, {
		value: null,
		source: "estimated",
	});
});

test("TTFT chronology crosses session-directory order", async () => {
	const env = await isolateClioEnv("clio-eval-ttft-");
	try {
		for (const [sessionId, entries] of [
			["a-later-session", [call("late", LATE, { ttftMs: 91 })]],
			["z-earlier-session", [call("middle", "2026-09-04T01:30:00.000Z", { ttftMs: 50 }), call("early", EARLY, null)]],
		] as const) {
			const directory = join(env.dir, "state", "sessions", "workspace", sessionId);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "current.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
		}
		const snapshot = await readEvalLedgerSnapshot(join(env.dir, "state"));
		assert.equal(snapshot.entries.length, 3);
		assert.equal(snapshot.entries[0]?.turnId, "late");
		assert.deepEqual(metrics(snapshot.entries).ttftMsFirstCall, { value: null, source: "estimated" });
	} finally {
		env.restore();
	}
});

test("TTFT null survives verdict adaptation, JSON parsing and aggregation beside legacy zero", () => {
	const result = {
		assignmentId: null,
		terminalReceiptDigest: null,
		taskId: "ttft",
		repeatIndex: 0,
		pass: true,
		failureClass: null,
		metrics: {},
	};
	const absent = adaptSuiteV2ResultToVerdictV1(result, metrics([call("first", EARLY, null)]));
	const zero = adaptSuiteV2ResultToVerdictV1(
		{ ...result, repeatIndex: 1 },
		metrics([call("first", EARLY, { ttftMs: 0 })]),
	);
	const parsed = parseEvalVerdictEnvelopeV1(JSON.parse(JSON.stringify(absent)));
	assert.deepEqual(parsed.trackedMetrics.ttftMsFirstCall, { value: null, source: "estimated" });
	const legacy = structuredClone(zero);
	legacy.trackedMetrics.ttftMsFirstCall.source = "estimated";
	assert.deepEqual(parseEvalVerdictEnvelopeV1(legacy).trackedMetrics.ttftMsFirstCall, { value: 0, source: "estimated" });
	const aggregate = aggregateEvalVerdicts([parsed, zero])[0]?.trackedMetrics.ttftMsFirstCall;
	assert.ok(aggregate);
	assert.equal(aggregate.measured, 1);
	assert.equal(aggregate.unmeasured, 1);
	assert.equal(aggregate.mean, 0);
	assert.equal(aggregate.variance, 0);
	const onlyAbsent = aggregateEvalVerdicts([parsed])[0]?.trackedMetrics.ttftMsFirstCall;
	assert.equal(onlyAbsent?.mean, null);
	assert.equal(onlyAbsent?.variance, null);
});

function foldEvents(events: Array<[number, Record<string, unknown>]>, project = false) {
	let clock = 0;
	const fold = createEvalCallLedgerFold(() => clock);
	for (const [at, event] of events) {
		clock = at;
		const output = project ? projectHeadlessJsonEvent(event as unknown as ChatLoopEvent) : event;
		if (output !== null) fold.push(`${JSON.stringify(output)}\n`);
	}
	return fold.entries();
}

const START = { type: "message_start", message: { role: "assistant" } };
const END = { type: "message_end", message: { role: "assistant", timestamp: Date.parse(EARLY), usage: USAGE } };

test("stream completions without message_start carry no invented timing", () => {
	const entries = foldEvents([
		[50, { type: "text_delta", delta: "orphan output" }],
		[100, END],
	]);
	assert.equal(entries.length, 1);
	assert.deepEqual((entries[0] as { payload: Record<string, unknown> }).payload.timing, null);
	assert.deepEqual(metrics(entries).ttftMsFirstCall, { value: null, source: "estimated" });
});

test("missing stream timestamps cannot promote a later timing to first-call TTFT", () => {
	for (const timestamp of [undefined, null, -1, "invalid"]) {
		const entries = foldEvents([
			[10, START],
			[20, { type: "text_delta", delta: "first" }],
			[30, END],
			[40, START],
			[60, { type: "text_delta", delta: "later" }],
			[70, { ...END, message: { ...END.message, timestamp } }],
		]);
		assert.deepEqual(metrics(entries).ttftMsFirstCall, { value: null, source: "estimated" });
		assert.deepEqual((entries[0] as { payload: Record<string, unknown> }).payload.timing, { ttftMs: 10, apiMs: 20 });
		assert.deepEqual((entries[1] as { payload: Record<string, unknown> }).payload.timing, { ttftMs: 20, apiMs: 30 });
	}
});

test("stream TTFT requires observed output and ignores structural updates and empty deltas", () => {
	const entries = foldEvents([
		[10, START],
		[15, { type: "message_update", assistantMessageEvent: { type: "start" } }],
		[20, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } }],
		[25, { type: "thinking_delta", delta: "" }],
		[80, END],
	]);
	assert.deepEqual((entries[0] as { payload: Record<string, unknown> }).payload.timing, { ttftMs: null, apiMs: 70 });
	assert.deepEqual(metrics(entries).ttftMsFirstCall, { value: null, source: "estimated" });
});

test("actual headless JSON projection supplies text/thinking timing and retains measured zero", () => {
	for (const type of ["text_delta", "thinking_delta"]) {
		for (const elapsed of [0, 23]) {
			const entries = foldEvents(
				[
					[10, START],
					[10, { type: "message_update", assistantMessageEvent: { type, delta: "hidden snapshot" } }],
					[10 + elapsed, { type, contentIndex: 0, delta: "observed output" }],
					[90, END],
				],
				true,
			);
			assert.deepEqual(metrics(entries).ttftMsFirstCall, { value: elapsed, source: "ledger" });
			assert.deepEqual((entries[0] as { payload: Record<string, unknown> }).payload.timing, {
				ttftMs: elapsed,
				apiMs: 80,
			});
		}
	}
});

test("worker stream output uses actual delta types and each completion resets timing", () => {
	for (const type of ["text_delta", "thinking_delta", "toolcall_start", "toolcall_delta"]) {
		const entries = foldEvents([
			[10, START],
			[35, { type: "message_update", assistantMessageEvent: { type, delta: "output" } }],
			[90, END],
			[100, END],
		]);
		assert.deepEqual((entries[0] as { payload: Record<string, unknown> }).payload.timing, { ttftMs: 25, apiMs: 80 });
		assert.deepEqual((entries[1] as { payload: Record<string, unknown> }).payload.timing, null);
	}
});
