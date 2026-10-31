import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import {
	captureAdmits,
	effectiveTelemetryCapture,
	STANDARD_CAPTURE,
	systemOneDatasetRecording,
} from "../../src/core/telemetry/capture.js";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { CostReportV1, ExplanationV1 } from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import type { WorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { createTelemetryForwarder, readWorkerTelemetryFrame } from "../../src/core/telemetry/forwarder.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import { beginCall, telemetryProducerHealth } from "../../src/core/telemetry/producer.js";
import { registerResearchTraceSink } from "../../src/core/telemetry/research-trace.js";
import type { CallStarted, RunUsage } from "../../src/core/telemetry/schemas.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { createRunCallUsage, runUsageFromCallRecords } from "../../src/domains/dispatch/run-call-usage.js";
import { defaultRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { openRunTelemetry } from "../../src/domains/dispatch/run-telemetry.js";
import { observationTracing, traceObservation } from "../../src/domains/memory/observation-events.js";
import { createTaskMemoryTrace } from "../../src/domains/memory/task-memory-trace.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { readSessionCallJournalSync } from "../../src/domains/session/fork-journal.js";
import {
	uniqueUsageCalls,
	usageCallsFromAttempts,
	usageCallsFromJournal,
} from "../../src/domains/session/journal-usage.js";
import { runJournalsInWindow, usageCallsFromRunJournals } from "../../src/domains/session/run-journal-usage.js";
import { ledgerCallFailureCounts, ledgerUsageCalls } from "../../src/domains/session/usage.js";
import { callSettlementFromMessage, reportedModelFromMessage } from "../../src/domains/telemetry/call-facts.js";
import {
	openCallJournal,
	openCallJournalHealth,
	readCallJournal,
	readCallJournalSync,
	seedForkCallJournal,
} from "../../src/domains/telemetry/call-journal.js";
import {
	createConsentView,
	grantTelemetryConsent,
	readTelemetryConsent,
	resolveConsentWorkspace,
	revokeTelemetryConsent,
} from "../../src/domains/telemetry/consent.js";
import { foldCallJournal, foldFacts } from "../../src/domains/telemetry/folds.js";
import { createHealthWindows } from "../../src/domains/telemetry/health-window.js";
import {
	readTelemetryObject,
	storeTelemetryObject,
	telemetryCommitment,
	telemetryPromptStructure,
} from "../../src/domains/telemetry/objects.js";
import {
	telemetryProcessDirectory,
	telemetryProcessesDirectory,
	telemetryRunDirectory,
	telemetrySessionDirectory,
} from "../../src/domains/telemetry/paths.js";
import { createProcessJournal } from "../../src/domains/telemetry/process-journal.js";
import {
	applyTelemetryPrune,
	DEFAULT_PRUNE_POLICY,
	planTelemetryPrune,
} from "../../src/domains/telemetry/retention.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { isReceiptBearingFrame } from "../../src/worker/protocol.js";
import { checkTelemetryProducer, checkTelemetryWrites } from "../boundaries/check-boundaries.js";
import { isolateClioEnv, scratchClioEnvVars } from "../harness/scratch-env.js";

const context = { sessionId: "journal-session", agent: { role: "main" as const, id: "journal-session" } };
const writer = { clioCoderVersion: "fixture", piVersion: "fixture" };
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

test("rule11 keeps writes under the telemetry root inside the telemetry domain", () => {
	for (const source of [
		"writeFileSync(telemetryJournalPath(directory), bytes);",
		'const path = join(stateDir, "telemetry", "consent.json"); await writeFile(path, "{}");',
		"rmSync(telemetryRunDirectory(stateDir, runId), { recursive: true });",
		"const root = telemetryRunsDirectory(clioStateDir()); mkdirSync(join(root, runId));",
		'openSync(join(telemetrySessionDirectory(stateDir, id), "objects", name), "wx");',
		'new DatabaseSync(join(stateDir, "telemetry", "index.sqlite"));',
	]) {
		ok(checkTelemetryWrites("src/domains/session/example.ts", source)[0]?.startsWith("rule11:"), source);
		deepStrictEqual(checkTelemetryWrites("src/domains/telemetry/example.ts", source), []);
	}
	for (const source of [
		"readFileSync(telemetryJournalPath(directory));",
		'openSync(telemetryJournalPath(directory), "r");',
		'writeFileSync(join(stateDir, "runs", runId, "recording.json"), bytes);',
		'new DatabaseSync(join(stateDir, "telemetry", "index.sqlite"), { readOnly: true });',
		"rmSync(sessionDirectory, { recursive: true });",
	])
		deepStrictEqual(checkTelemetryWrites("src/domains/session/example.ts", source), [], source);
});

test("worker forwarding preserves identity and source clocks with bounded deferred delivery", async () => {
	const run = { sessionId: null, runId: "standalone-run", agent: { role: "worker" as const, id: "standalone-run" } };
	const origin = { host: "remote-worker", pid: 17, birthToken: "worker-birth", monoEpochWallMs: 1000 };
	const frames: WorkerTelemetryFrame[] = [];
	const forwarder = createTelemetryForwarder(run, origin, (frame) => frames.push(frame), 2);
	try {
		const call = beginCall(
			{
				target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
			},
			run,
		);
		call.settle(unsent);
		strictEqual(telemetryHub().emit("process.exited", { exitCode: 0 }, run), false);
		strictEqual(frames.length, 0, "enqueue does not serialize or emit inline");
		forwarder.close();
		deepStrictEqual(
			frames.map((frame) => frame.record.k),
			["call.started", "call.settled", "journal.gap"],
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
			directory,
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
			const saved = await readCallJournal(directory);
			deepStrictEqual(readCallJournalSync(directory), saved);
			const forwarded = saved.records.filter((row) => row.origin.host === "remote-worker");
			deepStrictEqual(
				forwarded.map(({ record }) => record.id),
				frames.map((frame) => frame.record.id),
			);
			ok(forwarded.every((row) => row.record.ctx.sessionId === null));
			ok(saved.records.some((row) => row.record.k === "journal.segment_closed" && row.origin.host !== "remote-worker"));
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
		const main = await journals.acquire(origin, { role: "main", id: origin.id }, "turn-a");
		const side = await journals.acquire(origin, { role: "memory", id: origin.id }, "turn-a");
		await main.release();
		const next = await journals.acquire({ ...origin, id: "next" }, { role: "main", id: "next" }, "turn-b");
		telemetryHub().emit("session.opened", {}, next.context);
		telemetryHub().emit("session.resumed", { via: "resume" }, side.context);
		await next.release();
		await side.release();
		const original = await readCallJournal(telemetrySessionDirectory(stateDir, "original"));
		const switched = await readCallJournal(telemetrySessionDirectory(stateDir, "next"));
		deepStrictEqual(
			original.records.map(({ record }) => record.ctx),
			[side.context],
		);
		deepStrictEqual(
			switched.records.map(({ record }) => record.ctx),
			[next.context],
		);
		const reopened = await journals.acquire(origin, { role: "main", id: origin.id });
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
		const directory = telemetrySessionDirectory(stateDir, "original");
		strictEqual((await readTelemetryObject(directory, objects.promptStructure)).kind, "resolved");
		strictEqual((await readTelemetryObject(directory, objects.toolSchemas)).kind, "resolved");
		deepStrictEqual(await reopened.storeRequestObjects?.({ tools: { invalid: Number.NaN } }), {});
		const request = beginCall(
			{
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
	const parent = await journals.acquire({ id: "parent", cwdHash: "repo" }, { role: "worker", id: "run" });
	const context = { sessionId: "parent", runId: "run", agent: { role: "worker" as const, id: "run" } };
	const run = await openRunTelemetry(context, telemetryRunDirectory(stateDir, "run"));
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
				...makeTelemetryRecord("run.usage_reported", aggregate(tokens, revision), context, {
					t: new Date().toISOString(),
					mono: 1,
				}),
				origin: { host: "fixture", pid: 1, birthToken: "fixture", monoEpochWallMs: 1 },
			},
		});
	try {
		ok(report(5, 0));
		await run.flush();
		await journals.flush();
		ok(report(9, 1));
		await run.flush();
		const snapshot = readSessionCallJournalSync(stateDir, "parent", []);
		strictEqual(snapshot.records.filter(({ record }) => record.k === "run.linked").length, 1);
		strictEqual(runJournalsInWindow(snapshot, 0, 1).size, 0);
		const missing = {
			...snapshot,
			runs: new Map([...snapshot.runs].map(([id, journal]) => [id, { ...journal, records: [] }])),
		};
		const unresolved = usageCallsFromRunJournals(runJournalsInWindow(missing, 0, Number.POSITIVE_INFINITY));
		strictEqual(unresolved[0]?.apiCalls, 0);
		strictEqual(unresolved[0]?.costSummary?.unknownCallCoverageRuns, 1);
		await mkdir(sessionDirectory, { recursive: true });
		await writeFile(join(sessionDirectory, "current.jsonl"), "");
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
		const reportDto = JSON.parse(cliReport.stdout) as ReturnType<
			typeof import("../../src/domains/telemetry/read-model.js").usageReport
		>;
		// The report reads the run's aggregate through the read model; the receipt's own 99 tokens are not a second source.
		const cost = reportDto.cost.find((row) => row.groupBy === "role");
		ok(cost, "the report carries the read model's cost by agent role");
		deepStrictEqual(cost.scope, { repo: "all", days: 30 });
		const tokens = cost.total.tokens.fact;
		strictEqual("kind" in tokens ? Number.NaN : tokens.measured, 9);
		strictEqual(cost.total.tokens.display, "9");
		deepStrictEqual(
			cost.groups.map((group) => group.key),
			["worker"],
		);
		// The aggregate names no call count, so the calls figure is partial rather than a measured zero.
		const calls = cost.total.calls.fact;
		strictEqual("kind" in calls ? -1 : calls.unknownCount, 1);
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
	const run = { sessionId: null, runId: "standalone-run", agent: { role: "worker" as const, id: "standalone-run" } };
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
				callFacts: { target: "PRIVATE_TARGET" },
			},
			10000,
		);
		journal.feed({ kind: "event", type: "message_end", detail: "PRIVATE_MESSAGE" }, 1);
		display.result(run.runId, { outcome: "succeeded", exitCode: 0 });
		display.terminal(run.runId, "succeeded", "PRIVATE_TERMINAL_DETAIL");
		display.append(run.runId, { at: new Date().toISOString(), type: "late-display" });
		const call = beginCall(
			{
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
		const saved = await readCallJournal(join(directory, run.runId));
		strictEqual(saved.damaged, 0);
		strictEqual(saved.records.filter(({ record }) => record.k === "call.settled").length, 1);
		const feed = saved.records.flatMap(({ record }) => (record.k === "run.feed_appended" ? [record.data.body] : []));
		deepStrictEqual(
			feed.map((line) => line.kind),
			["open", "event", "journal_truncated", "result", "terminal"],
		);
		const terminal = feed[4];
		strictEqual(terminal?.kind === "terminal" ? terminal.outcome : null, "succeeded");
		const opened = feed[0];
		strictEqual(opened?.kind === "open" ? opened.agentId : null, "scout");
		deepStrictEqual(feed[1], {
			kind: "event",
			type: "clio_coder_tool_finish",
			tool: "read",
			callId: "tool-1",
			outcome: "ok",
			durationMs: 12,
		});
		const raw = await readFile(join(directory, run.runId, "journal.jsonl"), "utf8");
		strictEqual(raw.includes("PRIVATE_"), false, "standard run feed excludes prose, details, reasons and tool arguments");
		ok(saved.records.every(({ record }) => record.cc !== "content-bearing"));
		strictEqual((await readdir(directory)).length, 1, "standalone ownership never materializes a session");
		const before = await readFile(join(directory, run.runId, "journal.jsonl"));
		display.open(run.runId, "late");
		deepStrictEqual(await readFile(join(directory, run.runId, "journal.jsonl")), before);
	} finally {
		await journal.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("journal owns a session, flushes call attempts once, and keeps retries linked without shared mutable scope", async () => {
	const stateRoot = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const sessionDirectory = telemetrySessionDirectory(stateRoot, context.sessionId);
	const journal = await openCallJournal({ directory: sessionDirectory, context, writer });
	try {
		await rejects(openCallJournal({ directory: sessionDirectory, context, writer }), /timed out/);
		const call = beginCall(
			{
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
		const liveFacts = retry.settle(callSettlementFromMessage(message, "target-rates"), reportedModelFromMessage(message));
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
		deepStrictEqual(ledgerUsageCalls([...ledger, ...ledger], rows), projected);
		deepStrictEqual(ledgerCallFailureCounts([...ledger, ...ledger], rows), {
			invokedUnknownCalls: 0,
			neverInvokedCalls: 1,
		});
		await journal.close();
		const before = telemetryProducerHealth().unownedRecords;
		strictEqual(telemetryHub().emit("session.closed", { reason: "shutdown" }, context), false);
		strictEqual(telemetryProducerHealth().unownedRecords, before + 1);
	} finally {
		await journal.close();
		await rm(stateRoot, { recursive: true, force: true });
	}
});

test("a flush returns only after the batch a sibling flush started behind the one in flight is written (#434)", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const journal = await openCallJournal({ directory: sessionDirectory, context, writer });
	try {
		telemetryHub().emit("session.opened", {}, context);
		const first = journal.flush();
		// Queued while the first batch is in flight: the first flush waiting on it writes this one as its own batch.
		telemetryHub().emit("session.opened", {}, context);
		const second = journal.flush();
		const third = journal.flush();
		await third;
		// A batch counts as persisted only once its fsync's callback ran, which no flush resolving in the same
		// microtask drain as the batch's start can have seen, so this holds without depending on timing.
		deepStrictEqual([journal.health().persisted, journal.health().queueDepth], [2, 0]);
		await Promise.all([first, second]);
	} finally {
		await journal.close();
	}
});

test("journal overflow and invalid records produce gaps, rotation preserves records, and secrets are redacted", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const journal = await openCallJournal({
		directory: sessionDirectory,
		context,
		writer,
		queueCapacity: 2,
		segmentBytes: 1,
	});
	try {
		for (let n = 0; n < 4; n += 1) telemetryHub().emit("session.opened", {}, context);
		await journal.flush();
		strictEqual(journal.health().dropped, 2);
		telemetryHub().emit("session.opened", { unexpected: "field" }, context);
		await journal.flush();
		strictEqual(journal.health().invalid, 1);
		const call = beginCall(
			{
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
			rows.filter((row) => row.k === "journal.gap").map((row) => row.data),
			[
				{ sink: "journal.jsonl", reason: "writer-drop", count: 2 },
				{ sink: "journal.jsonl", reason: "invalid-record", count: 1 },
			],
		);
		strictEqual(rows.filter((row) => row.k === "session.opened").length, 2);
		const settled = rows.find((row) => row.k === "call.settled");
		ok(settled?.k === "call.settled");
		strictEqual(settled.data.stop.detail, "api_key=[redacted:assignment]");
		ok(rows.some((row) => row.k === "journal.segment_closed"));
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("a segment header says what its mode admits, and a mode change opens a new segment in place (#434)", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	let capture = STANDARD_CAPTURE;
	const journal = await openCallJournal({ directory: sessionDirectory, context, writer, capture: () => capture });
	try {
		telemetryHub().emit("session.opened", {}, context);
		await journal.flush();
		const research = { content: true, deltas: true, providerHeaders: false, systemOneDataset: true, busTrace: false };
		capture = effectiveTelemetryCapture({ mode: "research", research }, false);
		telemetryHub().emit("session.resumed", { via: "resume" }, context);
		await journal.flush();
		const rows = scanTelemetrySegment(await readFile(join(sessionDirectory, "journal.jsonl"))).rows;
		deepStrictEqual(
			rows.map((row) =>
				row.kind === "header" ? `header:${row.header.mode}` : row.kind === "record" ? row.record.k : row.reason,
			),
			["header:standard", "session.opened", "journal.segment_closed", "header:research", "session.resumed"],
		);
		const header = rows[3];
		ok(header?.kind === "header");
		deepStrictEqual(header.header.capture, { ...research, content: false }, "content needs workspace consent");
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("standard mode writes no content-bearing record; content needs research, the flag and consent, under a cap (#434)", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const research = { content: true, deltas: true, providerHeaders: true, systemOneDataset: true, busTrace: false };
	let capture = STANDARD_CAPTURE;
	const journal = await openCallJournal({
		directory: sessionDirectory,
		context,
		writer,
		capture: () => capture,
		researchBytes: 4096,
	});
	const text = {
		label: "resolvable",
		function: "sha256",
		canonicalization: "json-sorted-v1",
		subject: "prompt-text",
		id: `obj_${"a".repeat(64)}`,
	} as const;
	const prompt = { text, bytes: 10 };
	try {
		strictEqual(telemetryHub().emit("prompt.text_captured", prompt, context), false);
		// A forwarded record skips the producer check; the writer still refuses it under standard.
		journal.enqueue({
			kind: "prompt.text_captured",
			data: prompt,
			ctx: context,
			wallMs: Date.now(),
			mono: performance.now(),
		});
		await journal.flush();
		capture = effectiveTelemetryCapture({ mode: "research", research }, false);
		strictEqual(
			telemetryHub().emit("prompt.text_captured", prompt, context),
			false,
			"research without consent keeps no content",
		);
		capture = effectiveTelemetryCapture({ mode: "research", research }, true);
		strictEqual(telemetryHub().emit("prompt.text_captured", prompt, context), true);
		strictEqual(journal.reserveResearchBytes(5000), false, "a preimage past the session cap is refused");
		await journal.flush();
		let admitsContent = false;
		const seen: string[] = [];
		for (const row of scanTelemetrySegment(await readFile(join(sessionDirectory, "journal.jsonl"))).rows) {
			if (row.kind === "header") admitsContent = row.header.capture.content;
			else if (row.kind === "record") {
				if (row.record.cc === "content-bearing") ok(admitsContent, "content only under a header that admits it");
				seen.push(row.record.k === "journal.gap" ? `gap:${(row.record.data as { reason: string }).reason}` : row.record.k);
			}
		}
		deepStrictEqual(seen, ["gap:mode-filtered", "journal.segment_closed", "prompt.text_captured", "gap:research-cap"]);
		strictEqual(journal.health().capped, 1);
		const fold = foldCallJournal((await readCallJournal(sessionDirectory)).records.map(({ record }) => record));
		strictEqual(fold.coverage.gapRecords, 0, "refused research capture never leaves accounting partial");
	} finally {
		await journal.close();
		await rm(sessionDirectory, { recursive: true, force: true });
	}
});

test("a session stores prompt text only under content capture, once per distinct prompt (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const research = { content: true, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false };
	let capture = STANDARD_CAPTURE;
	const journals = createSessionJournals(stateDir, () => {}, { current: () => capture });
	const origin = { id: "prompt-session", cwdHash: "prompthash" };
	const prompt = {
		sections: [],
		fragmentManifest: [],
		systemPrompt: `you are a fixture; api_key=${"secret".repeat(4)}`,
	};
	try {
		const standard = await journals.acquire(origin, { role: "main", id: origin.id });
		await standard.storeRequestObjects?.({ prompt });
		await standard.release();
		capture = effectiveTelemetryCapture({ mode: "research", research }, true);
		for (let n = 0; n < 2; n += 1) {
			const lease = await journals.acquire(origin, { role: "main", id: origin.id });
			await lease.storeRequestObjects?.({ prompt });
			await lease.release();
		}
		const directory = telemetrySessionDirectory(stateDir, origin.id);
		const texts = (await readCallJournal(directory)).records.flatMap(({ record }) =>
			record.k === "prompt.text_captured" ? [record] : [],
		);
		strictEqual(texts.length, 1, "standard stored none, and a repeated prompt is recorded once");
		const stored = await readTelemetryObject(directory, texts[0]?.data.text ?? telemetryCommitment("prompt-text", ""));
		ok(stored.kind === "resolved");
		deepStrictEqual(stored.value, { text: "you are a fixture; api_key=[redacted:assignment]" });
	} finally {
		await journals.closeAll();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("memory and observation traces journal content only under research capture with consent (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const research = { content: true, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false };
	let capture = STANDARD_CAPTURE;
	const journals = createSessionJournals(stateDir, () => {}, { current: () => capture });
	const origin = { id: "trace-session", cwdHash: "tracehash" };
	const leases: Promise<void>[] = [];
	const unregister = registerResearchTraceSink({
		admits: (kind) => captureAdmits(capture, kind),
		record(kind, data, preimage) {
			leases.push(
				journals.acquire(origin, { role: "memory", id: origin.id }).then(async (lease) => {
					telemetryHub().emitContent(kind, data, preimage, lease.context);
					await lease.release();
				}),
			);
		},
	});
	const memoryTrace = createTaskMemoryTrace();
	const secret = `api_key=${"secret".repeat(4)}`;
	const envelope = {
		systemPrompt: "system",
		userPrompt: `task ${secret}`,
		response: "reply",
		decision: "silent",
		reason: "suppressed",
		bankOperations: 0,
		droppedOperations: 0,
		reminder: null,
		error: null,
	} as const;
	try {
		strictEqual(observationTracing(), false, "standard mode builds no observation facts");
		strictEqual(memoryTrace.active(), false, "standard mode builds no memory envelope");
		traceObservation("prepared", { note: secret });
		memoryTrace.record(envelope);
		strictEqual(leases.length, 0);
		capture = effectiveTelemetryCapture({ mode: "research", research }, false);
		strictEqual(observationTracing(), false, "research without consent keeps no content");
		capture = effectiveTelemetryCapture({ mode: "research", research }, true);
		ok(observationTracing() && memoryTrace.active());
		traceObservation("prepared", { note: secret });
		memoryTrace.record(envelope);
		await Promise.all(leases);
		const directory = telemetrySessionDirectory(stateDir, origin.id);
		const records = (await readCallJournal(directory)).records.map(({ record }) => record);
		deepStrictEqual(
			records.filter((record) => record.cc === "content-bearing").map((record) => record.k),
			["memory.observed", "memory.traced"],
		);
		const observation = records.find((record) => record.k === "memory.observed");
		const trace = records.find((record) => record.k === "memory.traced");
		ok(observation?.k === "memory.observed" && trace?.k === "memory.traced");
		strictEqual(trace.data.userPromptChars, envelope.userPrompt.length);
		const observed = await readTelemetryObject(directory, observation.data.content);
		ok(observed.kind === "resolved");
		deepStrictEqual(observed.value, { event: "prepared", facts: { note: "api_key=[redacted:assignment]" } });
		const traced = await readTelemetryObject(directory, trace.data.content);
		ok(traced.kind === "resolved");
		strictEqual((traced.value as { userPrompt: string }).userPrompt, "task api_key=[redacted:assignment]");
	} finally {
		unregister();
		await journals.closeAll();
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("the process journal receives one health window per process, carrying loop lag, RSS and its writers' pressure (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const processJournal = createProcessJournal(stateDir, () => {});
	const health = createHealthWindows({
		active: () => journals.openSessions().length > 0,
		writers: () => openCallJournalHealth().map(({ health }) => health),
		record: (data) => telemetryHub().emit("health.sampled", data),
		windowMs: 50,
	});
	const journals = createSessionJournals(
		stateDir,
		() => {},
		undefined,
		async () => health.start(),
	);
	const origins = [
		{ id: "health-a", cwdHash: "healthhash" },
		{ id: "health-b", cwdHash: "healthhash" },
	];
	try {
		for (const origin of origins) await (await journals.acquire(origin, { role: "main", id: origin.id })).release();
		await new Promise((resolve) => setTimeout(resolve, 130));
		await journals.closeAll();
		await processJournal.close(0);
		for (const origin of origins) {
			const journal = await readCallJournal(telemetrySessionDirectory(stateDir, origin.id));
			ok(!journal.records.some(({ record }) => record.k === "health.sampled"), "no session keeps a process fact");
		}
		const [processId] = await readdir(telemetryProcessesDirectory(stateDir));
		const journal = await readCallJournal(telemetryProcessDirectory(stateDir, processId as string));
		strictEqual(journal.damaged, 0);
		ok(!journal.records.some(({ record }) => record.k === "journal.gap"), "every window passes its own schema");
		const windows = journal.records.flatMap(({ record }) => (record.k === "health.sampled" ? [record.data] : []));
		ok(windows.length >= 1);
		for (const window of windows) {
			ok(window.windowMs > 0 && window.rssBytes > 0);
			ok((window.loopLag?.samples ?? 0) > 0);
			strictEqual(window.writer.dropped, 0);
		}
	} finally {
		health.stop();
		await journals.closeAll();
		await processJournal.close(0);
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("prune removes only idle, unreferenced telemetry past retention and says exactly what (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-prune-"));
	const sessions = join(stateDir, "sessions", "hash");
	const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
	const ended = JSON.stringify({ endedAt: "2026-01-01T00:00:00.000Z", owner: null });
	/** A session's meta.json lives in its store; its journal and objects under the telemetry root. */
	const endSession = async (id: string) => {
		await mkdir(join(sessions, id), { recursive: true });
		await writeFile(join(sessions, id, "meta.json"), ended);
	};
	const journal = async (id: string, work: (ctx: TelemetryContext) => void, scope: "session" | "run" = "session") => {
		const run = scope === "run";
		const directory = run ? telemetryRunDirectory(stateDir, id) : telemetrySessionDirectory(stateDir, id);
		const ctx = run
			? { sessionId: "kept", runId: id, agent: { role: "worker" as const, id } }
			: { sessionId: id, agent: { role: "main" as const, id } };
		const writerJournal = await openCallJournal({ directory, context: ctx, writer });
		work(ctx);
		await writerJournal.close();
		if (!run) await endSession(id);
		return directory;
	};
	const age = async (path: string) => utimes(path, old, old);
	try {
		const expired = await journal("expired", (ctx) => telemetryHub().emit("session.opened", {}, ctx));
		await writeFile(join(sessions, "expired", "current.jsonl"), "{}\n");
		await storeTelemetryObject(expired, "tool-schemas", [{ name: "read" }]);
		await age(join(expired, "journal.jsonl"));
		const live = await journal("live", (ctx) => telemetryHub().emit("session.opened", {}, ctx));
		await age(join(live, "journal.jsonl"));
		await writeFile(join(live, "journal.jsonl.lock"), "{}");
		const parent = await journal("parent", (ctx) => telemetryHub().emit("session.opened", {}, ctx));
		await age(join(parent, "journal.jsonl"));
		seedForkCallJournal(stateDir, "child", {
			parentSessionId: "parent",
			parentCwdHash: "hash",
			parentTurnId: "t1",
			parentTurnAt: "2026-01-01T00:00:00.000Z",
		});
		await endSession("child");
		const keptDirectory = telemetrySessionDirectory(stateDir, "kept");
		await mkdir(keptDirectory, { recursive: true });
		const structure = await storeTelemetryObject(keptDirectory, "tool-schemas", [{ name: "kept" }]);
		const text = await storeTelemetryObject(keptDirectory, "prompt-text", { text: "old prompt" });
		const orphan = await storeTelemetryObject(keptDirectory, "tool-schemas", [{ name: "orphan" }]);
		const research = { content: true, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false };
		const keptJournal = await openCallJournal({
			directory: keptDirectory,
			context: { sessionId: "kept", agent: { role: "main", id: "kept" } },
			writer,
			capture: () => effectiveTelemetryCapture({ mode: "research", research }, true),
		});
		const keptContext = { sessionId: "kept", agent: { role: "main" as const, id: "kept" } };
		telemetryHub().emit(
			"prompt.text_captured",
			{ structure: { ...structure, subject: "prompt-structure" }, text, bytes: 10 },
			keptContext,
		);
		telemetryHub().emit(
			"call.started",
			{
				...{ callId: newCallId(), attemptId: newAttemptId(), attempt: 0 },
				objects: { toolSchemas: structure },
				target: { targetId: "t", runtimeId: "r", api: "a", requestedModel: "m", reportedModel: unknown },
				roundKind: "normal",
				toolChoice: "auto",
			},
			keptContext,
		);
		telemetryHub().emit("run.linked", { runId: "cited" }, keptContext);
		await keptJournal.close();
		await endSession("kept");
		await age(join(keptDirectory, "objects", `${text.id}.json`));
		for (const runId of ["unreferenced", "cited"]) {
			const run = await journal(runId, () => {}, "run");
			await age(join(run, "journal.jsonl"));
		}

		const plan = await planTelemetryPrune(stateDir, DEFAULT_PRUNE_POLICY);
		const relative = (path: string) => path.slice(stateDir.length + 1);
		deepStrictEqual(
			plan.remove.map((action) => `${relative(action.path)}:${action.reason}`).sort(),
			[
				`telemetry/sessions/expired/journal.jsonl:expired`,
				`telemetry/sessions/expired/objects/${(await readdir(join(expired, "objects")))[0]}:expired`,
				`telemetry/runs/unreferenced/journal.jsonl:expired`,
				`telemetry/sessions/kept/objects/${orphan.id}.json:unreferenced-object`,
				`telemetry/sessions/kept/objects/${text.id}.json:research-expired`,
			].sort(),
		);
		deepStrictEqual(plan.held.map((hold) => `${relative(hold.path)}:${hold.reason}`).sort(), [
			"telemetry/runs/cited:referenced-run",
			"telemetry/sessions/live:live",
			"telemetry/sessions/parent:fork-parent",
		]);
		strictEqual((await readdir(join(keptDirectory, "objects"))).length, 3, "a plan removes nothing");
		const result = await applyTelemetryPrune(plan);
		deepStrictEqual(result.removed, plan.remove);
		deepStrictEqual(result.skipped, []);
		deepStrictEqual(
			await readdir(join(sessions, "expired")),
			["current.jsonl", "meta.json"],
			"the ledger is not telemetry",
		);
		deepStrictEqual(await readdir(expired), [], "the expired session keeps no telemetry");
		deepStrictEqual(await readdir(join(keptDirectory, "objects")), [`${structure.id}.json`]);
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("consent is the operator's, covers a workspace subtree by real path, and revocation ends it (#434)", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-consent-"));
	const stateDir = join(root, "state");
	const workspace = join(root, "workspace");
	const session = join(stateDir, "sessions", "hash", "consent-session");
	try {
		await mkdir(join(workspace, "src", ".clio-coder"), { recursive: true });
		await mkdir(session, { recursive: true });
		await symlink(workspace, join(root, "alias"));
		await writeFile(join(session, "meta.json"), JSON.stringify({ cwd: join(root, "alias", "src") }));
		// A file a repository could commit never grants consent.
		await writeFile(join(workspace, "src", ".clio-coder", "telemetry-consent.json"), '{"version":1,"workspaces":{}}');
		const view = createConsentView(stateDir);
		await view.refresh();
		const sessionWorkspace = await view.sessionWorkspace(session);
		strictEqual(view.covers(sessionWorkspace), false);
		const granted = grantTelemetryConsent(stateDir, resolveConsentWorkspace(join(root, "alias")));
		strictEqual(granted.entry.workspace, await realpath(workspace));
		await view.refresh();
		strictEqual(view.covers(sessionWorkspace), true, "a session under the workspace is covered");
		deepStrictEqual(
			readTelemetryConsent(stateDir).entries.map((entry) => entry.workspace),
			[await realpath(workspace)],
		);
		ok(revokeTelemetryConsent(stateDir, granted.entry.workspace));
		await view.refresh();
		strictEqual(view.covers(sessionWorkspace), false);
		strictEqual(revokeTelemetryConsent(stateDir, granted.entry.workspace), null);
	} finally {
		await rm(root, { recursive: true, force: true });
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
	const flags = { content: false, deltas: false, providerHeaders: false, systemOneDataset: true, busTrace: false };
	strictEqual(systemOneDatasetRecording(effectiveTelemetryCapture({ mode: "research", research: flags }, true)), false);
	const content = { ...flags, content: true };
	strictEqual(
		systemOneDatasetRecording(effectiveTelemetryCapture({ mode: "research", research: content }, false)),
		false,
	);
	strictEqual(systemOneDatasetRecording(effectiveTelemetryCapture({ mode: "research", research: content }, true)), true);
	strictEqual(systemOneDatasetRecording(STANDARD_CAPTURE), false);
	await writeFile(user, "version: 2\n");
	const standard = readLayeredSettings(workspace);
	strictEqual(standard.settings.telemetry.mode, "standard");
	ok(standard.issues.some((issue) => issue.origin === "project" && issue.path === "telemetry.mode"));
});

test("only the next owner repairs torn tails; future records survive reopening and reads do not repair", async () => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "telemetry-journal-"));
	const path = join(sessionDirectory, "journal.jsonl");
	let journal = await openCallJournal({ directory: sessionDirectory, context, writer });
	try {
		telemetryHub().emit("session.opened", {}, context);
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
		journal = await openCallJournal({ directory: sessionDirectory, context, writer });
		strictEqual(journal.health().skipped, 1);
		const repaired = await readFile(path);
		deepStrictEqual(repaired.subarray(0, prefix.length), prefix);
		const result = await readCallJournal(sessionDirectory);
		strictEqual(result.damaged, 0);
		strictEqual(result.skipped, 1);
		ok(result.records.some(({ record }) => record.k === "journal.gap" && record.data.reason === "torn-tail"));
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
		target: { targetId: "target", runtimeId: "fixture", api: "fixture", requestedModel: "model", reportedModel: unknown },
		roundKind: "normal",
		toolChoice: "auto",
	});
	const first = started();
	const settle = (start: CallStarted, message: unknown, pricing: "target-rates" | "none" = "none") =>
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
		"target-rates",
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
		makeTelemetryRecord("call.linked", { callId, runId: "run" }, context, clock),
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
		"run.usage_reported",
		aggregate,
		{ sessionId: "session", runId: "run", agent: { role: "worker", id: "run" } },
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
		"run.usage_reported",
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
	const parentDirectory = telemetrySessionDirectory(root, "parent");
	const childDirectory = telemetrySessionDirectory(root, "child");
	const at = Date.parse("2026-10-30T12:00:00.000Z");
	await mkdir(childDirectory, { recursive: true });
	const parent = await openCallJournal({
		directory: parentDirectory,
		context: { sessionId: "parent", agent: { role: "main", id: "parent" } },
		writer,
	});
	const contribute = (
		journal: typeof parent,
		sessionId: string,
		role: "main" | "helper",
		tokens: number,
		wallMs: number,
	) => {
		const callId = newCallId();
		const attemptId = newAttemptId();
		journal.enqueue({
			kind: "call.settled",
			ctx: { sessionId, agent: { role, id: sessionId }, callId, attemptId },
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
					"none",
				),
				callId,
				attemptId,
				attempt: 0,
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
		const parentBytes = await readFile(join(parentDirectory, "journal.jsonl"));
		seedForkCallJournal(root, "child", {
			parentSessionId: "parent",
			parentCwdHash: "workspace",
			parentTurnId: "turn",
			parentTurnAt: new Date(at).toISOString(),
		});
		const child = await openCallJournal({
			directory: childDirectory,
			context: { sessionId: "child", agent: { role: "main", id: "child" } },
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
			readSessionCallJournalSync(root, "parent", entries).records.map(({ record }) => record),
		);
		const childCalls = ledgerUsageCalls(
			entries,
			readSessionCallJournalSync(root, "child", entries).records.map(({ record }) => record),
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
		deepStrictEqual(await readFile(join(parentDirectory, "journal.jsonl")), parentBytes);
		await rm(parentDirectory, { recursive: true });
		const unavailable = readSessionCallJournalSync(root, "child", entries);
		ok(unavailable.skipped > 0);
		const remaining = ledgerUsageCalls(
			entries,
			unavailable.records.map(({ record }) => record),
		);
		// With the parent's journal gone the inherited call is not measured; the ledger supplies no stand-in (#434).
		strictEqual(
			remaining.find((call) => call.callId === inheritedId),
			undefined,
		);
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

test("a crash-orphaned main call counts only when its user turn is on the active path (#434)", () => {
	const owner = { ...context, turnId: "user-1" };
	const call = beginCall(
		{
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
	const facts = call.settle(callSettlementFromMessage(message, "none"));
	ok(facts);
	const scope = { ...owner, callId: facts.callId, attemptId: facts.attemptId };
	const clock = { t: new Date().toISOString(), mono: 1 };
	const { callId, attemptId, attempt, target, roundKind, toolChoice } = facts;
	const rows = [
		makeTelemetryRecord("call.started", { callId, attemptId, attempt, target, roundKind, toolChoice }, scope, clock),
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
		ledgerUsageCalls([user("user-1")], rows).map((row) => row.callId),
		[callId],
		"the settled call survives the lost assistant message",
	);
	deepStrictEqual(ledgerUsageCalls([user("other-branch")], rows), [], "another branch's turn keeps its own calls");
});

test("usage report discovers a standalone run journal that has no session and no receipt (#434)", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "telemetry-standalone-report-"));
	const stateDir = join(scratch, "state");
	const owner = { sessionId: null, runId: "orphan-run", agent: { role: "worker" as const, id: "orphan-run" } };
	const run = await openRunTelemetry(owner, telemetryRunDirectory(stateDir, owner.runId));
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
					...makeTelemetryRecord("run.usage_reported", usage, owner, { t: new Date().toISOString(), mono: 1 }),
					origin: { host: "fixture", pid: 1, birthToken: "fixture", monoEpochWallMs: 1 },
				},
			}),
		);
		await run.close();
		// Appends never bump the run directory; a run created before the window still settled inside it.
		const created = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
		await utimes(telemetryRunDirectory(stateDir, owner.runId), created, created);
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
		const reportDto = JSON.parse(report.stdout) as ReturnType<
			typeof import("../../src/domains/telemetry/read-model.js").usageReport
		>;
		const cost = reportDto.cost.find((row) => row.groupBy === "role");
		strictEqual(cost?.total.tokens.display, "21");
		// `telemetry explain` rebuilds the report's repo window from the reference alone (#434 §11.4).
		const read = new URL("../../src/cli/telemetry-read.ts", import.meta.url).href;
		const explained = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {runTelemetryReadCommand} from ${JSON.stringify(read)}; process.exitCode = await runTelemetryReadCommand(['explain',${JSON.stringify(cost?.total.tokens.ref)},'--json']);`,
			],
			{ encoding: "utf8", env: { ...process.env, ...scratchClioEnvVars(scratch) } },
		);
		strictEqual(explained.status, 0, explained.stderr);
		const explanation = JSON.parse(explained.stdout) as ExplanationV1;
		strictEqual(explanation.value.display, "21");
		deepStrictEqual(explanation.from.runIds, [owner.runId]);
		// `telemetry cost --days` folds the same window under the same reference (#434 §11.3).
		const windowed = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {runTelemetryReadCommand} from ${JSON.stringify(read)}; process.exitCode = await runTelemetryReadCommand(['cost','--days','30','--json']);`,
			],
			{ encoding: "utf8", env: { ...process.env, ...scratchClioEnvVars(scratch) } },
		);
		strictEqual(windowed.status, 0, windowed.stderr);
		const windowCost = JSON.parse(windowed.stdout) as CostReportV1;
		deepStrictEqual(windowCost.scope, { repo: "all", days: 30 });
		deepStrictEqual(windowCost.total.tokens, cost?.total.tokens);
	} finally {
		await run.close();
		await rm(scratch, { recursive: true, force: true });
	}
});

test("fleet status reads unknown journal facts even when the ledger holds token counts (#434 §11.3)", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "telemetry-fleet-status-"));
	const stateDir = join(scratch, "state");
	const row = (id: string, usage: Record<string, number>) => ({
		id,
		agentId: "scout",
		task: "t",
		status: "completed",
		startedAt: "2026-10-30T00:00:00.000Z",
		endedAt: "2026-10-30T00:01:00.000Z",
		pid: 1,
		tokenCount: 100,
		costUsd: 0.12,
		costProvenance: "known",
		runtimeKind: "native",
		cwd: scratch,
		...usage,
	});
	try {
		await mkdir(stateDir, { recursive: true });
		await writeFile(
			join(stateDir, "runs.json"),
			JSON.stringify([
				row("whole", { apiCalls: 2, missingTokenCalls: 0, inputTokenCount: 70, outputTokenCount: 30 }),
				// Written before the ledger carried a split or call coverage, with no receipt to supply them.
				row("legacy", {}),
			]),
		);
		const cli = new URL("../../src/cli/fleet.ts", import.meta.url).href;
		const status = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import {runFleetCommand} from ${JSON.stringify(cli)}; process.exitCode = await runFleetCommand(['status','--all','--json']);`,
			],
			{ encoding: "utf8", env: { ...process.env, ...scratchClioEnvVars(scratch) } },
		);
		strictEqual(status.status, 0, status.stderr);
		const { totals } = JSON.parse(status.stdout) as {
			totals: ReturnType<typeof import("../../src/domains/telemetry/read-model.js").fleetTotals>;
		};
		strictEqual(totals.input.fact.measured, 0, "a ledger count supplies no journal fact");
		ok(totals.input.fact.unknownCount >= 2);
		ok(totals.total.fact.unknownCount >= 2);
		match(totals.input.display, /unknown/);
		match(totals.total.display, /unknown/);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
