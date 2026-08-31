/**
 * Agent ledger, driven through the real dispatch composition.
 *
 * tests/contracts/agent-ledger.test.ts proves each part of the ledger in
 * isolation: reducers, store, hub, mirror, control lane, receipt seal. Three
 * live breaks got past that suite because each was a hop between parts (a
 * recipe that never declared the tool, a spawn seam that dropped the callback,
 * a close that was declared and never assigned), and every existing test
 * substituted a fake at exactly the seam where the bug lived.
 *
 * These tests substitute only what a test must: the worker process. The
 * builtin recipes are the real ones, the bundle is the real one, the dispatch
 * and monitor tools are the real ones, and the fake worker is a plain object
 * that receives exactly the options the extension hands a spawner and calls
 * exactly the callbacks a real worker's control lane would.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { openAgentLedger, readAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { SpawnedWorker, SpawnedWorkerResult, SpawnOptions } from "../../src/domains/dispatch/worker-spawn.js";
import { createDispatchRunEventRegistry, createDispatchTool } from "../../src/tools/dispatch.js";
import { createDispatchBackgroundRegistry } from "../../src/tools/dispatch-background.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import type { AgentLedgerBody, AgentLedgerEntry } from "../../src/worker/protocol.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";
import { scaleWatchdog } from "../harness/load.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

const approvedDispatch = {
	approval: { requestId: "test-ledger-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

/**
 * A watchdog on a ledger write that lands off the caller's stack. It asserts
 * the write arrives, not that it arrives quickly, so the budget widens with the
 * shard load the run carries; alone it stays the 8s it always was.
 */
async function waitFor(predicate: () => boolean, message: string, budgetMs = 8000): Promise<void> {
	const deadline = Date.now() + scaleWatchdog(budgetMs);
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

/**
 * A worker that is exactly the seam: it keeps the spec and options it was
 * spawned with, records every stdin frame the orchestrator sends it, and can
 * raise a ledger post through the callback it was handed, the way the real
 * control lane does. It stays in flight until the test finishes it.
 */
interface LedgerWorker {
	worker: SpawnedWorker;
	spec: WorkerSpec;
	opts: SpawnOptions | undefined;
	sent: unknown[];
	post(body: AgentLedgerBody): void;
	finish(exitCode?: number): void;
}

function deltasIn(sent: ReadonlyArray<unknown>): AgentLedgerEntry[] {
	return sent
		.filter((frame): frame is { type: "ledger_delta"; entries: AgentLedgerEntry[] } => {
			return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "ledger_delta";
		})
		.flatMap((frame) => frame.entries);
}

function ledgerWorkerFactory(pidBase = 500): {
	spawn: (spec: WorkerSpec, opts?: SpawnOptions) => SpawnedWorker;
	workers: LedgerWorker[];
} {
	const workers: LedgerWorker[] = [];
	return {
		workers,
		spawn(spec, opts) {
			let settle!: (result: SpawnedWorkerResult) => void;
			const promise = new Promise<SpawnedWorkerResult>((resolve) => {
				settle = resolve;
			});
			const events = (async function* (): AsyncIterableIterator<unknown> {
				const result = await promise;
				if (result.exitCode === 0) {
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							content: mutationReport("ledger worker done"),
							usage: { input: 1, output: 1 },
						},
					};
				}
			})();
			const sent: unknown[] = [];
			const entry: LedgerWorker = {
				spec,
				opts,
				sent,
				worker: {
					pid: pidBase + workers.length,
					promise,
					events,
					abort: () => settle({ exitCode: null, signal: "SIGTERM" }),
					heartbeatAt: { current: Date.now() },
					send: (value) => {
						sent.push(value);
						return true;
					},
				},
				post: (body) => {
					ok(opts?.onLedgerPost !== undefined, "the spawner was handed onLedgerPost");
					opts.onLedgerPost(body);
				},
				finish: (exitCode = 0) => settle({ exitCode, signal: null }),
			};
			workers.push(entry);
			return entry.worker;
		},
	};
}

function ledgerPromptMessage(spec: WorkerSpec): string | null {
	return spec.dynamicPromptMessages?.find((message) => message.id === "dispatch-agent-ledger")?.body ?? null;
}

describe("contracts/agent-ledger composition: bundle", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	it("carries a post from one worker's control lane to the board, to its peer's mirror, and into both receipts", async () => {
		const factory = ledgerWorkerFactory();
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: factory.spawn });
		await bundle.extension.start();
		const ledgerId = "ledger-composition-1";
		try {
			await openAgentLedger(ledgerId);
			const ledger = { id: ledgerId, sequence: 0 };

			// Worker A spawns into an empty board.
			const handleA = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "builder",
				task: "scout src/alpha",
				ledger,
			});
			const workerA = factory.workers[0];
			ok(workerA !== undefined);
			// Hop 1: admission. The real scout recipe declares the ledger and the
			// ledgered run keeps it through every narrowing pass.
			ok(workerA.spec.allowedTools.includes(ToolNames.Ledger), "a ledgered scout is offered the ledger tool");
			deepStrictEqual(workerA.spec.ledger, ledger, "the spec carries the ledger the request named");
			strictEqual(ledgerPromptMessage(workerA.spec), null, "an empty board is not rendered into the prompt");
			// Hop 2: the spawner is handed the control-lane callback.
			ok(typeof workerA.opts?.onLedgerPost === "function", "the spawn options carry onLedgerPost");

			// Hop 3 and 4: a post goes up, the orchestrator stamps attribution from
			// its own admission record, appends, and fans out to the author too.
			workerA.post({ kind: "claim", scope: ["src/alpha"], intent: "map alpha" });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1, "A's claim landed on the board");
			const e1 = readAgentLedger(ledgerId)?.entries[0];
			ok(e1 !== undefined);
			strictEqual(e1.id, "e1");
			strictEqual(e1.runId, handleA.runId, "attribution is the orchestrator's run id");
			strictEqual(e1.agentId, "scout");
			strictEqual(e1.nodeId, "local");
			await waitFor(() => deltasIn(workerA.sent).some((entry) => entry.id === "e1"), "A's own entry reached A's mirror");

			// Worker B spawns late. Hop 5: the board reaches it twice, once rendered
			// into its prompt at spawn and once as a replay on subscription.
			const handleB = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "builder",
				task: "scout src/alpha again",
				ledger,
			});
			const workerB = factory.workers[1];
			ok(workerB !== undefined);
			const prompt = ledgerPromptMessage(workerB.spec);
			ok(prompt !== null, "the late worker's prompt carries the board");
			match(prompt, /e1 claim src\/alpha: map alpha/);
			await waitFor(
				() => deltasIn(workerB.sent).some((entry) => entry.id === "e1"),
				"the hub replayed e1 to B on subscription",
			);

			// Hop 6: B's overlapping claim is stamped with the conflict at admission
			// and pushed to A, whose mirror never asked for it.
			workerB.post({ kind: "claim", scope: ["src/alpha/inner"], intent: "map inner" });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 2, "B's claim landed");
			const e2 = readAgentLedger(ledgerId)?.entries[1];
			deepStrictEqual(e2?.conflictsWith, ["e1"]);
			strictEqual(e2?.runId, handleB.runId);
			await waitFor(() => deltasIn(workerA.sent).some((entry) => entry.id === "e2"), "B's claim reached A's mirror");

			// A failed review disputes its target; the entry carries no attribution
			// the worker chose.
			workerB.post({ kind: "review", target: "e1", passed: false, evidence: "alpha has no such module" });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 3, "B's review landed");
			await waitFor(() => deltasIn(workerA.sent).some((entry) => entry.id === "e3"), "B's review reached A's mirror");

			// Hop 7: receipts seal each run's contribution from the stored board.
			workerA.finish(0);
			workerB.finish(0);
			const [receiptA, receiptB] = await Promise.all([handleA.finalPromise, handleB.finalPromise]);
			strictEqual(receiptA.ledgerContribution?.ledgerId, ledgerId);
			strictEqual(receiptA.ledgerContribution?.posted, 1);
			strictEqual(receiptA.ledgerContribution?.refused, 0);
			strictEqual(receiptB.ledgerContribution?.ledgerId, ledgerId);
			strictEqual(receiptB.ledgerContribution?.posted, 2);
			ok(receiptA.ledgerContribution?.digest !== receiptB.ledgerContribution?.digest, "each run digests its own entries");
			for (const receipt of [receiptA, receiptB]) {
				// The seal is computed over the run envelope, and the envelope's
				// terminal fields (endedAt, exitCode, outcome) are written by the
				// same settlement that resolves finalPromise, a tick later. Reading
				// the envelope straight off the await compared a sealed receipt
				// against a half-written envelope and failed as a ledger mismatch.
				// The wait is only for the envelope to stop being in flight; the
				// seal itself is still checked exactly once, strictly.
				await waitFor(
					() => bundle.contract.getRun(receipt.runId)?.status !== "running",
					`run ${receipt.runId} never left "running" before its seal was checked`,
				);
				const envelope = bundle.contract.getRun(receipt.runId);
				ok(envelope !== null && envelope !== undefined);
				const verification = verifyReceiptIntegrity(receipt, envelope);
				strictEqual(
					verification.ok,
					true,
					`the contribution is under the seal${verification.ok ? "" : `: ${verification.reason}`}`,
				);
			}

			// A run with no ledger is offered no tool and no callback.
			const solo = await bundle.contract.dispatch({ agentId: "scout", executionRole: "builder", task: "solo" });
			const workerSolo = factory.workers[2];
			ok(workerSolo !== undefined);
			strictEqual(workerSolo.spec.allowedTools.includes(ToolNames.Ledger), false, "a solo run never sees the ledger tool");
			strictEqual(workerSolo.opts?.onLedgerPost, undefined);
			workerSolo.finish(0);
			const soloReceipt = await solo.finalPromise;
			strictEqual(soloReceipt.ledgerContribution, undefined);
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("holds a post that lands before the run has attribution and appends it once it does", async () => {
		// The worker is live from the moment spawn returns, and its attribution
		// exists only once the orchestrator has created the envelope a few awaits
		// later. A post in that gap used to be dropped with no diagnostic while
		// the worker's mirror had already counted it and told the model "posted".
		const factory = ledgerWorkerFactory(650);
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: (spec, opts) => {
				const worker = factory.spawn(spec, opts);
				// Synchronously inside spawn: nothing about this run exists yet.
				opts?.onLedgerPost?.({ kind: "finding", claim: "posted before attribution", path: "src/alpha/a.ts" });
				return worker;
			},
		});
		await bundle.extension.start();
		const ledgerId = "ledger-composition-early";
		try {
			await openAgentLedger(ledgerId);
			const handle = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "builder",
				task: "early scout",
				ledger: { id: ledgerId, sequence: 0 },
			});
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1, "the held post was appended");
			const entry = readAgentLedger(ledgerId)?.entries[0];
			strictEqual(entry?.runId, handle.runId, "it carries the attribution that did not exist when it was posted");
			const worker = factory.workers[0];
			ok(worker !== undefined);
			await waitFor(
				() => deltasIn(worker.sent).some((candidate) => candidate.id === "e1"),
				"and reaches the author's mirror",
			);
			worker.finish(0);
			const receipt = await handle.finalPromise;
			strictEqual(receipt.ledgerContribution?.posted, 1);
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("hands the same spawn options to a placement's transport as to the local spawner", async () => {
		// The second live break was spawnNativeWorker forwarding a subset of its
		// options. A fleet placement is another spawner behind another seam, so
		// this asserts the contract at that seam instead of trusting it.
		const factory = ledgerWorkerFactory(600);
		const seen: Array<SpawnOptions | undefined> = [];
		const placement: DispatchNodePlacement = {
			node: { id: "blade", kind: "ssh", host: "blade.lan" },
			spawn: (spec, opts) => {
				seen.push(opts);
				return factory.spawn(spec, opts);
			},
		};
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => {
				throw new Error("a placed run must not fall back to the local spawner");
			},
			resolveNode: () => placement,
			previewNode: () => ({ node: placement.node }),
		});
		await bundle.extension.start();
		const ledgerId = "ledger-composition-placed";
		try {
			await openAgentLedger(ledgerId);
			const handle = await bundle.contract.dispatch({
				agentId: "scout",
				executionRole: "builder",
				task: "placed scout",
				ledger: { id: ledgerId, sequence: 0 },
			});
			ok(typeof seen[0]?.onLedgerPost === "function", "the placement transport receives onLedgerPost");
			const worker = factory.workers[0];
			ok(worker !== undefined);
			worker.post({ kind: "finding", claim: "placed post", path: "src/alpha/a.ts", line: 3 });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1, "the placed worker's post landed");
			strictEqual(readAgentLedger(ledgerId)?.entries[0]?.nodeId, "blade", "attribution names the placed node");
			worker.finish(0);
			const receipt = await handle.finalPromise;
			strictEqual(receipt.ledgerContribution?.posted, 1);
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});
});

describe("contracts/agent-ledger composition: dispatch tool", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	function ledgerIdOf(worker: LedgerWorker): string {
		const id = worker.spec.ledger?.id;
		ok(id !== undefined, "the worker's spec names its ledger");
		return id;
	}

	it("parallel opens one board for the batch and closes it when the batch settles", async () => {
		const factory = ledgerWorkerFactory(700);
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: factory.spawn });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, runEvents });
			const call = tool.run({ tasks: ["alpha", "beta"], agent: "scout" }, approvedDispatch) as Promise<ToolRunResult>;
			await waitFor(() => factory.workers.length === 2, "both workers spawned");
			const [a, b] = factory.workers;
			ok(a !== undefined && b !== undefined);
			const ledgerId = ledgerIdOf(a);
			strictEqual(ledgerIdOf(b), ledgerId, "both peers share one board");
			strictEqual(readAgentLedger(ledgerId)?.closedAt, null, "the board is open while the batch runs");
			a.post({ kind: "finding", claim: "alpha lead", path: "src/alpha/a.ts" });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1, "post landed");
			a.finish(0);
			b.finish(0);
			// The fake worker's plain text fails the scout-report contract, which is
			// a failed outcome and not an error path, so the tool answers either way.
			const result = await call;
			const runIds = result.details?.assignmentIds as string[];
			strictEqual(runIds.length, 2);
			// The tool resolving is not the same event as the run rows leaving
			// "running": the batch's own settlement writes them, and that write
			// lands a tick later. Reading them synchronously off `await call` was
			// an ordering assumption that only held while the box was idle enough
			// for the tick to have already run. Waiting for the same condition
			// proves the same thing without depending on which tick it lands in.
			await waitFor(
				() => runIds.every((runId) => bundle.contract.getRun(runId)?.status !== "running"),
				"each run settled",
			);
			await waitFor(() => typeof readAgentLedger(ledgerId)?.closedAt === "string", "settlement closes the board");
			// The board the peers built is what the main model reads back, rendered
			// the same way its workers saw it and attributed the same way.
			const output = result.kind === "ok" ? result.output : result.message;
			match(output, /agent ledger \(1 entry, sequence 1\)/);
			match(output, /e1 finding src\/alpha\/a\.ts: alpha lead \[uncorroborated\]/);
			const posterRunId = readAgentLedger(ledgerId)?.entries[0]?.runId;
			strictEqual(
				result.details?.agentLedgerBoard,
				`agent ledger (1 entry, sequence 1)\nscout (run ${posterRunId}, node local):\n  e1 finding src/alpha/a.ts: alpha lead [uncorroborated]`,
				"details carry the same rendered board under a stable key",
			);
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("adds nothing to a parallel result or a collect when the board stayed empty", async () => {
		// A board nobody posted to has nothing to tell the main model, and a
		// result that says so anyway spends the model's attention on a heading.
		const factory = ledgerWorkerFactory(750);
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: factory.spawn });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, runEvents });
			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });

			const call = tool.run({ tasks: ["alpha", "beta"], agent: "scout" }, approvedDispatch) as Promise<ToolRunResult>;
			await waitFor(() => factory.workers.length === 2, "both workers spawned");
			for (const worker of factory.workers) worker.finish(0);
			const result = await call;
			const output = result.kind === "ok" ? result.output : result.message;
			strictEqual(output.includes("agent ledger"), false, "an empty board adds no section");
			strictEqual(result.details?.agentLedgerBoard, undefined, "and no details key");

			const detached = (await tool.run(
				{ tasks: ["gamma", "delta"], agent: "scout", detach: true },
				{ sessionId: "session-ledger-empty", ...approvedDispatch },
			)) as ToolRunResult;
			strictEqual(detached.kind, "ok", detached.kind === "error" ? detached.message : "");
			const batchId = detached.details?.batchId as string;
			for (const worker of factory.workers) worker.finish(0);
			const runIds = detached.details?.assignmentIds as string[];
			await waitFor(
				() => runIds.every((runId) => (bundle.contract.assignments?.get(runId)?.status ?? "running") !== "running"),
				"detached assignments settled",
			);
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			strictEqual(
				(collected.kind === "ok" ? collected.output : "").includes("agent ledger"),
				false,
				"collect adds no section for an empty board",
			);
			strictEqual(collected.details?.agentLedgerBoard, undefined, "and no details key");
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("detached opens a board for two or more, records it on the batch, and closes it on the first collect", async () => {
		// The third live break: markDetachedBatchCollected declared the id to
		// close as a const null and never assigned it, so a collected batch's
		// board stayed open, still admitting posts.
		const factory = ledgerWorkerFactory(800);
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: factory.spawn });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, runEvents });
			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });

			const result = (await tool.run(
				{ tasks: ["alpha", "beta"], agent: "scout", detach: true },
				{ sessionId: "session-ledger-detach", ...approvedDispatch },
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const batchId = result.details?.batchId as string;
			const [a, b] = factory.workers;
			ok(a !== undefined && b !== undefined);
			const ledgerId = ledgerIdOf(a);
			strictEqual(bundle.contract.detached?.get(batchId)?.ledgerId, ledgerId, "the batch record carries the board");

			a.post({ kind: "claim", scope: ["src/alpha"], intent: "alpha" });
			await waitFor(() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1, "post landed");
			a.finish(0);
			b.finish(0);
			const runIds = result.details?.assignmentIds as string[];
			await waitFor(
				() => runIds.every((runId) => (bundle.contract.assignments?.get(runId)?.status ?? "running") !== "running"),
				"detached assignments settled",
			);
			strictEqual(readAgentLedger(ledgerId)?.closedAt, null, "settlement alone leaves a detached board open");

			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			match(collected.kind === "ok" ? collected.output : "", /collect complete/);
			// Collect is where a detached batch reaches the main model, so it is
			// where the board reaches it too.
			match(collected.kind === "ok" ? collected.output : "", /agent ledger \(1 entry, sequence 1\)/);
			match(collected.kind === "ok" ? collected.output : "", /e1 claim src\/alpha: alpha/);
			ok(typeof collected.details?.agentLedgerBoard === "string", "collect details carry the board");
			const closedAt = readAgentLedger(ledgerId)?.closedAt;
			ok(typeof closedAt === "string", "the first collect closes the board");

			const again = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(again.kind, "ok");
			strictEqual(readAgentLedger(ledgerId)?.closedAt, closedAt, "a repeated collect does not move the close");
			strictEqual(
				again.details?.agentLedgerBoard,
				collected.details?.agentLedgerBoard,
				"a closed board still renders, so a repeated collect reads the same board",
			);

			// A single detached run is not a fan-out and gets no board.
			const solo = (await tool.run(
				{ tasks: ["solo"], agent: "scout", detach: true },
				{ sessionId: "session-ledger-detach", ...approvedDispatch },
			)) as ToolRunResult;
			strictEqual(solo.kind, "ok", solo.kind === "error" ? solo.message : "");
			strictEqual(bundle.contract.detached?.get(solo.details?.batchId as string)?.ledgerId, undefined);
			strictEqual(factory.workers[2]?.spec.ledger, undefined);
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});

	it("a parallel batch the operator backgrounds keeps its board open until collect", async () => {
		// runBatch closed the ledger in a finally that also ran on the
		// backgrounding throw, so an operator keypress killed peer coordination
		// for runs that were still live, and the detached record it converted
		// into carried no ledger id for collect to close later.
		const factory = ledgerWorkerFactory(900);
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: factory.spawn });
		await bundle.extension.start();
		try {
			const runEvents = createDispatchRunEventRegistry();
			const background = createDispatchBackgroundRegistry();
			const tool = createDispatchTool({ getAgentSpecs: () => [], dispatch: bundle.contract, runEvents, background });
			const monitor = createMonitorTool({ dispatch: bundle.contract, runEvents });
			const call = tool.run(
				{ tasks: ["alpha", "beta"], agent: "scout" },
				{ sessionId: "session-ledger-background", toolCallId: "call-ledger-parallel", ...approvedDispatch },
			) as Promise<ToolRunResult>;
			await waitFor(() => factory.workers.length === 2 && background.size() === 1, "batch live and control registered");
			const [a, b] = factory.workers;
			ok(a !== undefined && b !== undefined);
			const ledgerId = ledgerIdOf(a);

			strictEqual(background.backgroundNewest().ok, true);
			const result = await call;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			strictEqual(result.details?.conversion, "operator-backgrounded");
			const batchId = result.details?.batchId as string;

			strictEqual(readAgentLedger(ledgerId)?.closedAt, null, "backgrounding does not close a live batch's board");
			strictEqual(bundle.contract.detached?.get(batchId)?.ledgerId, ledgerId, "the converted record carries the board");
			b.post({ kind: "finding", claim: "posted after the operator backgrounded us", path: "src/beta/b.ts" });
			await waitFor(
				() => (readAgentLedger(ledgerId)?.entries.length ?? 0) === 1,
				"a post after backgrounding is admitted",
			);
			await waitFor(() => deltasIn(a.sent).some((entry) => entry.id === "e1"), "and still reaches the peer");

			a.finish(0);
			b.finish(0);
			const runIds = result.details?.assignmentIds as string[];
			await waitFor(
				() => runIds.every((runId) => (bundle.contract.assignments?.get(runId)?.status ?? "running") !== "running"),
				"converted assignments settled",
			);
			const collected = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(collected.kind, "ok");
			ok(typeof readAgentLedger(ledgerId)?.closedAt === "string", "collect closes the converted batch's board");
		} finally {
			for (const worker of factory.workers) worker.finish(0);
			await bundle.extension.stop?.();
		}
	});
});
