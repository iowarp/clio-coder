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
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { loadRecipesFromDir } from "../../src/domains/agents/registry.js";
import { normalizeAgentSpec } from "../../src/domains/agents/spec.js";
import { openAgentLedger, readAgentLedger } from "../../src/domains/dispatch/agent-ledger-store.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { SpawnedWorker, SpawnedWorkerResult, SpawnOptions } from "../../src/domains/dispatch/worker-spawn.js";
import {
	createDispatchBackgroundRegistry,
	createDispatchRunEventRegistry,
	createDispatchTool,
} from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";
import type { AgentLedgerBody, AgentLedgerEntry } from "../../src/worker/protocol.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

const approvedDispatch = {
	approval: { requestId: "test-ledger-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}

/**
 * The stub context with the real builtin recipe registry in place of the
 * fixture recipes. The ledger's first live break was a recipe that never
 * declared the tool, which no fixture recipe can reproduce.
 */
function builtinAgentsContext(): DomainContext {
	const base = dispatchStubContext();
	const recipes = loadRecipesFromDir({
		dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"),
		source: "builtin",
	});
	const agents: AgentsContract = {
		list: () => recipes,
		get: (id) => recipes.find((recipe) => recipe.id === id) ?? null,
		diagnostics: () => [],
		listSpecs: () => recipes.map(normalizeAgentSpec),
		getSpec: (id) => {
			const recipe = recipes.find((entry) => entry.id === id);
			return recipe ? normalizeAgentSpec(recipe) : null;
		},
		reload: () => {},
	};
	return {
		bus: base.bus,
		getContract: ((name: string) =>
			name === "agents" ? agents : base.getContract(name)) as DomainContext["getContract"],
	};
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
						message: { role: "assistant", content: "ledger worker done", usage: { input: 1, output: 1 } },
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
		const bundle = makeDispatchBundle(builtinAgentsContext(), { spawnWorker: factory.spawn });
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
				const envelope = bundle.contract.getRun(receipt.runId);
				ok(envelope !== null && envelope !== undefined);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true, "the contribution is under the seal");
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
		const bundle = makeDispatchBundle(builtinAgentsContext(), {
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
		const bundle = makeDispatchBundle(builtinAgentsContext(), {
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
		const bundle = makeDispatchBundle(builtinAgentsContext(), { spawnWorker: factory.spawn });
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
			for (const runId of runIds) ok(bundle.contract.getRun(runId)?.status !== "running", "each run settled");
			ok(typeof readAgentLedger(ledgerId)?.closedAt === "string", "settlement closes the board");
			ok(
				result.details !== undefined && !JSON.stringify(result.details).includes("alpha lead"),
				"the board itself never reaches the main model's tool result",
			);
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
		const bundle = makeDispatchBundle(builtinAgentsContext(), { spawnWorker: factory.spawn });
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
			const closedAt = readAgentLedger(ledgerId)?.closedAt;
			ok(typeof closedAt === "string", "the first collect closes the board");

			const again = (await monitor.run({ mode: "collect", batch_id: batchId }, {})) as ToolRunResult;
			strictEqual(again.kind, "ok");
			strictEqual(readAgentLedger(ledgerId)?.closedAt, closedAt, "a repeated collect does not move the close");

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
		const bundle = makeDispatchBundle(builtinAgentsContext(), { spawnWorker: factory.spawn });
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
