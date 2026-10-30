import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { beginCall, recordTelemetry, telemetryProducerHealth } from "../../src/core/telemetry/producer.js";
import { encodeTelemetryLine } from "../../src/core/telemetry/segment.js";
import { openCallJournal, readCallJournal } from "../../src/domains/observability/call-journal.js";
import { createSessionJournals } from "../../src/domains/observability/session-journals.js";
import { checkTelemetryProducer } from "../boundaries/check-boundaries.js";

const context = { sessionId: "journal-session", label: "main" as const };
const writer = { clioVersion: "fixture", piVersion: "fixture" };
const unknown = { kind: "unknown", reason: "not-observed" } as const;
const unsent = {
	disposition: "never_sent" as const,
	usage: null,
	stop: { reason: "aborted" as const, failure: "operator_cancel" as const, detail: "request cancelled" },
	pricing: { usd: { kind: "absent" as const, reason: "not-applicable" as const }, pricedBy: "none" as const },
	transport: { kind: "unknown" as const, continuation: unknown, requestBytes: unknown, sessionPinnedToSse: unknown },
	cache: {
		firstDivergentSection: unknown,
		expectedColdReasons: [],
		rePrefilledTokens: unknown,
		uncachedPrefillTokens: unknown,
		verdict: "unknown" as const,
	},
};

test("producer boundaries reject filesystem helpers and serialization without blocking enqueue", () => {
	strictEqual(checkTelemetryProducer("helper.ts", 'import { open as write } from "node:fs/promises";').length, 1);
	strictEqual(checkTelemetryProducer("helper.ts", 'JSON.stringify(event); new DatabaseSync("file");').length, 2);
	deepStrictEqual(checkTelemetryProducer("producer.ts", "sink.enqueue(event);"), []);
});

test("overlapping work retains its original session and releases ownership only after the last settlement", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-sessions-"));
	let failures = 0;
	const journals = createSessionJournals(stateDir, () => {
		failures += 1;
	});
	try {
		const origin = { id: "original", cwdHash: "repo" };
		const main = await journals.acquire(origin, "main", "turn-a");
		const side = await journals.acquire(origin, "memory", "turn-a");
		await main.release();
		const next = await journals.acquire({ ...origin, id: "next" }, "main", "turn-b");
		recordTelemetry("session.opened", {}, next.context);
		recordTelemetry("session.resumed", {}, side.context);
		await next.release();
		await side.release();
		const original = await readCallJournal(join(stateDir, "sessions", "repo", "original"));
		const switched = await readCallJournal(join(stateDir, "sessions", "repo", "next"));
		deepStrictEqual(
			original.records.map(({ record }) => record.ctx),
			[side.context],
		);
		deepStrictEqual(
			switched.records.map(({ record }) => record.ctx),
			[next.context],
		);
		const reopened = await journals.acquire(origin, "main");
		await reopened.release();
		strictEqual(failures, 0);
	} finally {
		await journals.flush();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("journal owns a session, flushes call attempts once, and keeps retries linked without shared mutable scope", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const journal = await openCallJournal({ sessionDirectory, context, writer });
	try {
		await rejects(openCallJournal({ sessionDirectory, context, writer }), /timed out/);
		const call = beginCall(
			{
				label: "main",
				target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
			},
			context,
		);
		strictEqual(call.nextAttempt(), null);
		call.stage("admission", "start");
		call.stage("admission", "end", { waitedOn: "budget" });
		call.settle(unsent);
		call.settle(unsent);
		const retry = call.nextAttempt();
		ok(retry);
		strictEqual(retry, call.nextAttempt());
		strictEqual(retry.callId, call.callId);
		strictEqual(retry.attempt, 1);
		retry.settle(unsent);
		strictEqual(journal.health().queueDepth, 4);
		await journal.flush();
		const rows = (await readCallJournal(sessionDirectory)).records.map(({ record }) => record);
		deepStrictEqual(
			rows.map((row) => row.k),
			["call.started", "call.settled", "call.started", "call.settled"],
		);
		strictEqual(journal.health().persisted, 4);
		strictEqual(journal.health().invalid, 0);
		for (const row of rows) strictEqual(row.ctx.callId, call.callId);
		const settled = rows[1];
		ok(settled?.k === "call.settled");
		strictEqual(settled.data.usage, null);
		strictEqual(settled.data.stages.admission?.waitedOn, "budget");
		await journal.close();
		const before = telemetryProducerHealth().unownedRecords;
		strictEqual(recordTelemetry("session.closed", { reason: "completed" }, context), false);
		strictEqual(telemetryProducerHealth().unownedRecords, before + 1);
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("journal overflow and invalid records produce gaps, rotation preserves records, and secrets are redacted", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const journal = await openCallJournal({ sessionDirectory, context, writer, queueCapacity: 2, segmentBytes: 1 });
	try {
		for (let n = 0; n < 4; n += 1) recordTelemetry("session.opened", {}, context);
		await journal.flush();
		strictEqual(journal.health().dropped, 2);
		recordTelemetry("session.opened", { unexpected: "field" }, context);
		await journal.flush();
		strictEqual(journal.health().invalid, 1);
		const call = beginCall(
			{
				label: "main",
				target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
			},
			context,
		);
		call.settle({ ...unsent, stop: { ...unsent.stop, detail: `api_key=${"synthetic".repeat(4)}` } });
		await journal.flush();
		const rows = (await readCallJournal(sessionDirectory)).records.map(({ record }) => record);
		deepStrictEqual(
			rows.filter((row) => row.k === "gap").map((row) => row.data),
			[
				{ sink: "calls.jsonl", reason: "writer-drop", count: 2 },
				{ sink: "calls.jsonl", reason: "invalid-record", count: 1 },
			],
		);
		strictEqual(rows.filter((row) => row.k === "session.opened").length, 2);
		const settled = rows.find((row) => row.k === "call.settled");
		ok(settled?.k === "call.settled");
		strictEqual(settled.data.stop.detail, "api_key=[redacted:assignment]");
		ok(rows.some((row) => row.k === "segment.closed"));
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("only the next owner repairs torn tails; future records survive reopening and reads do not repair", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const path = join(sessionDirectory, "calls.jsonl");
	let journal = await openCallJournal({ sessionDirectory, context, writer });
	try {
		recordTelemetry("session.opened", {}, context);
		await journal.close();
		const future = makeTelemetryRecord("session.opened", {}, context, {
			t: new Date().toISOString(),
			mono: performance.now(),
		});
		const futureLine = encodeTelemetryLine({ ...future, kv: 99 } as TelemetryRecord);
		await appendFile(path, futureLine);
		const prefix = await readFile(path);
		await appendFile(path, '{"torn":');
		strictEqual((await readCallJournal(sessionDirectory)).damaged, 1);
		strictEqual((await readFile(path)).length, prefix.length + 8);
		journal = await openCallJournal({ sessionDirectory, context, writer });
		strictEqual(journal.health().skipped, 1);
		const repaired = await readFile(path);
		deepStrictEqual(repaired.subarray(0, prefix.length), prefix);
		const result = await readCallJournal(sessionDirectory);
		strictEqual(result.damaged, 0);
		strictEqual(result.skipped, 1);
		ok(result.records.some(({ record }) => record.k === "gap" && record.data.reason === "torn-tail"));
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});
