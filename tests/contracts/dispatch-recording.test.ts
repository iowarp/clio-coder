import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { CallStarted } from "../../src/core/telemetry/schemas.js";
import { clioDataDir, clioStateDir } from "../../src/core/xdg.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { createRecordingJournal, parseRecordingCast, readRunRecording } from "../../src/domains/dispatch/recording.js";
import { readRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import { attachRunEventJournalBridge } from "../../src/domains/dispatch/run-event-journal-bridge.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { buildEvidence } from "../../src/domains/evidence/build.js";
import { exportEvidenceRecordings } from "../../src/domains/evidence/recordings.js";
import { inspectEvidence } from "../../src/domains/evidence/store.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

let env: Awaited<ReturnType<typeof isolateClioEnv>>;
beforeEach(async () => {
	env = await isolateClioEnv("clio-coder-recording-");
});
afterEach(() => env.restore());
const node = { id: "seven", kind: "ssh" as const, host: "fixture.invalid" };

it("records display events without input, raw tools, reasoning, or worker protocol wrapping", () => {
	let clock = 0;
	const journal = createRecordingJournal({ nowMs: () => clock });
	const bus = createSafeEventBus();
	const bridge = attachRunEventJournalBridge(bus, {
		journal,
		nowMs: () => clock,
		acceptRun: (id) => journal.accepts(id),
	});
	journal.start("fixture", node);
	const event = (event: unknown) =>
		bus.emit(BusChannels.DispatchProgress, { runId: "fixture", agentId: "coder", event });
	event({ type: "tool_execution_start", args: { password: "raw-tool-secret" } });
	event({ type: "thinking_delta", delta: "private reasoning must not appear" });
	event({ type: "text_delta", delta: "warning: password=abcd" });
	clock = 300;
	event({ type: "text_delta", delta: "efghijkl" });
	clock = 600;
	event({ type: "text_delta", delta: "\ncorrection: verified\n" });
	event({
		type: "clio_coder_tool_finish",
		payload: { tool: "bash", action: { object: "passing command" }, outcome: "ok" },
	});
	journal.terminal("fixture", "succeeded");
	bridge.stop();
	const source = readRunRecording(clioStateDir(), "fixture");
	ok(source?.cast);
	equal(source.manifest.completion, "complete");
	deepStrictEqual(source.manifest.node, node);
	const text = parseRecordingCast(source.cast)
		.map((frame) => frame[2])
		.join("");
	match(text, /warning/);
	match(text, /correction/);
	match(text, /passing command/);
	equal(text.includes("abcdefghijkl"), false);
	equal(text.includes("raw-tool-secret"), false);
	equal(text.includes("private reasoning"), false);
	ok(source.manifest.redactionCount > 0);
	equal(source.manifest.bytes, Buffer.byteLength(source.cast));
	equal(source.manifest.sha256, createHash("sha256").update(source.cast).digest("hex"));
	equal(statSync(join(clioStateDir(), source.manifest.castPath ?? "")).mode & 0o777, 0o600);
});

it("redacts a secret split across separate text frames and strips OSC/CSI", () => {
	const journal = createRecordingJournal();
	journal.start("split", node);
	journal.append("split", { at: "", type: "text", detail: "token=abcdefgh" });
	journal.append("split", { at: "", type: "text", detail: "ijklmnop\u001b]52;c;clipboard\u0007\u001b[31m\n" });
	journal.terminal("split", "succeeded");
	const cast = readRunRecording(clioStateDir(), "split")?.cast ?? "";
	equal(cast.includes("abcdefgh"), false);
	equal(cast.includes("ijklmnop"), false);
	equal(cast.includes("clipboard"), false);
	equal(cast.includes("\\u001b"), false);
	match(cast, /redacted/);
});

it("caps bytes, marks gaps and duration, and preserves a replayable canceled capture", () => {
	let clock = 0;
	const journal = createRecordingJournal({ maxBytes: 1024, maxDurationMs: 100, nowMs: () => clock });
	journal.start("bounded", node);
	journal.append("bounded", { at: "", type: "text", detail: "before\n" });
	journal.append("bounded", { at: "", type: "text", detail: "x".repeat(2000) });
	clock = 101;
	journal.append("bounded", { at: "", type: "text", detail: "after duration" });
	journal.terminal("bounded", "canceled");
	const source = readRunRecording(clioStateDir(), "bounded");
	ok(source?.cast);
	equal(source.manifest.completion, "incomplete");
	equal(source.manifest.droppedFrames, 2);
	ok(source.manifest.bytes <= 1024);
	match(source.cast, /capture gap/);
	parseRecordingCast(source.cast);
});

it("shutdown seals a partial capture, and unregistered journal traffic creates no recording", () => {
	const journal = createRecordingJournal();
	journal.append("off", { at: "", type: "text", detail: "ignored" });
	equal(readRunRecording(clioStateDir(), "off"), null);
	journal.start("network-loss", node);
	journal.stop();
	equal(readRunRecording(clioStateDir(), "network-loss")?.manifest.completion, "incomplete");
});

it("reports disk failure without throwing into dispatch", () => {
	const badRoot = join(env.dir, "file");
	writeFileSync(badRoot, "x");
	const warnings: string[] = [];
	const journal = createRecordingJournal({ stateDir: badRoot, warn: (text) => warnings.push(text) });
	journal.start("failed", node);
	journal.terminal("failed", "succeeded");
	ok(warnings.length > 0);
});

it("exports recording evidence with exact references and leaves receipt trust intact", async () => {
	const run = fixtureEnvelope("fixture");
	const journal = createRecordingJournal();
	run.recording = journal.start(run.id, node);
	journal.append(run.id, { at: "", type: "text", detail: "warning\ncorrection\n" });
	journal.terminal(run.id, "succeeded");
	mkdirSync(join(clioStateDir(), "receipts"), { recursive: true });
	writeFileSync(join(clioStateDir(), "runs.json"), JSON.stringify([run]));
	writeFileSync(
		join(clioStateDir(), "receipts", `${run.id}.json`),
		JSON.stringify(withReceiptIntegrity(fixtureReceiptDraft(run), run)),
	);
	const built = await buildEvidence({ dataDir: clioDataDir(), stateDir: clioStateDir(), runId: run.id });
	const manifest = built.overview.recordings?.[0];
	ok(manifest?.castPath);
	ok(built.overview.files.includes(manifest.castPath));
	const cast = readFileSync(join(built.directory, manifest.castPath), "utf8");
	parseRecordingCast(cast);
	equal(createHash("sha256").update(cast).digest("hex"), manifest.sha256);
	deepStrictEqual(
		(await inspectEvidence(clioDataDir(), built.evidenceId)).overview.recordings,
		built.overview.recordings,
	);
	equal(
		built.findings.some((finding) => finding.tag === "receipt-integrity"),
		false,
	);
});

it("rejects corrupt, missing and redirected capture files, retaining visible evidence failures", () => {
	const run = fixtureEnvelope("corrupt");
	const journal = createRecordingJournal();
	run.recording = journal.start(run.id, node);
	journal.terminal(run.id, "succeeded");
	writeFileSync(join(clioStateDir(), "runs", run.id, "recording.cast"), "corrupt");
	const failed = exportEvidenceRecordings(clioStateDir(), join(clioDataDir(), "fixture"), [run]);
	equal(failed[0]?.completion, "failed");
	equal(failed[0]?.castPath, null);
	match(failed[0]?.error ?? "", /checksum/);
	const missing = fixtureEnvelope("missing");
	missing.recording = { manifestPath: "ignored" };
	equal(exportEvidenceRecordings(clioStateDir(), clioDataDir(), [missing])[0]?.completion, "failed");
	symlinkSync(env.dir, join(clioStateDir(), "runs", "escape"));
	throws(() => journal.start("../escape", node));
	throws(() => readRunRecording(clioStateDir(), "escape"), /directory/);
});

it("strict reader rejects input capture, environment, terminal controls and nonmonotonic timestamps", () => {
	const header = JSON.stringify({ version: 2, width: 100, height: 30, timestamp: 1 });
	for (const event of [
		[0, "i", "secret"],
		[-1, "o", "bad"],
		[Infinity, "o", "bad"],
		[0, "o", "\u001b[31m"],
	])
		throws(() => parseRecordingCast(`${header}\n${JSON.stringify(event)}\n`));
	throws(() => parseRecordingCast(`${header}\n[1,"o","ok"]\n[0,"o","bad"]\n`));
	throws(() =>
		parseRecordingCast(
			`${JSON.stringify({ version: 2, width: 100, height: 30, timestamp: 1, env: { TOKEN: "secret" } })}\n`,
		),
	);
});

it("dispatch preserves the explicit capture option with journal history disabled on local and SSH placement", async () => {
	for (const placed of [false, true]) {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.nodes = [{ id: node.id, host: node.host, maxWorkers: 1 }];
		const base = dispatchStubContext({ settings });
		const journals = createSessionJournals(clioStateDir(), () => {
			throw new Error("session journal unavailable");
		});
		const context = {
			bus: base.bus,
			getContract: ((name: string) =>
				name === "telemetry"
					? { acquireTelemetrySession: journals.acquire }
					: base.getContract(name)) as typeof base.getContract,
		};
		let selectedSession = placed ? null : { id: "original-session", cwdHash: "original-cwd" };
		const originalPath = process.env.PATH;
		const bin = join(env.dir, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "ssh"), "#!/bin/sh\nprintf 'shared=yes\\n'\n", { mode: 0o755 });
		if (placed) process.env.PATH = `${bin}:${originalPath ?? ""}`;
		const spawnWorker = (spec: WorkerSpec) => ({
			pid: null,
			heartbeatAt: { current: Date.now(), monotonic: performance.now() },
			abort() {},
			promise: Promise.resolve({ exitCode: 0, signal: null, droppedDisplayFrames: placed ? 3 : 0 }),
			events: (async function* () {
				ok(spec.telemetryContext);
				selectedSession = { id: "next-session", cwdHash: "different-cwd" };
				const call: CallStarted = {
					callId: newCallId(),
					attemptId: newAttemptId(),
					attempt: 0,
					label: "worker",
					roundKind: "normal",
					toolChoice: "auto",
					target: {
						targetId: "fixture",
						runtimeId: "fixture",
						api: "fixture",
						requestedModel: "fixture",
						reportedModel: { kind: "unknown", reason: "not-observed" },
					},
				};
				const owner = { ...spec.telemetryContext, callId: call.callId, attemptId: call.attemptId };
				const origin = {
					host: placed ? "remote-worker" : "local-worker",
					pid: 42,
					birthToken: "fixture",
					monoEpochWallMs: 0,
				};
				yield {
					type: "clio_coder_telemetry",
					record: { ...makeTelemetryRecord("call.started", call, owner, { t: new Date().toISOString(), mono: 0 }), origin },
				};
				yield { type: "text_delta", delta: "warning: preliminary\ncorrection: inspected original\n" };
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						usage: { input: 999, output: 999, cost: { total: 999 } },
						content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
					},
				};
				yield { type: "agent_end" };
				yield {
					type: "clio_coder_telemetry",
					record: {
						...makeTelemetryRecord(
							"call.settled",
							{
								...call,
								stages: { settle: 1 },
								...callSettlementFromMessage({ stopReason: "stop", usage: { input: 5, output: 1 } }, "unknown"),
							},
							owner,
							{ t: new Date().toISOString(), mono: 1 },
						),
						origin,
					},
				};
			})(),
		});
		const bundle = makeDispatchBundle(context, {
			spawnWorker,
			journalRunEvents: false,
			getSessionOrigin: () => selectedSession,
			...(placed ? { resolveNode: () => ({ node, spawn: spawnWorker }), previewNode: () => ({ node }) } : {}),
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "researcher",
				task: "Inspect isolated evidence.",
				cwd: env.dir,
				requestOrigin: "internal",
				record: true,
				resultContractOverride: { kind: "provenance-report" },
			});
			const receipt = await handle.finalPromise;
			equal(receipt.tokenCount, 6);
			equal(receipt.apiCalls, 1);
			equal(receipt.missingTokenCalls, 1);
			equal(receipt.costProvenance, "unknown");
			equal(receipt.cacheReadTokenCount, undefined);
			const journal = await readCallJournal(join(clioStateDir(), "runs", handle.runId), "events.ndjson");
			equal(journal.damaged, 0);
			deepStrictEqual(
				journal.records.map(({ record }) => record.k),
				["call.started", "call.settled", "run.settled"],
			);
			const settled = journal.records[2]?.record;
			ok(settled?.k === "run.settled");
			equal(settled.data.terminalReason, receipt.terminalReason);
			deepStrictEqual(settled.data.callIds, receipt.callIds);
			deepStrictEqual(receipt.callIds, [journal.records[0]?.record.ctx.callId]);
			ok(
				journal.records
					.slice(0, 2)
					.every(
						({ record, origin }) =>
							record.ctx.sessionId === (placed ? null : "original-session") &&
							origin.host === (placed ? "remote-worker" : "local-worker"),
					),
			);
			deepStrictEqual(readRunEventJournal(handle.runId).lines, [], "disabled display history never suppresses call facts");
			const session = await readCallJournal(join(clioStateDir(), "sessions", "original-cwd", "original-session"));
			const references = session.records.filter(({ record }) => record.k === "call.ref");
			equal(references.length, 1, "only the parented run adds a reference, once per logical call");
			if (!placed) {
				const reference = references[0]?.record;
				ok(reference?.k === "call.ref");
				equal(reference.data.runId, handle.runId);
				equal(reference.data.callId, journal.records[0]?.record.ctx.callId);
				equal(reference.ctx.runId, undefined, "references use the session writer, never the run writer");
			}
			equal(
				existsSync(join(clioStateDir(), "sessions", "different-cwd")),
				false,
				"session switches cannot move ownership",
			);
			const run = bundle.contract.listRuns().find((run) => run.id === handle.runId);
			ok(run?.recording);
			const source = readRunRecording(clioStateDir(), handle.runId);
			ok(source?.cast);
			match(source.cast, /warning/);
			match(source.cast, /correction/);
			equal(source.manifest.node.kind, placed ? "ssh" : "local");
			equal(source.manifest.outcome, receipt.outcome);
			equal(source.manifest.droppedFrames, placed ? 3 : 0);
			equal(source.manifest.completion, receipt.outcome === "succeeded" && !placed ? "complete" : "incomplete");
		} finally {
			await bundle.extension.stop?.();
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	}
});

it("run event journal keeps the per-call cacheReadReported flag through a write and read", () => {
	const bus = createSafeEventBus();
	const bridge = attachRunEventJournalBridge(bus, {});
	const send = (usage: Record<string, unknown>) =>
		bus.emit(BusChannels.DispatchProgress, {
			runId: "cache-flag",
			agentId: "coder",
			event: { type: "message_end", message: { role: "assistant", usage } },
		});
	send({ input: 10, output: 2, cacheReadReported: true });
	send({ input: 10, output: 2, cacheReadReported: false });
	send({ input: 10, output: 2 });
	bridge.stop();
	const flags = readRunEventJournal("cache-flag").lines.flatMap((line) =>
		line.kind === "event" && line.usage ? [line.usage.cacheReadReported] : [],
	);
	deepStrictEqual(flags, [true, false, undefined]);
});

it("a worker killed mid-call keeps the calls it settled and settles its open attempt as sent (#434)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const spawnWorker = (spec: WorkerSpec) => ({
		pid: null,
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {},
		promise: Promise.resolve({
			exitCode: 1,
			signal: "SIGKILL" as const,
			evidenceIncomplete: "the worker was terminated by SIGKILL before it finished its output",
		}),
		events: (async function* () {
			const context = spec.telemetryContext;
			ok(context);
			const origin = { host: "local-worker", pid: 42, birthToken: "fixture", monoEpochWallMs: 0 };
			const frame = (kind: "call.started" | "call.settled", data: CallStarted, extra = {}) => ({
				type: "clio_coder_telemetry",
				record: {
					...makeTelemetryRecord(
						kind,
						{ ...data, ...extra } as CallStarted,
						{ ...context, callId: data.callId, attemptId: data.attemptId },
						{ t: new Date().toISOString(), mono: 0 },
					),
					origin,
				},
			});
			for (let index = 0; index < 4; index += 1) {
				const call: CallStarted = {
					callId: newCallId(),
					attemptId: newAttemptId(),
					attempt: 0,
					label: "worker",
					roundKind: "normal",
					toolChoice: "auto",
					target: {
						targetId: "fixture",
						runtimeId: "fixture",
						api: "fixture",
						requestedModel: "fixture",
						reportedModel: { kind: "unknown", reason: "not-observed" },
					},
				};
				yield frame("call.started", call);
				if (index === 3) return;
				yield frame("call.settled", call, {
					stages: { settle: 1 },
					...callSettlementFromMessage({ stopReason: "toolUse", usage: { input: 5, output: 1 } }, "unknown"),
				});
			}
		})(),
	});
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), { spawnWorker, journalRunEvents: false });
	await bundle.extension.start();
	try {
		const handle = await bundle.contract.dispatch({
			agentId: "scout",
			executionRole: "researcher",
			task: "Inspect isolated evidence.",
			cwd: env.dir,
			requestOrigin: "internal",
		});
		const receipt = await handle.finalPromise;
		equal(receipt.apiCalls, 4);
		equal(receipt.tokenCount, 18);
		const journal = await readCallJournal(join(clioStateDir(), "runs", handle.runId), "events.ndjson");
		const records = journal.records.map(({ record }) => record);
		deepStrictEqual(
			records.map((record) => (record.k === "gap" ? `gap:${record.data.reason}` : record.k)),
			[
				...Array.from({ length: 3 }, () => ["call.started", "call.settled"]).flat(),
				"call.started",
				"gap:writer-drop",
				"call.settled",
				"run.settled",
			],
		);
		const open = records[6];
		const settled = records[8];
		ok(open?.k === "call.started" && settled?.k === "call.settled");
		equal(settled.data.attemptId, open.data.attemptId);
		equal(settled.data.disposition, "sent_unsettled");
		deepStrictEqual(settled.data.usage?.input, { kind: "unknown", reason: "not-observed" });
	} finally {
		await bundle.extension.stop?.();
	}
});
