/**
 * Three parallel workers streaming thousands of deltas once filled the trace
 * queue in 32 s and stalled the interactive main thread, because every
 * `message_update` frame became its own synchronous SQLite transaction (#428).
 * Display-only deltas now never reach the queue and a tick's facts share one
 * transaction, so the events table stays at a handful of fact rows per run
 * however many deltas stream, and the dispatch-window lag sampler keeps its
 * p99 inside the epic's budget and its max under a stall-shaped ceiling. The
 * pre-fix store wrote 352 to 1,676 rows per run for this same drive and
 * dropped 23,767 frames; this build writes 16.
 */
import { equal, ok } from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { spawnWorkerProcess } from "../../src/domains/dispatch/worker-spawn.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createDispatchTraceMirror, TraceReader, traceDatabasePath } from "../../src/domains/telemetry/trace-store.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";

const WORKER_ENTRY = fileURLToPath(new URL("../../src/worker/entry.ts", import.meta.url));
const WORKERS = 3;
const DELTAS_PER_RESPONSE = 3_000;
/** Fact rows one streamed call leaves behind: observed 16, independent of the delta count. */
const MAX_FACT_ROWS_PER_RUN = 32;
/** A stall-shaped ceiling, not the fix's own signature: this build measured 23 to 43 ms. */
const MAX_LOOP_LAG_MS = 250;
/** The loop-lag budget's p99 (#434 P0.10); this build measured 9.8 ms over about 430 samples. */
const MAX_LOOP_LAG_P99_MS = 50;
/**
 * The window's p99 comes from one histogram over every 10 ms tick it sampled. Below 100 ticks a p99 is just the
 * window's worst tick, so a shorter window cannot speak for the budget.
 */
const MIN_LAG_SAMPLES = 100;
const DISPLAY_DELTA_KINDS = new Set([
	"message_update",
	"text_delta",
	"thinking_delta",
	"toolcall_delta",
	"tool_execution_update",
]);

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

it("keeps three streaming workers to fact rows and a bounded main-thread lag", { timeout: 60_000 }, async (t) => {
	const sse = (content: string, finish: string | null) =>
		`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }] })}\n\n`;
	const body = `${Array.from({ length: DELTAS_PER_RESPONSE }, (_, i) => sse(`word${i} `, null)).join("")}${sse("done", "stop")}data: [DONE]\n\n`;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		res.setHeader("content-type", "text/event-stream");
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.targets = [{ id: "fixture", runtime: "litellm", url, defaultModel: "fixture" }];
	settings.fleet.default.target = "fixture";
	settings.fleet.default.model = "fixture";
	const context = dispatchStubContext({ settings, runtime: litellm });
	const stateDir = process.env.CLIO_CODER_STATE_DIR;
	ok(stateDir);
	const warnings: string[] = [];
	const mirror = createDispatchTraceMirror(traceDatabasePath(stateDir), { warn: (message) => warnings.push(message) });
	const deltasOnBus = new Map<string, number>();
	const unsubscribes = [
		context.bus.on(BusChannels.DispatchProgress, (payload) => {
			const event = payload.event as { type?: unknown } | null;
			if (event?.type !== "message_update") return;
			deltasOnBus.set(payload.runId, (deltasOnBus.get(payload.runId) ?? 0) + 1);
		}),
	];
	// The same five channels the telemetry extension mirrors.
	for (const channel of [
		BusChannels.DispatchEnqueued,
		BusChannels.DispatchStarted,
		BusChannels.DispatchProgress,
		BusChannels.DispatchCompleted,
		BusChannels.DispatchFailed,
	] as const) {
		unsubscribes.push(context.bus.on(channel, (payload) => mirror.enqueue(channel, payload)));
	}
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec, options) =>
			spawnWorkerProcess(process.execPath, ["--import", import.meta.resolve("tsx"), WORKER_ENTRY], spec, options),
	});
	await bundle.extension.start();
	try {
		const runs = await Promise.all(
			Array.from({ length: WORKERS }, (_, i) =>
				bundle.contract.dispatch({
					agentId: "scout",
					task: `Stream fixture ${i}.`,
					executionRole: "researcher",
					requestOrigin: "internal",
					resultContractOverride: { kind: "external-delegation" },
				}),
			),
		);
		const receipts = await Promise.all(runs.map((run) => run.finalPromise));
		await mirror.flush();
		const reader = new TraceReader(traceDatabasePath(stateDir));
		try {
			for (const receipt of receipts) {
				equal(receipt.outcome, "succeeded", receipt.outcomeDetail ?? receipt.outcome);
				ok(
					(deltasOnBus.get(receipt.runId) ?? 0) >= DELTAS_PER_RESPONSE,
					`${receipt.runId} streamed ${deltasOnBus.get(receipt.runId) ?? 0} deltas to the bus`,
				);
				const kinds = reader.eventKindCounts(receipt.runId);
				const deltaRows = kinds.filter((kind) => DISPLAY_DELTA_KINDS.has(kind.type));
				equal(deltaRows.length, 0, `${receipt.runId} persisted delta rows: ${JSON.stringify(deltaRows)}`);
				const rows = kinds.reduce((total, kind) => total + kind.count, 0);
				ok(rows <= MAX_FACT_ROWS_PER_RUN, `${receipt.runId} wrote ${rows} rows: ${JSON.stringify(kinds)}`);
			}
			equal(warnings.length, 0, warnings.join("\n"));
			equal(reader.captureCoverage().droppedProgress, null);

			const windows = reader.db.prepare("SELECT value FROM meta WHERE key LIKE 'dispatch_window:%'").all() as Array<{
				value: string;
			}>;
			equal(windows.length, 1, "overlapping runs share one dispatch window");
			const lag = JSON.parse(windows[0]?.value ?? "{}") as {
				runIds: string[];
				samples: number;
				p99Ms: number | null;
				maxMs: number | null;
			};
			equal(new Set(lag.runIds).size, WORKERS);
			ok(lag.samples > 0 && lag.p99Ms !== null && lag.maxMs !== null, JSON.stringify(lag));
			t.diagnostic(
				`event-loop lag over ${lag.samples} samples: p99 ${lag.p99Ms.toFixed(1)} ms, max ${lag.maxMs.toFixed(1)} ms`,
			);
			ok(lag.samples >= MIN_LAG_SAMPLES, `the dispatch window sampled only ${lag.samples} ticks`);
			ok(lag.p99Ms < MAX_LOOP_LAG_P99_MS, `p99 event-loop lag ${lag.p99Ms.toFixed(1)} ms`);
			ok(lag.maxMs < MAX_LOOP_LAG_MS, `max event-loop lag ${lag.maxMs.toFixed(1)} ms`);
		} finally {
			reader.close();
		}
	} finally {
		for (const unsubscribe of unsubscribes) unsubscribe();
		await mirror.close();
		await bundle.extension.stop?.();
		await closeServer(server);
	}
});
