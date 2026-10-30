import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { effectiveTelemetryCapture, STANDARD_CAPTURE } from "../../src/core/telemetry/capture.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { WorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { createTelemetryForwarder, readWorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import { beginCall, recordTelemetry, telemetryProducerHealth } from "../../src/core/telemetry/producer.js";
import type { CallStarted, RunUsage } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { createRunCallUsage, runUsageFromCallRecords } from "../../src/domains/dispatch/run-call-usage.js";
import { defaultRunEventJournal, readRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { openRunTelemetry } from "../../src/domains/dispatch/run-telemetry.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../src/domains/observability/call-facts.js";
import { openCallJournal, readCallJournal, readCallJournalSync } from "../../src/domains/observability/call-journal.js";
import { createCostTracker } from "../../src/domains/observability/cost.js";
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
import { readSessionCallJournalSync, seedForkCallJournal } from "../../src/domains/session/fork-journal.js";
import {
	uniqueUsageCalls,
	usageCallsFromAttempts,
	usageCallsFromJournal,
} from "../../src/domains/session/journal-usage.js";
import { runJournalsInWindow, usageCallsFromRunJournals } from "../../src/domains/session/run-journal-usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "../../src/domains/session/usage.js";
import type { SessionUsageSink } from "../../src/domains/session/usage-record.js";
import { recordUsageCall } from "../../src/domains/session/usage-record.js";
import { reseedSessionUsageFromLedger } from "../../src/domains/session/usage-reseed.js";
import { isReceiptBearingFrame } from "../../src/worker/protocol.js";
import { checkTelemetryProducer } from "../boundaries/check-boundaries.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

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
		const meter = createRunCallUsage(run);
		strictEqual(meter.snapshot(), undefined);
		for (const frame of frames) ok(meter.observe(frame));
		strictEqual(meter.snapshot()?.apiCalls, 0);
		strictEqual(meter.snapshot()?.callFacts.neverSent, 1);
		strictEqual(meter.snapshot()?.costSummary.unknownCallCoverageRuns, 1);
		const clean = createRunCallUsage(run);
		ok(
			clean.observe({
				type: "clio_coder_telemetry",
				record: { ...makeTelemetryRecord("process.started", {}, run, { t: new Date().toISOString(), mono: 0 }), origin },
			}),
		);
		strictEqual(clean.snapshot()?.apiCalls, 0);
		clean.gap();
		strictEqual(clean.snapshot()?.costSummary.unknownCallCoverageRuns, 1);
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
		const objects = await reopened.storeRequestObjects?.({
			prompt: {
				sections: [{ id: "identity", tokenEstimate: 3, contentHash: "a".repeat(64) }],
				fragmentManifest: [{ id: "identity.base", contentHash: "b".repeat(64), dynamic: false }],
			},
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		});
		ok(objects?.promptStructure);
		ok(objects.toolSchemas);
		const directory = join(stateDir, "sessions", "repo", "original");
		strictEqual((await readTelemetryObject(directory, objects.promptStructure)).kind, "resolved");
		strictEqual((await readTelemetryObject(directory, objects.toolSchemas)).kind, "resolved");
		deepStrictEqual(await reopened.storeRequestObjects?.({ tools: { invalid: Number.NaN } }), {});
		const request = beginCall(
			{
				label: "main",
				target: { targetId: "t", runtimeId: "r", api: "a", requestedModel: "m", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
				objects,
			},
			reopened.context,
		);
		request.settle(unsent);
		await reopened.release();
		const captured = await readCallJournal(directory);
		const settled = captured.records.find(({ record }) => record.k === "call.settled")?.record;
		ok(settled?.k === "call.settled");
		deepStrictEqual(settled.data.objects, objects);
		deepStrictEqual(await reopened.storeRequestObjects?.({ tools: [] }), {});

		strictEqual(failures, 1, "failed object capture is reported and never claims a resolvable reference");
	} finally {
		await journals.flush();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("parent replay resolves aggregate-only run references and replaces a partial snapshot on settlement", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "telemetry-parent-run-"));
	const stateDir = join(scratch, "state");
	const sessionDirectory = join(stateDir, "sessions", "repo", "parent");
	const journals = createSessionJournals(stateDir, () => {});
	const parent = await journals.acquire({ id: "parent", cwdHash: "repo" }, "worker");
	const context = { sessionId: "parent", runId: "run", label: "worker" as const };
	const run = await openRunTelemetry(context, join(stateDir, "runs", "run"));
	run.linkSession(parent.context);
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const aggregate = (tokens: number, revision: number): RunUsage => ({
		source: "acp",
		scope: "run",
		revision,
		coverage: "complete",
		pricingCoverage: "unknown",
		callCountCoverage: "complete",
		target: { targetId: "target", runtimeId: "acp", api: "acp", requestedModel: "model", reportedModel: unknown },
		usage: {
			input: unknown,
			output: unknown,
			cacheRead: unknown,
			cacheWrite: unknown,
			cacheWrite1h: unknown,
			reasoning: unknown,
		},
		totalTokens: measured(tokens),
		apiCalls: unknown,
		missingTokenCalls: unknown,
		pricing: { usd: unknown, pricedBy: "none" },
	});
	const report = (tokens: number, revision: number) =>
		run.worker({
			type: "clio_coder_telemetry",
			record: {
				...makeTelemetryRecord("run.usage", aggregate(tokens, revision), context, { t: new Date().toISOString(), mono: 1 }),
				origin: { host: "fixture", pid: 1, birthToken: "fixture", monoEpochWallMs: 1 },
			},
		});
	try {
		ok(report(5, 0));
		await run.flush();
		await journals.flush();
		const tracker = createCostTracker();
		const sink: SessionUsageSink = {
			resetSession: () => tracker.reset(),
			recordTokens: tracker.accumulate,
			recordRunTokens: (id, _source, ...args) => tracker.replace(id, ...args),
		};
		reseedSessionUsageFromLedger(sink, [], { sessionId: "parent", journalDirectory: sessionDirectory });
		strictEqual(tracker.sessionTokens().totalTokens, 5);
		strictEqual(tracker.sessionTokens().apiCalls, 0);
		ok(report(9, 1));
		await run.flush();
		const snapshot = readSessionCallJournalSync(sessionDirectory, []);
		strictEqual(snapshot.records.filter(({ record }) => record.k === "run.ref").length, 1);
		strictEqual(runJournalsInWindow(snapshot, 0, 1).size, 0);
		const missing = {
			...snapshot,
			runs: new Map([...snapshot.runs].map(([id, journal]) => [id, { ...journal, records: [] }])),
		};
		const unresolved = usageCallsFromRunJournals(runJournalsInWindow(missing, 0, Number.POSITIVE_INFINITY));
		strictEqual(unresolved[0]?.apiCalls, 0);
		strictEqual(unresolved[0]?.costSummary?.unknownCallCoverageRuns, 1);
		for (const call of usageCallsFromRunJournals(snapshot.runs)) recordUsageCall(sink, call);
		strictEqual(tracker.sessionTokens().totalTokens, 9);
		strictEqual(tracker.entries().length, 1);
		strictEqual(tracker.sessionCost().unknownCallCoverageRuns, 1);
		await writeFile(join(sessionDirectory, "current.jsonl"), "");
		await mkdir(join(stateDir, "receipts"));
		await writeFile(
			join(stateDir, "receipts", "run.json"),
			JSON.stringify({
				runId: "run",
				sessionId: "parent",
				endedAt: new Date().toISOString(),
				tokenCount: 99,
				apiCalls: 4,
				missingTokenCalls: 0,
				costUsd: 0,
				costProvenance: "known_free",
				agentAudience: "shadow",
			}),
		);
		const cli = new URL("../../src/cli/usage.ts", import.meta.url).href;
		const cliReport = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {runUsageCommand} from ${JSON.stringify(cli)}; await runUsageCommand(['report','--json']);`,
			],
			{ encoding: "utf8", env: { ...process.env, ...scratchClioEnvVars(scratch) } },
		);
		strictEqual(cliReport.status, 0, cliReport.stderr);
		const rows = cliReport.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		strictEqual(
			rows.find((row) => row.fact === "all-recorded-tokens")?.knownSubtotal,
			tracker.sessionTokens().totalTokens,
		);
		strictEqual(rows.find((row) => row.fact === "worker-tokens")?.apiCalls, 0);
		strictEqual(rows.find((row) => row.fact === "all-recorded-tokens")?.unknownCallCoverageRuns, 1);
		strictEqual(rows.find((row) => row.fact === "worker-audience-usage" && row.audience === "shadow")?.totalTokens, 9);
	} finally {
		await run.close();
		await parent.release();
		// The idle hold keeps the session owner registered after release; later tests open "parent" themselves (#434).
		await journals.closeAll();
		await rm(scratch, { recursive: true, force: true });
	}
});

test("a standalone run shares one envelope writer for calls and bounded display history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "telemetry-run-"));
	const run = { sessionId: null, runId: "standalone-run", label: "worker" as const };
	const journal = await openRunTelemetry(run, join(directory, run.runId));
	try {
		const display = defaultRunEventJournal();
		display.open(run.runId, "scout");
		journal.feed({ kind: "event", type: "text", detail: "PRIVATE_WORKER_PROSE" }, 1);
		journal.feed(
			{
				kind: "event",
				type: "clio_coder_tool_finish",
				tool: "read",
				callId: "tool-1",
				outcome: "ok",
				durationMs: 12,
				detail: "PRIVATE_TOOL_DETAIL",
				reason: "PRIVATE_TOOL_REASON",
				audit: { target: "PRIVATE_TARGET" },
			},
			10000,
		);
		journal.feed({ kind: "event", type: "message_end", detail: "PRIVATE_MESSAGE" }, 1);
		display.receipt(run.runId, { outcome: "succeeded", exitCode: 0 });
		display.terminal(run.runId, "succeeded", "PRIVATE_TERMINAL_DETAIL");
		display.append(run.runId, { at: new Date().toISOString(), type: "late-display" });
		const call = beginCall(
			{
				label: "worker",
				target: {
					targetId: "fixture",
					runtimeId: "fixture",
					api: "fixture",
					requestedModel: "fixture",
					reportedModel: unknown,
				},
				roundKind: "tools-removed",
				toolChoice: "none",
			},
			run,
		);
		call.settle(unsent);
		await journal.close();
		const saved = await readCallJournal(join(directory, run.runId), "events.ndjson");
		strictEqual(saved.damaged, 0);
		strictEqual(saved.records.filter(({ record }) => record.k === "call.settled").length, 1);
		const feed = readRunEventJournal(run.runId, { root: directory });
		deepStrictEqual(
			feed.lines.map((line) => line.kind),
			["open", "event", "journal_truncated", "receipt", "terminal"],
		);
		strictEqual(feed.terminal?.outcome, "succeeded");
		strictEqual(feed.truncated, true);
		strictEqual(feed.agentId, "scout");
		deepStrictEqual(feed.lines[1] && { ...feed.lines[1], seq: undefined, at: undefined }, {
			kind: "event",
			type: "clio_coder_tool_finish",
			tool: "read",
			callId: "tool-1",
			outcome: "ok",
			durationMs: 12,
			seq: undefined,
			at: undefined,
		});
		const raw = await readFile(join(directory, run.runId, "events.ndjson"), "utf8");
		strictEqual(raw.includes("PRIVATE_"), false, "standard run feed excludes prose, details, reasons and tool arguments");
		ok(saved.records.every(({ record }) => record.cc !== "content-bearing"));
		strictEqual((await readdir(directory)).length, 1, "standalone ownership never materializes a session");
		const before = await readFile(join(directory, run.runId, "events.ndjson"));
		display.open(run.runId, "late");
		deepStrictEqual(await readFile(join(directory, run.runId, "events.ndjson")), before);
	} finally {
		await journal.close();
		await rm(directory, { recursive: true, force: true });
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
		strictEqual(projected[0]?.costProvenance, "known", "declared target rates read as known");
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

test("a segment header says what its mode admits, and a mode change opens a new segment in place (#434)", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	let capture = STANDARD_CAPTURE;
	const journal = await openCallJournal({ sessionDirectory, context, writer, capture: () => capture });
	try {
		recordTelemetry("session.opened", {}, context);
		await journal.flush();
		const research = { content: true, deltas: true, providerHeaders: false, systemOneDataset: true, busTrace: false };
		capture = effectiveTelemetryCapture({ mode: "research", research }, false);
		recordTelemetry("session.resumed", {}, context);
		await journal.flush();
		const rows = scanTelemetrySegment(await readFile(join(sessionDirectory, "calls.jsonl"))).rows;
		deepStrictEqual(
			rows.map((row) =>
				row.kind === "header" ? `header:${row.header.mode}` : row.kind === "record" ? row.record.k : row.reason,
			),
			["header:standard", "session.opened", "segment.closed", "header:research", "session.resumed"],
		);
		const header = rows[3];
		ok(header?.kind === "header");
		deepStrictEqual(header.header.capture, { ...research, content: false }, "content needs workspace consent");
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("a project layer may lower telemetry capture but never raise it above user settings (#434)", async (t) => {
	const home = await isolateClioEnv("clio-telemetry-project-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	await mkdir(join(workspace, ".clio-coder"), { recursive: true });
	await mkdir(join(home.dir, "config"), { recursive: true });
	const user = join(home.dir, "config", "settings.yaml");
	await writeFile(
		join(workspace, ".clio-coder", "settings.yaml"),
		"telemetry:\n  mode: research\n  research:\n    content: true\n    busTrace: true\n    deltas: false\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	ok(snapshot.contentHash);
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	await writeFile(user, "version: 2\ntelemetry:\n  mode: research\n");
	const research = readLayeredSettings(workspace);
	deepStrictEqual(research.settings.telemetry, {
		mode: "research",
		research: { content: false, deltas: false, providerHeaders: true, systemOneDataset: true, busTrace: false },
	});
	deepStrictEqual(
		research.issues.filter((issue) => issue.origin === "project").map((issue) => issue.path),
		["telemetry.research.content", "telemetry.research.busTrace"],
	);
	await writeFile(user, "version: 2\n");
	const standard = readLayeredSettings(workspace);
	strictEqual(standard.settings.telemetry.mode, "standard");
	ok(standard.issues.some((issue) => issue.origin === "project" && issue.path === "telemetry.mode"));
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
	const run = runUsageFromCallRecords(rows);
	strictEqual(run.totalTokens, 22);
	strictEqual(run.costUsd, 0.125);
	strictEqual(run.apiCalls, 2);
	strictEqual(run.costSummary.unknownCallCoverageRuns, 1);
	deepStrictEqual(runUsageFromCallRecords([...rows].reverse()), run);
	const fold = foldCallJournal(rows);
	deepStrictEqual(foldCallJournal([...rows].reverse()).totals, fold.totals);
	strictEqual(fold.totals.logicalCalls, 3);
	strictEqual(fold.totals.attempts, 4);
	strictEqual(fold.totals.neverSent, 1);
	strictEqual(fold.totals.incomplete, 1);
	strictEqual(fold.totals.promptTokens.measured, 18);
	strictEqual(fold.totals.totalTokens.measured, 22);
	strictEqual(fold.totals.usd.measured, 0.125);
	strictEqual(fold.totals.usd.estimated, 0);
	strictEqual(fold.totals.usd.unknownCount, 2);
	strictEqual(fold.totals.usd.absentCount, 1);
	strictEqual(fold.totals.totalTokens.unknownCount, 1);
	deepStrictEqual(fold.unresolvedCallIds, [missingCall]);
	strictEqual(fold.coverage.duplicateRecords, 1);
	strictEqual(fold.coverage.duplicateAttempts, 1);
	deepStrictEqual(foldCallsBy(fold.attempts, (call) => call.started.target.targetId).get("target"), fold.totals);
	strictEqual(foldCallJournal(rows, new Set([first.callId])).totals.attempts, 2);
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const aggregate: RunUsage = {
		source: "acp",
		pricingCoverage: "complete",
		callCountCoverage: "complete",
		scope: "peer-session",
		revision: 1,
		coverage: "complete",
		target: first.target,
		usage: {
			input: measured(80),
			output: measured(20),
			cacheRead: unknown,
			cacheWrite: unknown,
			cacheWrite1h: unknown,
			reasoning: unknown,
		},
		totalTokens: measured(100),
		apiCalls: unknown,
		missingTokenCalls: unknown,
		pricing: { usd: measured(1), pricedBy: "provider" },
	};
	const aggregateRecord = makeTelemetryRecord(
		"run.usage",
		aggregate,
		{ sessionId: "session", runId: "run", label: "worker" },
		clock,
	);
	const aggregateOnly = runUsageFromCallRecords([aggregateRecord]);
	strictEqual(aggregateOnly.apiCalls, 0);
	strictEqual(aggregateOnly.costProvenance, "known");
	const partialCounts = runUsageFromCallRecords([
		{
			...aggregateRecord,
			data: { ...aggregate, apiCalls: measured(3), missingTokenCalls: measured(0), callCountCoverage: "partial" },
		},
	]);
	strictEqual(partialCounts.apiCalls, 3);
	strictEqual(partialCounts.costSummary.unknownCallCoverageRuns, 1);
	strictEqual(partialCounts.totalTokens, 100);
	strictEqual(partialCounts.tokenUsageMissing, false);
	strictEqual(partialCounts.costProvenance, "known");
	const partA = { ...aggregateRecord, data: { ...aggregate, partId: "a" } };
	const partB = {
		...aggregateRecord,
		id: makeTelemetryRecord("session.opened", {}, context, clock).id,
		data: { ...aggregate, partId: "b", totalTokens: measured(0), pricing: { usd: unknown, pricedBy: "none" as const } },
	};
	const parts = runUsageFromCallRecords([partA, partB, partA]);
	strictEqual(parts.totalTokens, 100);
	strictEqual(parts.costUsd, 1);
	strictEqual(parts.costSummary.hasUnknown, true);
	strictEqual(parts.apiCalls, 0);
	deepStrictEqual(runUsageFromCallRecords([partB, partA]), parts);
	deepStrictEqual(runUsageFromCallRecords([partA, aggregateRecord, partB]), aggregateOnly);
	const withAggregate = [...rows, aggregateRecord, aggregateRecord];
	const runAggregate = runUsageFromCallRecords(withAggregate);
	strictEqual(runAggregate.totalTokens, 100, "the snapshot includes per-call usage; never add both");
	strictEqual(runAggregate.costUsd, 1);
	strictEqual(runAggregate.apiCalls, 2, "only identified calls establish a count; aggregate coverage remains unknown");
	strictEqual(runAggregate.costSummary.unknownCallCoverageRuns, 1);
	deepStrictEqual(runUsageFromCallRecords([...withAggregate].reverse()), runAggregate);
	const zeroAggregate = makeTelemetryRecord(
		"run.usage",
		{
			...aggregate,
			revision: 2,
			totalTokens: measured(0),
			apiCalls: measured(0),
			missingTokenCalls: measured(0),
			pricing: { usd: measured(0), pricedBy: "provider" },
		},
		aggregateRecord.ctx,
		clock,
	);
	strictEqual(
		runUsageFromCallRecords([...withAggregate, zeroAggregate]).totalTokens,
		0,
		"latest revision replaces earlier snapshots, including measured zero",
	);
	const conflictingAggregate = { ...aggregateRecord, data: { ...aggregate, totalTokens: measured(200) } };
	const damagedAggregate = runUsageFromCallRecords([...withAggregate, conflictingAggregate]);
	strictEqual(damagedAggregate.totalTokens, 0);
	strictEqual(damagedAggregate.tokenUsageMissing, true);
	deepStrictEqual(runUsageFromCallRecords([conflictingAggregate, ...withAggregate].reverse()), damagedAggregate);
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

test("fork lineage resolves the inherited prefix without copying facts or double-counting shared attempts", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-fork-"));
	const parentDirectory = join(root, "workspace", "parent");
	const childDirectory = join(root, "workspace", "child");
	const at = Date.parse("2026-10-30T12:00:00.000Z");
	await mkdir(childDirectory, { recursive: true });
	const parent = await openCallJournal({
		sessionDirectory: parentDirectory,
		context: { sessionId: "parent", label: "main" },
		writer,
	});
	const contribute = (
		journal: typeof parent,
		sessionId: string,
		label: "main" | "helper",
		tokens: number,
		wallMs: number,
	) => {
		const callId = newCallId();
		const attemptId = newAttemptId();
		journal.enqueue({
			kind: "call.settled",
			ctx: { sessionId, label, callId, attemptId },
			wallMs,
			mono: 1,
			data: {
				...callSettlementFromMessage(
					{
						stopReason: "stop",
						usage: {
							input: tokens,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							clioExternal: { tokenUsage: "provider-reported" },
						},
					},
					"unknown",
				),
				callId,
				attemptId,
				attempt: 0,
				label,
				stages: { settle: 1 },
				roundKind: "normal",
				toolChoice: "auto",
				target: {
					targetId: "fixture",
					runtimeId: "fixture",
					api: "fixture",
					requestedModel: "model",
					reportedModel: unknown,
				},
			},
		});
		return callId;
	};
	try {
		const inheritedId = contribute(parent, "parent", "main", 5, at - 10);
		contribute(parent, "parent", "helper", 7, at - 5);
		contribute(parent, "parent", "helper", 9, at + 5);
		await parent.close();
		const parentBytes = await readFile(join(parentDirectory, "calls.jsonl"));
		seedForkCallJournal(childDirectory, "child", {
			parentSessionId: "parent",
			parentCwdHash: "workspace",
			parentTurnId: "turn",
			parentTurnAt: new Date(at).toISOString(),
		});
		const child = await openCallJournal({
			sessionDirectory: childDirectory,
			context: { sessionId: "child", label: "main" },
			writer,
		});
		const childId = contribute(child, "child", "main", 11, at + 10);
		await child.close();
		const entry = (id: string, turnId: string): SessionEntry => ({
			kind: "message",
			role: "assistant",
			turnId,
			parentTurnId: null,
			timestamp: new Date(at).toISOString(),
			payload: { callId: id, usage: null },
		});
		const entries = [entry(inheritedId, "turn"), entry(childId, "child-turn")];
		const parentCalls = ledgerUsageCalls(
			entries.slice(0, 1),
			{},
			readSessionCallJournalSync(parentDirectory, entries).records.map(({ record }) => record),
		);
		const childCalls = ledgerUsageCalls(
			entries,
			{},
			readSessionCallJournalSync(childDirectory, entries).records.map(({ record }) => record),
		);
		strictEqual(
			childCalls.reduce((sum, call) => sum + call.totalTokens, 0),
			23,
		);
		const total = (calls: typeof childCalls) => uniqueUsageCalls(calls).reduce((sum, call) => sum + call.totalTokens, 0);
		strictEqual(total([...parentCalls, ...childCalls]), 32);
		strictEqual(total([...childCalls, ...parentCalls]), 32);
		strictEqual(
			readCallJournalSync(childDirectory).records.filter(({ record }) => record.k === "call.settled").length,
			1,
		);
		deepStrictEqual(await readFile(join(parentDirectory, "calls.jsonl")), parentBytes);
		await rm(parentDirectory, { recursive: true });
		const unavailable = readSessionCallJournalSync(childDirectory, entries);
		ok(unavailable.skipped > 0);
		const remaining = ledgerUsageCalls(
			entries,
			{},
			unavailable.records.map(({ record }) => record),
		);
		const inherited = remaining.find((call) => call.callId === inheritedId);
		strictEqual(inherited?.apiCalls, 0);
		strictEqual(inherited?.costSummary?.unknownCallCoverageRuns, 1);
		strictEqual(
			remaining.reduce((sum, call) => sum + call.totalTokens, 0),
			11,
		);
	} finally {
		await parent.close();
		await rm(root, { recursive: true, force: true });
	}
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

test("a crash-orphaned main call counts only when its user turn is on the active path (#434)", () => {
	const owner = { ...context, turnId: "user-1" };
	const call = beginCall(
		{
			label: "main",
			target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
			roundKind: "normal",
			toolChoice: "auto",
		},
		owner,
	);
	const message = {
		stopReason: "stop",
		usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	};
	const facts = call.settle(callSettlementFromMessage(message, "unknown"));
	ok(facts);
	const scope = { ...owner, callId: facts.callId, attemptId: facts.attemptId };
	const clock = { t: new Date().toISOString(), mono: 1 };
	const { callId, attemptId, attempt, label, target, roundKind, toolChoice } = facts;
	const rows = [
		makeTelemetryRecord(
			"call.started",
			{ callId, attemptId, attempt, label, target, roundKind, toolChoice },
			scope,
			clock,
		),
		makeTelemetryRecord("call.settled", facts, scope, clock),
	];
	const user = (turnId: string): SessionEntry => ({
		kind: "message",
		role: "user",
		turnId,
		parentTurnId: null,
		timestamp: clock.t,
		payload: { text: "go" },
	});
	deepStrictEqual(
		ledgerUsageCalls([user("user-1")], {}, rows).map((row) => row.callId),
		[callId],
		"the settled call survives the lost assistant message",
	);
	deepStrictEqual(ledgerUsageCalls([user("other-branch")], {}, rows), [], "another branch's turn keeps its own calls");
});

test("usage report discovers a standalone run journal that has no session and no receipt (#434)", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "telemetry-standalone-report-"));
	const stateDir = join(scratch, "state");
	const owner = { sessionId: null, runId: "orphan-run", label: "worker" as const };
	const run = await openRunTelemetry(owner, join(stateDir, "runs", owner.runId));
	const measured = { kind: "measured" as const, value: 21, source: "provider" as const };
	const usage: RunUsage = {
		source: "acp",
		scope: "run",
		revision: 0,
		coverage: "complete",
		pricingCoverage: "unknown",
		callCountCoverage: "complete",
		target: { targetId: "target", runtimeId: "acp", api: "acp", requestedModel: "model", reportedModel: unknown },
		usage: {
			input: unknown,
			output: unknown,
			cacheRead: unknown,
			cacheWrite: unknown,
			cacheWrite1h: unknown,
			reasoning: unknown,
		},
		totalTokens: measured,
		apiCalls: unknown,
		missingTokenCalls: unknown,
		pricing: { usd: unknown, pricedBy: "none" },
	};
	try {
		ok(
			run.worker({
				type: "clio_coder_telemetry",
				record: {
					...makeTelemetryRecord("run.usage", usage, owner, { t: new Date().toISOString(), mono: 1 }),
					origin: { host: "fixture", pid: 1, birthToken: "fixture", monoEpochWallMs: 1 },
				},
			}),
		);
		await run.close();
		// Appends never bump the run directory; a run created before the window still settled inside it.
		const created = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		await utimes(join(stateDir, "runs", owner.runId), created, created);
		const cli = new URL("../../src/cli/usage.ts", import.meta.url).href;
		const report = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {runUsageCommand} from ${JSON.stringify(cli)}; await runUsageCommand(['report','--json']);`,
			],
			{ encoding: "utf8", env: { ...process.env, ...scratchClioEnvVars(scratch) } },
		);
		strictEqual(report.status, 0, report.stderr);
		const rows = report.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		strictEqual(rows.find((row) => row.fact === "worker-tokens")?.totalTokens, 21);
	} finally {
		await run.close();
		await rm(scratch, { recursive: true, force: true });
	}
});
