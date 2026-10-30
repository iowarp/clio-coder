import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { WorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { createTelemetryForwarder, readWorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import { beginCall, recordTelemetry, telemetryProducerHealth } from "../../src/core/telemetry/producer.js";
import type { CallStarted } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine } from "../../src/core/telemetry/segment.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../src/domains/observability/call-facts.js";
import { openCallJournal, readCallJournal, readCallJournalSync } from "../../src/domains/observability/call-journal.js";
import { foldCallJournal, foldCallsBy, foldFacts } from "../../src/domains/observability/folds.js";
import {
	readTelemetryObject,
	storeTelemetryObject,
	telemetryCommitment,
	telemetryPromptStructure,
} from "../../src/domains/observability/objects.js";
import { createSessionJournals } from "../../src/domains/observability/session-journals.js";
import { buildAuditRecord, openAuditWriter } from "../../src/domains/safety/audit.js";
import { readAuditRows } from "../../src/domains/session/archive-readers.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { usageCallsFromAttempts, usageCallsFromJournal } from "../../src/domains/session/journal-usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { recordUsageCall } from "../../src/domains/session/usage-record.js";
import { reseedSessionUsageFromLedger } from "../../src/domains/session/usage-reseed.js";
import { isReceiptBearingFrame } from "../../src/worker/protocol.js";
import { checkTelemetryProducer } from "../boundaries/check-boundaries.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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

test("worker forwarding preserves identity and source clocks with bounded deferred delivery", async () => {
	const run = { sessionId: null, runId: "standalone-run", label: "worker" as const };
	const origin = { host: "remote-worker", pid: 17, birthToken: "worker-birth", monoEpochWallMs: 1000 };
	const frames: WorkerTelemetryFrame[] = [];
	const forwarder = createTelemetryForwarder(run, origin, (frame) => frames.push(frame), 2);
	try {
		const call = beginCall(
			{
				label: "worker",
				target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
			},
			run,
		);
		call.settle(unsent);
		strictEqual(recordTelemetry("process.exited", { exitCode: 0 }, run), false);
		strictEqual(frames.length, 0, "enqueue does not serialize or emit inline");
		forwarder.close();
		deepStrictEqual(
			frames.map((frame) => frame.record.k),
			["call.started", "call.settled", "gap"],
		);
		ok(frames.every(isReceiptBearingFrame));
		strictEqual(readWorkerTelemetryFrame(frames[0], { ...run, runId: "different-run" }), null);
		strictEqual(readWorkerTelemetryFrame(frames[0], { ...run, sessionId: "different-session" }), null);
		const directory = await mkdtemp(join(tmpdir(), "telemetry-forwarded-"));
		const journal = await openCallJournal({
			sessionDirectory: directory,
			fileName: "events.ndjson",
			context: run,
			writer,
			segmentBytes: 1,
		});
		try {
			for (const frame of frames) {
				const pending = readWorkerTelemetryFrame(frame, run);
				ok(pending);
				ok(journal.enqueue(pending));
			}
			await journal.flush();
			const saved = await readCallJournal(directory, "events.ndjson");
			deepStrictEqual(readCallJournalSync(directory, "events.ndjson"), saved);
			strictEqual((await readCallJournal(directory)).records.length, 0, "standalone runs create no session call store");
			const forwarded = saved.records.filter((row) => row.origin.host === "remote-worker");
			deepStrictEqual(
				forwarded.map(({ record }) => record.id),
				frames.map((frame) => frame.record.id),
			);
			ok(forwarded.every((row) => row.record.ctx.sessionId === null));
			ok(saved.records.some((row) => row.record.k === "segment.closed" && row.origin.host !== "remote-worker"));
			const folded = foldCallJournal(saved.records.map(({ record }) => record));
			strictEqual(folded.totals.neverSent, 1);
			strictEqual(folded.coverage.droppedRecords, 1);
		} finally {
			await journal.close();
			await rm(directory, { recursive: true, force: true });
		}
	} finally {
		forwarder.close();
	}
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
		ok(call.settle(unsent));
		strictEqual(call.settle(unsent), undefined);
		const retry = call.nextAttempt();
		ok(retry);
		strictEqual(retry, call.nextAttempt());
		strictEqual(retry.callId, call.callId);
		strictEqual(retry.attempt, 1);
		const message = {
			stopReason: "stop",
			responseModelIdObservation: { state: "reported", reportedModelId: "served-model" },
			usage: {
				input: 7,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
				clioExternal: { tokenUsage: "provider-reported" },
			},
		};
		const liveFacts = retry.settle(callSettlementFromMessage(message, "known"), reportedModelFromMessage(message));
		ok(liveFacts);
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
		deepStrictEqual(
			readCallJournalSync(sessionDirectory).records.map(({ record }) => record),
			rows,
		);
		const projected = usageCallsFromJournal(rows);
		const live = usageCallsFromAttempts([{ started: liveFacts, settled: liveFacts }]);
		deepStrictEqual(live, projected);
		strictEqual(projected.length, 1);
		strictEqual(projected[0]?.attributedModelId, "served-model");
		strictEqual(projected[0]?.totalTokens, 9);
		strictEqual(projected[0]?.costProvenance, "estimated");
		const ledger: SessionEntry[] = [
			{
				kind: "message",
				role: "assistant",
				turnId: "assistant",
				parentTurnId: null,
				timestamp: new Date().toISOString(),
				payload: { callId: call.callId, usage: { input: 999, output: 999, totalTokens: 1998 } },
			},
		];
		deepStrictEqual(ledgerUsageCalls([...ledger, ...ledger], {}, rows), projected);
		deepStrictEqual(ledgerCallFailureCounts([...ledger, ...ledger], rows), {
			invokedUnknownCalls: 0,
			neverInvokedCalls: 1,
		});
		const replayed: unknown[][] = [];
		reseedSessionUsageFromLedger(
			{
				resetSession() {},
				recordTokens(...args) {
					replayed.push(args);
				},
			},
			ledger,
			{ journalDirectory: sessionDirectory },
		);
		const liveRecorded: unknown[][] = [];
		for (const call of live)
			recordUsageCall(
				{
					recordTokens: (...args) => {
						liveRecorded.push(args);
					},
				},
				call,
			);
		deepStrictEqual(
			liveRecorded.map((args) => args.slice(0, -1)),
			replayed.map((args) => args.slice(0, -1)),
		);
		strictEqual(liveRecorded[0]?.[9], false);
		strictEqual(replayed[0]?.[9], true);
		strictEqual(replayed.length, 1);
		strictEqual(replayed[0]?.[1], "served-model");
		strictEqual(replayed[0]?.[2], 9);
		deepStrictEqual(replayed[0]?.[8], projected[0]?.costSummary);
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

test("the call fold deduplicates forks and retries, preserves unknown coverage and never adds token subfields twice", () => {
	const clock = { t: "2026-10-30T12:00:00.000Z", mono: 1 };
	const started = (): CallStarted => ({
		callId: newCallId(),
		attemptId: newAttemptId(),
		attempt: 0,
		label: "main",
		target: { targetId: "target", runtimeId: "fixture", api: "fixture", requestedModel: "model", reportedModel: unknown },
		roundKind: "normal",
		toolChoice: "auto",
	});
	const first = started();
	const settle = (start: CallStarted, message: unknown, pricing: "known" | "unknown" = "unknown") =>
		makeTelemetryRecord(
			"call.settled",
			{ ...start, ...callSettlementFromMessage(message, pricing), stages: { settle: 1 } },
			context,
			clock,
		);
	const priced = settle(
		first,
		{
			stopReason: "stop",
			usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2, cacheWrite1h: 1, reasoning: 2, cost: { total: 0.125 } },
		},
		"known",
	);
	const zero = settle(
		{ ...first, attemptId: newAttemptId(), attempt: 1 },
		{
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, clioExternal: { tokenUsage: "provider-reported" } },
		},
	);
	const unsent = settle(started(), { stopReason: "aborted", callInvoked: false });
	const incomplete = makeTelemetryRecord("call.started", started(), context, clock);
	const missingCall = newCallId();
	const refs = [first.callId, missingCall].map((callId) =>
		makeTelemetryRecord("call.ref", { callId, runId: "run" }, context, clock),
	);
	const rows = [
		priced,
		zero,
		unsent,
		incomplete,
		...refs,
		priced,
		{ ...zero, id: makeTelemetryRecord("session.opened", {}, context, clock).id },
	];
	const fold = foldCallJournal(rows);
	deepStrictEqual(foldCallJournal([...rows].reverse()).totals, fold.totals);
	strictEqual(fold.totals.logicalCalls, 3);
	strictEqual(fold.totals.attempts, 4);
	strictEqual(fold.totals.neverSent, 1);
	strictEqual(fold.totals.incomplete, 1);
	strictEqual(fold.totals.promptTokens.measured, 18);
	strictEqual(fold.totals.totalTokens.measured, 22);
	strictEqual(fold.totals.usd.measured, 0);
	strictEqual(fold.totals.usd.estimated, 0.125);
	strictEqual(fold.totals.usd.unknownCount, 2);
	strictEqual(fold.totals.usd.absentCount, 1);
	strictEqual(fold.totals.totalTokens.unknownCount, 1);
	deepStrictEqual(fold.unresolvedCallIds, [missingCall]);
	strictEqual(fold.coverage.duplicateRecords, 1);
	strictEqual(fold.coverage.duplicateAttempts, 1);
	deepStrictEqual(foldCallsBy(fold.attempts, (call) => call.started.target.targetId).get("target"), fold.totals);
	strictEqual(foldCallJournal(rows, new Set([first.callId])).totals.attempts, 2);
	const conflicting = {
		...priced,
		id: makeTelemetryRecord("session.opened", {}, context, clock).id,
		data: {
			...priced.data,
			pricing: {
				...priced.data.pricing,
				usd: { kind: "estimated" as const, value: 100, method: "target-rates" as const },
			},
		},
	};
	const damaged = foldCallJournal([priced, conflicting]);
	strictEqual(damaged.coverage.conflictingAttempts, 1);
	strictEqual(damaged.totals.usd.estimated, 0);
	strictEqual(damaged.totals.usd.unknownCount, 1);
	deepStrictEqual(foldCallJournal([conflicting, priced]).totals, damaged.totals);
	const facts = foldFacts([
		{ kind: "measured", value: 0, source: "provider" },
		unknown,
		{ kind: "absent", reason: "not-captured-in-mode" },
	]);
	deepStrictEqual(facts.coverage, { measured: 1, estimated: 0, unknown: 1 });
	strictEqual(facts.absentCount, 1);
});

test("session objects retain canonical redacted preimages, distinguish commitments, and reject damaged objects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "telemetry-objects-"));
	try {
		const secret = "fake-password-value-for-test";
		const schemas = [{ name: "fixture", parameters: { password: secret, type: "object" } }];
		const ref = await storeTelemetryObject(directory, "tool-schemas", schemas);
		deepStrictEqual(
			await storeTelemetryObject(directory, "tool-schemas", [
				{ parameters: { type: "object", password: secret }, name: "fixture" },
			]),
			ref,
		);
		strictEqual(ref.label, "resolvable");
		const path = join(directory, "objects", `${ref.id}.json`);
		const bytes = await readFile(path, "utf8");
		ok(!bytes.includes(secret));
		strictEqual((await stat(path)).mode & 0o777, 0o600);
		deepStrictEqual(await readTelemetryObject(directory, ref), { kind: "resolved", value: JSON.parse(bytes) });
		const commitment = telemetryCommitment("briefing", { text: "private task" });
		deepStrictEqual(await readTelemetryObject(directory, commitment), { kind: "commitment" });
		strictEqual((await readdir(join(directory, "objects"))).length, 1);
		await writeFile(path, "{}");
		await rejects(readTelemetryObject(directory, ref), /digest mismatch/);
		await rejects(storeTelemetryObject(directory, "tool-schemas", schemas), /corrupt preimage/);
		await rm(path);
		deepStrictEqual(await readTelemetryObject(directory, ref), { kind: "missing" });
		await symlink(join(directory, "nonexistent"), path);
		await rejects(readTelemetryObject(directory, ref));
		await rm(path);
		const compiled = {
			systemPrompt: "private prompt",
			sections: [{ id: "identity", tokenEstimate: 5, contentHash: "a".repeat(64) }],
			fragmentManifest: [{ id: "identity.base", contentHash: "b".repeat(64), dynamic: false, body: "private prompt" }],
		};
		const structure = telemetryPromptStructure(compiled);
		const prompt = await storeTelemetryObject(directory, "prompt-structure", structure);
		deepStrictEqual(await readTelemetryObject(directory, prompt), { kind: "resolved", value: structure });
		await rejects(storeTelemetryObject(directory, "prompt-structure", compiled), /unsupported fields/);
		await rejects(storeTelemetryObject(directory, "tool-schemas", { invalid: Number.NaN }), /non-finite/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("audit writes rotate at UTC midnight and readers merge legacy days without changing old files", async () => {
	const env = await isolateClioEnv("telemetry-audit-");
	let now = new Date("2026-10-30T23:59:59.000Z");
	const writer = openAuditWriter({ dateFn: () => now });
	try {
		process.env.TZ = "America/Los_Angeles";
		const stateDir = join(env.dir, "state");
		const directory = join(stateDir, "audit");
		await mkdir(directory, { recursive: true });
		const legacy = `${JSON.stringify({ kind: "tool_call", ts: "2026-10-30T23:59:58.000Z", correlationId: "legacy" })}\n`;
		await writeFile(join(directory, "2026-10-30.jsonl"), legacy);
		const row = () =>
			buildAuditRecord({ tool: "read", classification: { actionClass: "read", reasons: [] }, decision: "allowed", now });
		writer.write(row());
		now = new Date("2026-10-31T00:00:01.000Z");
		writer.write(row());
		process.env.TZ = "Pacific/Kiritimati";
		now = new Date("2026-10-31T23:00:00.000Z");
		writer.write(row());
		await writer.close();
		deepStrictEqual((await readdir(directory)).sort(), [
			"2026-10-30.jsonl",
			"2026-10-30.utc.jsonl",
			"2026-10-31.utc.jsonl",
		]);
		strictEqual(await readFile(join(directory, "2026-10-30.jsonl"), "utf8"), legacy);
		const read = await readAuditRows(stateDir);
		deepStrictEqual(read.errors, []);
		deepStrictEqual(
			read.rows.map((row) => row.ts),
			["2026-10-30T23:59:58.000Z", "2026-10-30T23:59:59.000Z", "2026-10-31T00:00:01.000Z", "2026-10-31T23:00:00.000Z"],
		);
	} finally {
		await writer.close();
		env.restore();
	}
});
