import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
import { openDetachedBatchViews } from "../../src/domains/middleware/dispatch-nudge.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { DispatchArtifactProvider } from "../../src/interactive/view/artifacts.js";
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
	return { worker, aborts: () => aborts, finish: () => resolve({ exitCode: 0, signal: null }) };
}

interface SessionFixture {
	contract: DispatchContract;
	workers: ReturnType<typeof controlledWorker>[];
	request: DispatchRequest;
	call(tool: string, args: Record<string, unknown>): Promise<ToolResult>;
	stop(): Promise<void>;
}

async function openSession(scratch: IsolatedClioEnv, sessionId: string, projectDir: string): Promise<SessionFixture> {
	const workers: ReturnType<typeof controlledWorker>[] = [];
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		getSessionId: () => sessionId,
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
			const read = okResult(await a.call(ToolNames.Monitor, { mode: "receipt", run_id: runId }));
			strictEqual((read.details?.receiptIntegrity as { ok: boolean }).ok, true, "the stamp is inside the seal");
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

	it("lists only this session's runs and refuses to inspect or collect another project's", async () => {
		const { a, runId } = await finishedRunInA(scratch, projectA);
		const b = await openSession(scratch, "session-b", process.cwd());
		try {
			const listed = okResult(await b.call(ToolNames.Monitor, { mode: "list" }));
			strictEqual(listed.output, "No dispatched runs recorded for this session.");
			const own = okResult(await a.call(ToolNames.Monitor, { mode: "list" }));
			deepStrictEqual(own.details?.runs, [{ runId, agentId: "scout", state: "succeeded" }]);

			for (const mode of ["status", "receipt", "tools", "peek", "wait"]) {
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
			okResult(await sibling.call(ToolNames.Monitor, { mode: "receipt", run_id: runId }));
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
				/belongs to another session/,
			);
			match(
				errorMessage(await b.call(ToolNames.Steer, { run_id: handle.runId, action: "guide", message: "stop" })),
				/belongs to another session/,
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
						ref: { runId, receiptDigest: receipt.integrity.digest },
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
				group: "review-a",
				topology: "review",
				cycle: 1,
				subjects: [subject],
				deciderRunId: runId,
				finalOutput: "{}",
			});
			stagePendingGateOutput({
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
			]),
		);
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
			},
		});
		deepStrictEqual((await provider.list()).map((artifact) => artifact.id).sort(), ["legacy", "own", "sibling"]);
	});
});
