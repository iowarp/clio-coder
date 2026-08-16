/**
 * The operator-facing half of a dispatched run: what `/run` and `/delegate` put
 * in the transcript, what `--share` and `/share` hand to the main agent, and
 * what stays out of the model's context when neither was asked for.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { WORKER_SHARE_MAX_BYTES } from "../../src/interactive/worker-share.js";
import type { WorkerEntryState } from "../../src/interactive/worker-stream.js";

const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Recorder {
	ctx: SlashCommandContext;
	echoed: string[];
	submitted: string[];
	notes: string[];
	notices: string[];
	requests: unknown[];
	workerRuns: WorkerEntryState[];
}

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		runId: "r1",
		agentId: "coder",
		outcome: "succeeded",
		exitCode: 0,
		output: { state: "final", text: "Hello! I'm the coder worker.", bytes: 28, truncated: false },
		...overrides,
	} as unknown as RunReceipt;
}

/** A settled worker block as the reducer would leave it after a finished run. */
function workerEntry(overrides: Partial<WorkerEntryState> = {}): WorkerEntryState {
	return {
		assignmentId: "r1",
		runId: "r1",
		origin: "user",
		agentId: "coder",
		runtime: { kind: "clio", targetId: "mini", wireModelId: "Nemo-3.5" },
		text: "Hello! I'm the coder worker.",
		droppedLines: 0,
		tools: [],
		attempts: [{ runId: "r1", targetLabel: "mini/Nemo-3.5" }],
		pending: false,
		receipt: { outcome: "succeeded", tokenCount: 4800, durationMs: 9600 },
		...overrides,
	};
}

function recorder(options: { receipt?: RunReceipt; workerRuns?: WorkerEntryState[] } = {}): Recorder {
	const echoed: string[] = [];
	const submitted: string[] = [];
	const notes: string[] = [];
	const notices: string[] = [];
	const requests: unknown[] = [];
	const workerRuns = options.workerRuns ?? [];
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: unknown) => {
			requests.push(request);
			return {
				runId: "r1",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(options.receipt ?? receipt()),
			};
		},
	} as unknown as DispatchContract;

	const ctx: SlashCommandContext = {
		io: { stdout: () => undefined, stderr: () => undefined },
		notice: (level, text) => notices.push(`${level}:${text}`),
		dispatch,
		bus: createSafeEventBus(),
		echoOperatorCommand: (text) => echoed.push(text),
		submitOperatorNote: (text) => notes.push(text),
		listWorkerRuns: () => workerRuns,
		shutdown: () => undefined,
		runInit: () => undefined,
		runContextClear: () => undefined,
		listPrompts: () => ({ items: [], diagnostics: [] }),
		listExtensions: () => [],
		listAgents: () => [],
		listDelegationAgents: () => [],
		openCost: () => undefined,
		openContextView: () => undefined,
		openTasks: () => undefined,
		openMemory: () => undefined,
		openView: () => undefined,
		openModel: () => undefined,
		providers: {} as ProvidersContract,
		applyModelRef: () => undefined,
		openSettings: () => undefined,
		openResume: () => undefined,
		startNewSession: () => undefined,
		openTree: () => undefined,
		openMessagePicker: () => undefined,
		openHelp: () => undefined,
		openAgents: () => undefined,
		openPrompts: () => undefined,
		openExtensions: () => undefined,
		runCompact: () => undefined,
		exportTranscript: () => undefined,
		verifyReceipt: () => ({ ok: false, reason: "missing" }),
		submitChat: (text) => submitted.push(text),
		render: () => undefined,
	};
	return { ctx, echoed, submitted, notes, notices, requests, workerRuns };
}

describe("contracts/worker run commands", () => {
	it("echoes the typed line above the block the run draws", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run coder say hello"), r.ctx);
		await flushAsync();
		deepStrictEqual(r.echoed, ["/run coder say hello"]);
	});

	it("echoes the whole line, flags included, for /run and /delegate alike", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run --target mini coder say hello"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/delegate codex refactor the header"), r.ctx);
		await flushAsync();
		deepStrictEqual(r.echoed, ["/run --target mini coder say hello", "/delegate codex refactor the header"]);
	});

	it("never echoes a command that did not run", () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/delegate"), r.ctx);
		deepStrictEqual(r.echoed, []);
		ok(
			r.notices.every((notice) => notice.startsWith("info:")),
			`usage notices only:\n${r.notices.join("\n")}`,
		);
	});

	it("keeps a successful run out of the notice bar and out of the model's context", async () => {
		const r = recorder({ workerRuns: [workerEntry()] });
		dispatchSlashCommand(parseSlashCommand("/run coder say hello"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/delegate codex refactor the header"), r.ctx);
		await flushAsync();
		deepStrictEqual(r.notices, [], "the transcript block is the success signal");
		deepStrictEqual(r.submitted, [], "a worker answer never reaches the model on its own");
		deepStrictEqual(r.notes, [], "and no operator note is written on its behalf");
		strictEqual((r.requests[0] as { requestOrigin?: string }).requestOrigin, "user");
	});

	it("hands the receipt's answer to the main agent when --share asked for it", async () => {
		const r = recorder();
		dispatchSlashCommand(parseSlashCommand("/run --share coder say hello"), r.ctx);
		await flushAsync();
		deepStrictEqual(r.notes, ["[worker result] coder · run r1 · ok\nHello! I'm the coder worker."]);
	});

	it("shares a delegated peer's answer under the same note shape", async () => {
		const r = recorder({ receipt: receipt({ agentId: "codex", outcome: "succeeded" }) });
		dispatchSlashCommand(parseSlashCommand("/delegate --share codex refactor the header"), r.ctx);
		await flushAsync();
		deepStrictEqual(r.notes, ["[worker result] codex · run r1 · ok\nHello! I'm the coder worker."]);
	});

	it("shares the newest finished run the operator started when /share names none", () => {
		const r = recorder({
			workerRuns: [
				workerEntry({ assignmentId: "old", runId: "old", text: "stale" }),
				workerEntry({ assignmentId: "agent-1", runId: "agent-1", origin: "agent", text: "scout says" }),
				workerEntry({ assignmentId: "r9", runId: "r9", text: "the newest answer" }),
				workerEntry({ assignmentId: "live", runId: "live", pending: true, text: "still going" }),
			],
		});
		dispatchSlashCommand(parseSlashCommand("/share"), r.ctx);
		deepStrictEqual(r.notes, ["[worker result] coder · run r9 · ok\nthe newest answer"]);
	});

	it("never defaults to a run the model asked for, whatever origin admitted it", () => {
		const r = recorder({
			workerRuns: [
				workerEntry({ assignmentId: "mine", runId: "mine", text: "the operator's own answer" }),
				// A scout successor: user origin by admission, spawned by a dispatch call.
				workerEntry({ assignmentId: "s1", runId: "s1", text: "successor findings", parentToolCallId: "call_1" }),
				// A compete judge: agent origin, spawned by the same call.
				workerEntry({
					assignmentId: "j1",
					runId: "j1",
					origin: "agent",
					text: "judge verdict",
					parentToolCallId: "call_1",
				}),
			],
		});
		dispatchSlashCommand(parseSlashCommand("/share"), r.ctx);
		deepStrictEqual(r.notes, ["[worker result] coder · run mine · ok\nthe operator's own answer"]);
		// Naming either still works: sharing on purpose is always the operator's call.
		dispatchSlashCommand(parseSlashCommand("/share s1"), r.ctx);
		strictEqual(r.notes.length, 2);
	});

	it("shares a run named by its assignment or by the attempt a failover left behind", () => {
		const r = recorder({
			workerRuns: [
				workerEntry({
					assignmentId: "a1",
					runId: "a2",
					text: "the second attempt",
					attempts: [
						{ runId: "a1", targetLabel: "mini/Nemo-3.5", outcome: "failed" },
						{ runId: "a2", targetLabel: "dynamo/qwen3" },
					],
				}),
			],
		});
		dispatchSlashCommand(parseSlashCommand("/share a1"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/share a2"), r.ctx);
		deepStrictEqual(r.notes, [
			"[worker result] coder · run a2 · ok\nthe second attempt",
			"[worker result] coder · run a2 · ok\nthe second attempt",
		]);
	});

	it("says so rather than sharing nothing", () => {
		const r = recorder({ workerRuns: [workerEntry({ assignmentId: "r1", runId: "r1", text: "" })] });
		dispatchSlashCommand(parseSlashCommand("/share"), r.ctx);
		dispatchSlashCommand(parseSlashCommand("/share nope"), r.ctx);
		deepStrictEqual(r.notes, []);
		deepStrictEqual(r.notices, ["error:run r1 produced no text to share", "error:no finished run nope in this session"]);
	});

	it("bounds a shared answer to what a receipt can hold", () => {
		const r = recorder({ workerRuns: [workerEntry({ text: "x".repeat(20_000) })] });
		dispatchSlashCommand(parseSlashCommand("/share"), r.ctx);
		const note = r.notes[0] ?? "";
		ok(Buffer.byteLength(note, "utf8") <= WORKER_SHARE_MAX_BYTES + 128, `bounded, got ${note.length} chars`);
		ok(note.endsWith("[worker output truncated]"), "and says that it was cut");
	});

	it("keeps the archive senses of /share working", () => {
		const exported: string[] = [];
		const r = recorder();
		r.ctx.exportShareArchive = (path) => {
			exported.push(path);
			return { fileCount: 3, path };
		};
		dispatchSlashCommand(parseSlashCommand("/share export /tmp/archive.json"), r.ctx);
		deepStrictEqual(exported, ["/tmp/archive.json"]);
		deepStrictEqual(r.notes, [], "an archive export is not a worker share");
	});
});
