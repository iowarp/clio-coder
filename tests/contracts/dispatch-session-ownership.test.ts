import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { getDetachedBatch } from "../../src/domains/dispatch/batch-store.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	gateDecisionsDirectory,
	preparePendingGateDecisionRecovery,
	stagePendingGateOutput,
} from "../../src/domains/dispatch/gate-decisions.js";
import { dispatchOwnership } from "../../src/domains/dispatch/ownership.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { finishedDetachedBatchIds, openDetachedBatchViews } from "../../src/domains/middleware/dispatch-nudge.js";
import { grantEffectDescriptor, grantEffectDigest } from "../../src/domains/safety/grant-effect.js";
import { seedForkCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { DispatchArtifactProvider } from "../../src/interactive/view/artifacts.js";
import { createTurnControlRunner } from "../../src/session-control/turn-control-runner.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { loadVerifiedScoutSource } from "../../src/tools/dispatch-scout-admission.js";
import { createRegistry, type ToolResult } from "../../src/tools/registry.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope } from "../harness/receipt.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Two Clio sessions on one machine share one state dir. Each is modelled here
 * as its own dispatch bundle over the same isolated state root, which is
 * exactly what two processes are: separate in-memory ledgers over one
 * runs.json, batches.json, receipts/, and gate journal. The only stand-in is
 * the worker process.
 */

function controlledWorker() {
	let resolve!: (value: SpawnedWorkerResult) => void;
	const done = new Promise<SpawnedWorkerResult>((yes) => {
		resolve = yes;
	});
	let aborts = 0;
	let refusedTool: string | null = null;
	const worker: SpawnedWorker = {
		pid: null,
		promise: done,
		heartbeatAt: { current: Date.now(), monotonic: performance.now() },
		abort() {
			aborts += 1;
			resolve({ exitCode: null, signal: "SIGTERM" });
		},
		send() {
			return true;
		},
		events: (async function* () {
			const outcome = await done;
			if (refusedTool !== null) {
				const payload = { tool: refusedTool, toolCallId: "refused-1" };
				yield { type: "clio_coder_tool_start", payload };
				yield { type: "clio_coder_tool_finish", payload: { ...payload, outcome: "blocked" } };
			}
			if (outcome.exitCode === 0)
				yield {
					type: "message_end",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
					},
				};
		})(),
	};
	return {
		worker,
		aborts: () => aborts,
		finish: () => resolve({ exitCode: 0, signal: null }),
		/** Finish cleanly after one call the worker tried was kept from running. */
		finishRefused: (tool: string) => {
			refusedTool = tool;
			resolve({ exitCode: 0, signal: null });
		},
	};
}

interface SessionFixture {
	contract: DispatchContract;
	workers: ReturnType<typeof controlledWorker>[];
	request: DispatchRequest;
	call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
	stop(): Promise<void>;
}

async function openSession(
	scratch: IsolatedClioEnv,
	sessionId: string,
	projectDir: string,
	parentSessionId: string | null = null,
): Promise<SessionFixture> {
	const workers: ReturnType<typeof controlledWorker>[] = [];
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		getSessionId: () => sessionId,
		getSessionParentId: () => parentSessionId,
		spawnWorker: () => {
			const worker = controlledWorker();
			workers.push(worker);
			return worker.worker;
		},
	});
	await bundle.extension.start();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: scratch.dir }) });
	registerAllTools(registry, { mcpCapabilities: false, dispatch: bundle.contract });
	return {
		contract: bundle.contract,
		workers,
		request: {
			agentId: "scout",
			executionRole: "researcher",
			task: "Inspect isolated fixture evidence.",
			cwd: projectDir,
			requestOrigin: "internal",
			resultContractOverride: { kind: "provenance-report" },
		},
		async call(tool, args) {
			const verdict = await registry.invoke({ tool, args }, { sessionId });
			if (verdict.kind !== "ok") throw new Error(`${tool} was not admitted: ${JSON.stringify(verdict)}`);
			return verdict.result;
		},
		async stop() {
			for (const worker of workers) worker.finish();
			await bundle.extension.stop?.();
		},
	};
}

function okResult(result: ToolResult): Extract<ToolResult, { kind: "ok" }> {
	if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	return result;
}

async function callAs(
	contract: DispatchContract,
	sessionId: string,
	tool: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }) });
	registerAllTools(registry, { mcpCapabilities: false, dispatch: contract });
	const verdict = await registry.invoke({ tool, args }, { sessionId });
	if (verdict.kind !== "ok") throw new Error(`${tool} was not admitted: ${JSON.stringify(verdict)}`);
	return verdict.result;
}

function errorMessage(result: ToolResult): string {
	if (result.kind !== "error") throw new Error(`expected error, got ${JSON.stringify(result)}`);
	return result.message;
}

/** A finished run in session A, persisted before session B opens its ledger. */
async function finishedRunInA(scratch: IsolatedClioEnv, projectA: string) {
	const a = await openSession(scratch, "session-a", projectA);
	const handle = await a.contract.dispatch(a.request);
	a.workers[0]?.finish();
	const receipt = await handle.finalPromise;
	return { a, runId: handle.runId, receipt };
}

describe("dispatch session ownership", () => {
	let scratch: IsolatedClioEnv;
	let projectA: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-session-ownership-");
		// Outside process.cwd(), so session B (which runs in process.cwd()) is in
		// another project from session A's runs.
		projectA = join(scratch.dir, "project-a");
		mkdirSync(projectA, { recursive: true });
	});
	afterEach(() => scratch.restore());

	it("stamps the dispatching session on the run row and its sealed receipt", async () => {
		const { a, runId, receipt } = await finishedRunInA(scratch, projectA);
		try {
			strictEqual(receipt.sessionId, "session-a");
			strictEqual(a.contract.getRun(runId)?.sessionId, "session-a");
			deepStrictEqual(a.contract.owner?.(), { sessionId: "session-a", cwd: process.cwd() });
			const read = okResult(await a.call(ToolNames.Monitor, { mode: "record", run_id: runId }));
			strictEqual((read.details?.runIntegrity as { state: string }).state, "verified", "the stamp is inside the seal");
		} finally {
			await a.stop();
		}
	});

	it("keeps another session's detached batch out of the nudge and refuses to collect it", async () => {
		const { a, runId } = await finishedRunInA(scratch, projectA);
		await a.contract.detached?.register({
			batchId: "batch-a",
			runs: [{ runId, assignmentId: runId, agentId: "scout" }],
			sessionId: "session-a",
			cwd: projectA,
		});
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			deepStrictEqual(openDetachedBatchViews(b.contract), [], "session B is never nudged about A's batch");
			deepStrictEqual(
				openDetachedBatchViews(a.contract).map((view) => [view.id, view.terminal, view.total]),
				[["batch-a", 1, 1]],
			);

			match(
				errorMessage(await b.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-a" })),
				/batch 'batch-a' belongs to another session/,
			);
			strictEqual(getDetachedBatch("batch-a")?.collectedAt, null, "a refused collect leaves the batch open");

			const collected = okResult(await a.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-a" }));
			strictEqual(collected.details?.collected, true);
		} finally {
			await b.stop();
			await a.stop();
		}
	});

	it("lets a fork collect its parent's uncollected batch once but never cancel the parent's live run", async () => {
		const parent = await openSession(scratch, "session-p", projectA);
		const handle = await parent.contract.dispatch(parent.request);
		await parent.contract.detached?.register({
			batchId: "batch-p",
			runs: [{ runId: handle.runId, assignmentId: handle.runId, agentId: "scout" }],
			sessionId: "session-p",
			cwd: projectA,
		});
		const fork = await openSession(scratch, "session-f", process.cwd(), "session-p");
		const stranger = await openSession(scratch, "session-x", process.cwd());
		try {
			match(
				errorMessage(await fork.call(ToolNames.Steer, { run_id: handle.runId, action: "cancel" })),
				/belongs to session session-p, which this session was forked from;/,
			);
			strictEqual(parent.workers[0]?.aborts(), 0, "the fork never touched the parent's live worker");
			parent.workers[0]?.finish();
			await handle.finalPromise;

			deepStrictEqual(
				openDetachedBatchViews(fork.contract).map((view) => [view.id, view.terminal, view.total]),
				[["batch-p", 1, 1]],
			);
			deepStrictEqual(openDetachedBatchViews(stranger.contract), [], "a non-ancestor is never nudged");
			match(
				errorMessage(await stranger.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-p" })),
				/batch 'batch-p' belongs to another session/,
			);

			strictEqual(
				okResult(await fork.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-p" })).details?.collected,
				true,
			);
			deepStrictEqual(openDetachedBatchViews(parent.contract), [], "the first collect silences every nudge");
			deepStrictEqual(openDetachedBatchViews(fork.contract), []);
			// The parent's next turn is told once who collected its batch and how each run ended.
			const parentTurns = createTurnControlRunner({
				getSettings: () => DEFAULT_SETTINGS,
				dispatch: parent.contract,
				getTurnConstraints: () => undefined,
				finishedDetachedBatchIds: () => finishedDetachedBatchIds(parent.contract),
				emitNotice: () => {},
			});
			const turn = () => parentTurns.run({ userTurnId: "turn-p", signal: new AbortController().signal });
			match(
				(await turn()).block ?? "",
				new RegExp(
					`^\\[Collected elsewhere\\][^]*batch batch-p was collected by session session-f: run ${handle.runId} \\(scout\\) succeeded\\. It is settled, not running in the background`,
				),
			);
			strictEqual((await turn()).block, null, "the parent is told once");
			match(
				okResult(await parent.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-p" })).output,
				/batch batch-p \(already collected by session session-f\)/,
			);
			match(
				errorMessage(await fork.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-p" })),
				/batch 'batch-p' was already collected/,
			);
		} finally {
			await stranger.stop();
			await fork.stop();
			await parent.stop();
		}
	});

	it("a fork adopts its parent's pending worker asks like a collect, and the parent no longer holds them (bt-11)", async () => {
		let session: { id: string; parent: string | null } = { id: "session-p", parent: null };
		// Main mode routes a main-routed run's asks through the grant broker (judge mode denies them with no judge here).
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.permissions.mode = "main";
		const context = dispatchStubContext({ settings });
		let plainAsked = false;
		context.bus.subscribe("approval.requested", (payload) => {
			if (payload.requestId === "ask-p") plainAsked = true;
		});
		const effect = grantEffectDescriptor("bash", { command: "touch out.txt" });
		const sent: unknown[] = [];
		const grantSent: unknown[] = [];
		let finish!: (value: SpawnedWorkerResult) => void;
		const done = new Promise<SpawnedWorkerResult>((resolve) => {
			finish = resolve;
		});
		const bundle = makeDispatchBundle(context, {
			getSessionId: () => session.id,
			getSessionParentId: () => session.parent,
			spawnWorker: (spec, opts) => {
				const grant = spec.escalation?.grant;
				return {
					pid: null,
					promise: done,
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort: () => finish({ exitCode: null, signal: "SIGTERM" }),
					send: (value) => {
						(grant === undefined ? sent : grantSent).push(value);
						return true;
					},
					events: (async function* () {
						if (grant === undefined) {
							yield {
								type: "clio_coder_permission_escalated",
								payload: { requestId: "ask-p", tool: "bash", summary: "touch out.txt", timeoutMs: 120_000 },
							};
						} else {
							opts?.onGrantRequest?.({
								requestId: "grant-p",
								attemptToken: grant.attemptToken,
								attempt: grant.attempt,
								tool: "bash",
								actionClass: "execute",
								authority: "main",
								argDigest: grantEffectDigest(effect),
								effect,
								summary: "bash requires execute confirmation",
								reasons: [],
								timeoutMs: 120_000,
							});
						}
						await done;
					})(),
				};
			},
		});
		await bundle.extension.start();
		const { contract } = bundle;
		const handle = await contract.dispatch({
			agentId: "scout",
			executionRole: "researcher",
			task: "Inspect isolated fixture evidence.",
			cwd: projectA,
			requestOrigin: "internal",
			resultContractOverride: { kind: "provenance-report" },
		});
		const brokered = await contract.dispatch({
			agentId: "coder",
			executionRole: "builder",
			task: "Touch out.txt.",
			cwd: projectA,
			requestOrigin: "agent",
			mainGrantRoute: { kind: "yield" },
		});
		const pendingGrants = (sessionId: string) =>
			contract.grants?.list({ sessionId, pendingOnly: true }).map((view) => view.runId) ?? [];
		try {
			for (let i = 0; i < 400 && !(plainAsked && pendingGrants("session-p").length > 0); i++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			deepStrictEqual(pendingGrants("session-p"), [brokered.runId]);
			strictEqual(
				contract.workerPermissionRefusal?.(handle.runId, "ask-p"),
				null,
				"the dispatching session holds its ask",
			);
			// /fork in the same process: the parent is parked, so nobody else can ever answer its asks.
			context.bus.emit("session.parked", { sessionId: "session-p", reason: "fork", at: Date.now() });
			session = { id: "session-f", parent: "session-p" };
			context.bus.emit("session.created", { sessionId: "session-f", cwdHash: "fixture", at: Date.now() });
			deepStrictEqual(pendingGrants("session-f"), [brokered.runId], "the fork adopts the brokered ask, not a revoked one");
			deepStrictEqual(pendingGrants("session-p"), []);
			deepStrictEqual(grantSent, [], "the fork's open denied nothing");
			strictEqual(contract.workerPermissionRefusal?.(handle.runId, "ask-p"), null, "the fork adopts the orphaned ask");
			session = { id: "session-p", parent: null };
			const refusal = contract.workerPermissionRefusal?.(handle.runId, "ask-p") ?? "";
			match(
				refusal,
				/^the ask is held by session session-f \(run '[^']+'\); only that session can answer it\. \/resume session-f to answer it$/,
			);
			throws(() => contract.resolveWorkerPermission?.(handle.runId, "ask-p", "approve"), /held by session session-f/);
			session = { id: "session-x", parent: null };
			match(
				contract.workerPermissionRefusal?.(handle.runId, "ask-p") ?? "",
				/held by session session-f/,
				"a stranger never adopts",
			);
			session = { id: "session-f", parent: "session-p" };
			contract.resolveWorkerPermission?.(handle.runId, "ask-p", "approve");
			deepStrictEqual(sent, [{ type: "permission_decision", requestId: "ask-p", decision: "approve" }]);
			match(
				errorMessage(await callAs(contract, "session-f", ToolNames.Steer, { run_id: handle.runId, action: "cancel" })),
				/belongs to session session-p, which this session was forked from;/,
				"adopting the ask does not adopt the run",
			);
		} finally {
			finish({ exitCode: 0, signal: null });
			await Promise.allSettled([handle.finalPromise, brokered.finalPromise]);
			await bundle.extension.stop?.();
		}
	});

	it("a fork collects its grandparent's batch when the session between them was deleted (FL-14)", async () => {
		const parent = await openSession(scratch, "session-p", projectA);
		const handle = await parent.contract.dispatch(parent.request);
		await parent.contract.detached?.register({
			batchId: "batch-g",
			runs: [{ runId: handle.runId, assignmentId: handle.runId, agentId: "scout" }],
			sessionId: "session-p",
			cwd: projectA,
		});
		// session-m was forked from session-p, then deleted: no meta.json, only its telemetry journal is left.
		seedForkCallJournal(clioStateDir(), "session-m", {
			parentSessionId: "session-p",
			parentCwdHash: "fixture",
			parentTurnId: "turn-p",
			parentTurnAt: new Date().toISOString(),
		});
		const fork = await openSession(scratch, "session-f", process.cwd(), "session-m");
		try {
			parent.workers[0]?.finish();
			await handle.finalPromise;
			okResult(await fork.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-g" }));
		} finally {
			await fork.stop();
			await parent.stop();
		}
	});

	it("tells the dispatching session that a run a fork collected had a call refused", async () => {
		const parent = await openSession(scratch, "session-p", projectA);
		const handle = await parent.contract.dispatch(parent.request);
		await parent.contract.detached?.register({
			batchId: "batch-r",
			runs: [{ runId: handle.runId, assignmentId: handle.runId, agentId: "scout" }],
			sessionId: "session-p",
			cwd: projectA,
		});
		const fork = await openSession(scratch, "session-f", process.cwd(), "session-p");
		try {
			parent.workers[0]?.finishRefused(ToolNames.Read);
			await handle.finalPromise;
			okResult(await fork.call(ToolNames.Monitor, { mode: "collect", batch_id: "batch-r" }));
			const parentTurns = createTurnControlRunner({
				getSettings: () => DEFAULT_SETTINGS,
				dispatch: parent.contract,
				getTurnConstraints: () => undefined,
				finishedDetachedBatchIds: () => finishedDetachedBatchIds(parent.contract),
				emitNotice: () => {},
			});
			match(
				(await parentTurns.run({ userTurnId: "turn-p", signal: new AbortController().signal })).block ?? "",
				new RegExp(
					`batch batch-r was collected by session session-f: run ${handle.runId} \\(scout\\) succeeded · 1 tool call · 1 call refused\\. It is settled`,
				),
			);
		} finally {
			await fork.stop();
			await parent.stop();
		}
	});

	it("lists only this session's runs and refuses to inspect or collect another project's", async () => {
		const { a, runId } = await finishedRunInA(scratch, projectA);
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			const listed = okResult(await b.call(ToolNames.Monitor, { mode: "list" }));
			strictEqual(listed.output, "No dispatched runs recorded for this session.");
			const own = okResult(await a.call(ToolNames.Monitor, { mode: "list" }));
			deepStrictEqual(own.details?.runs, [{ runId, agentId: "scout", state: "succeeded" }]);

			for (const mode of ["status", "record", "tools", "peek", "wait"]) {
				match(
					errorMessage(await b.call(ToolNames.Monitor, { mode, run_id: runId, timeout_ms: 5 })),
					new RegExp(`run '${runId}' belongs to another project`),
					mode,
				);
			}
			match(
				errorMessage(await b.call(ToolNames.Monitor, { mode: "collect", run_ids: [runId] })),
				new RegExp(`run '${runId}' belongs to another session`),
			);
		} finally {
			await b.stop();
			await a.stop();
		}
	});

	it("lets a sibling session in the same project read a run but not act on it", async () => {
		const { a, runId } = await finishedRunInA(scratch, process.cwd());
		const sibling = await openSession(scratch, "session-sibling", process.cwd());
		try {
			okResult(await sibling.call(ToolNames.Monitor, { mode: "status", run_id: runId }));
			okResult(await sibling.call(ToolNames.Monitor, { mode: "record", run_id: runId }));
			strictEqual(
				okResult(await sibling.call(ToolNames.Monitor, { mode: "list" })).output,
				"No dispatched runs recorded for this session.",
			);
			match(
				errorMessage(await sibling.call(ToolNames.Monitor, { mode: "collect", run_ids: [runId] })),
				/belongs to another session/,
			);
		} finally {
			await sibling.stop();
			await a.stop();
		}
	});

	it("refuses to cancel or guide another session's live run", async () => {
		const a = await openSession(scratch, "session-a", projectA);
		const handle = await a.contract.dispatch(a.request);
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			match(
				errorMessage(await b.call(ToolNames.Steer, { run_id: handle.runId, action: "cancel" })),
				/belongs to session session-a;/,
			);
			match(
				errorMessage(await b.call(ToolNames.Steer, { run_id: handle.runId, action: "guide", message: "stop" })),
				/belongs to session session-a;/,
			);
			strictEqual(a.workers[0]?.aborts(), 0, "A's worker was never touched");
			okResult(await a.call(ToolNames.Steer, { run_id: handle.runId, action: "cancel" }));
			strictEqual(a.workers[0]?.aborts(), 1);
			await handle.finalPromise;
		} finally {
			await b.stop();
			await a.stop();
		}
	});

	it("refuses to continue another session's Scout run", async () => {
		const { a, runId, receipt } = await finishedRunInA(scratch, projectA);
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			throws(
				() =>
					loadVerifiedScoutSource({
						ref: { runId, runDigest: receipt.digest },
						dispatch: b.contract,
						agentSpecs: [],
					}),
				/Scout source run '.+' belongs to another session/,
			);
		} finally {
			await b.stop();
			await a.stop();
		}
	});

	it("recovers only gate records whose decider run this session owns", async () => {
		const { a, runId } = await finishedRunInA(scratch, projectA);
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			const subject = { runId, digest: "0".repeat(64) };
			stagePendingGateOutput({
				telemetry: { sessionId: "session-a", agent: { role: "main", id: "session-a" } },
				group: "review-a",
				topology: "review",
				cycle: 1,
				subjects: [subject],
				deciderRunId: runId,
				finalOutput: "{}",
			});
			stagePendingGateOutput({
				telemetry: { sessionId: "session-a", agent: { role: "main", id: "session-a" } },
				group: "review-unknown",
				topology: "review",
				cycle: 1,
				subjects: [{ runId: "not-in-any-ledger", digest: "1".repeat(64) }],
				deciderRunId: "not-in-any-ledger",
				finalOutput: "{}",
			});
			const ownsFor = (contract: DispatchContract) => {
				const ownership = dispatchOwnership(contract.owner?.() ?? { sessionId: null, cwd: process.cwd() });
				return (id: string) => {
					const run = contract.getRun(id);
					return run === null ? null : ownership.ownsRun(run);
				};
			};
			deepStrictEqual(preparePendingGateDecisionRecovery(undefined, { ownsRun: ownsFor(b.contract) }), {
				ready: [],
				unresolved: [],
			});
			deepStrictEqual(
				preparePendingGateDecisionRecovery(undefined, { ownsRun: ownsFor(a.contract) }).unresolved.map(
					(handle) => handle.record.kind === "output" && handle.record.group,
				),
				["review-a"],
			);

			// A journal file another project's run wrote, damaged: it names its
			// decider, so it is that project's problem and not B's.
			writeFileSync(
				join(gateDecisionsDirectory(), "pending", "damaged.json"),
				JSON.stringify({ version: 1, kind: "output", id: "damaged", deciderRunId: runId }),
			);
			deepStrictEqual(preparePendingGateDecisionRecovery(undefined, { ownsRun: ownsFor(b.contract) }).unresolved, []);
			throws(
				() => preparePendingGateDecisionRecovery(undefined, { ownsRun: ownsFor(a.contract) }),
				/pending gate decision journal is untrustworthy/,
			);
			// A record nothing can attribute still fails closed everywhere.
			writeFileSync(join(gateDecisionsDirectory(), "pending", "unreadable.json"), "{not json");
			throws(
				() => preparePendingGateDecisionRecovery(undefined, { ownsRun: ownsFor(b.contract) }),
				/pending gate decision journal is untrustworthy/,
			);
		} finally {
			await b.stop();
			await a.stop();
		}
	});
});

describe("dispatch ownership rules", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-ownership-rules-");
	});
	afterEach(() => scratch.restore());

	it("gives a stamped row to its session and a legacy row to its project", () => {
		const project = join(scratch.dir, "project");
		mkdirSync(join(project, "sub"), { recursive: true });
		mkdirSync(`${project}-sibling`, { recursive: true });
		const ownership = dispatchOwnership({ sessionId: "s", cwd: project });
		ok(ownership.ownsRun({ sessionId: "s", cwd: "/anywhere" }));
		ok(!ownership.ownsRun({ sessionId: "t", cwd: project }));
		ok(ownership.seesRun({ sessionId: "t", cwd: project }), "a sibling session's run in this project is readable");
		ok(ownership.ownsRun({ sessionId: null, cwd: join(project, "sub") }), "a legacy row belongs to its project");
		ok(!ownership.ownsRun({ sessionId: null, cwd: `${project}-sibling` }), "a path prefix is not containment");
		ok(!ownership.ownsRun({ sessionId: null, cwd: "" }), "an unrecorded cwd belongs to no project");
		ok(!ownership.ownsBatch({ sessionId: null }), "a legacy batch without a cwd belongs to no one");
		ok(ownership.ownsBatch({ sessionId: null, cwd: project }));
		ok(!ownership.ownsBatch({ sessionId: "t", cwd: project }));
	});

	it("lists /view dispatch rows from this session and this project only", async () => {
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		const row = (id: string, sessionId: string | null, cwd: string) => ({ ...fixtureEnvelope(id), sessionId, cwd });
		writeFileSync(
			join(clioStateDir(), "runs.json"),
			JSON.stringify([
				row("own", "s", "/elsewhere"),
				row("sibling", "t", project),
				row("legacy", null, project),
				row("foreign", "t", "/other-project"),
				// A fork's /view lists its ancestors' runs as monitor does, through a deleted parent too (FL-14).
				row("parent", "m", "/parent-project"),
				row("grandparent", "g", "/grand-project"),
			]),
		);
		seedForkCallJournal(clioStateDir(), "m", {
			parentSessionId: "g",
			parentCwdHash: "fixture",
			parentTurnId: "turn-g",
			parentTurnAt: "2026-09-22T00:00:00Z",
		});
		const provider = new DispatchArtifactProvider({
			stateDir: clioStateDir(),
			sessionMeta: {
				id: "s",
				cwd: project,
				cwdHash: "fixture",
				createdAt: "2026-09-23T00:00:00Z",
				endedAt: null,
				model: null,
				target: null,
				clioCoderVersion: "0.5.4",
				piMonoVersion: "fixture",
				platform: "linux",
				nodeVersion: process.version,
				sessionFormatVersion: 4,
				parentSessionId: "m",
			},
		});
		deepStrictEqual((await provider.list()).map((artifact) => artifact.id).sort(), [
			"grandparent",
			"legacy",
			"own",
			"parent",
			"sibling",
		]);
	});
});
