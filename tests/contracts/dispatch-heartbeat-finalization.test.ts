import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { withStateFileLock } from "../../src/core/state-file-lock.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { verifyReceiptFileReport } from "../../src/interactive/view/artifacts.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(async () => isolateDispatchState());
afterEach(() => restoreDispatchState());

function controlledWorker() {
	let finish!: (result: SpawnedWorkerResult) => void;
	let aborts = 0;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		finish = resolve;
	});
	const worker: SpawnedWorker = {
		pid: null,
		promise,
		heartbeatAt: { current: Date.now(), monotonic: 0 },
		events: (async function* () {
			await promise;
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
				},
			};
		})(),
		abort() {
			aborts += 1;
			finish({ exitCode: null, signal: "SIGTERM" });
		},
	};
	return { worker, finish: () => finish({ exitCode: 0, signal: null }), aborts: () => aborts };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		ok(Date.now() < deadline, "dispatch did not reach the expected persistence boundary");
		await sleep(5);
	}
}

const request = {
	agentId: "scout",
	task: "Inspect the fixture input and report available evidence.",
	executionRole: "researcher" as const,
	requestOrigin: "internal" as const,
	resultContractOverride: { kind: "provenance-report" as const },
};

it("keeps parallel receipts sealed while heartbeat ticks during contended final persistence", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const stateDir = process.env.CLIO_CODER_STATE_DIR;
	ok(stateDir);
	const project = join(stateDir, "project");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "input.txt"), "expected\n");
	execFileSync("git", ["init", "-q", "-b", "main", project]);
	const checkLog = join(stateDir, "check-runs.log");
	const check = {
		check: "test",
		argv: [
			process.execPath,
			"-e",
			`const fs = require('node:fs'); require('node:assert/strict').equal(fs.readFileSync('input.txt', 'utf8'), 'expected\\n'); fs.appendFileSync(${JSON.stringify(checkLog)}, 'checked\\n');`,
		],
		cwd: project,
		timeoutMs: 5_000,
	};
	const intent = declaredScopeIntent({ readRoots: ["input.txt"] });
	ok(intent.ok);
	const workers = [controlledWorker(), controlledWorker()];
	let spawned = 0;
	let monotonic = 0;
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker: () => {
			const controlled = workers[spawned++];
			ok(controlled);
			return controlled.worker;
		},
		heartbeatIntervalMs: 10,
		heartbeatSpec: { windowMs: 10, graceMs: 10 },
		monotonicNow: () => monotonic,
	});
	let releaseLock: (() => void) | undefined;
	let lock: Promise<void> | undefined;
	await bundle.extension.start();
	try {
		const batch = await bundle.contract.dispatchBatch(
			workers.map(() => ({ ...request, cwd: project, intent: intent.intent, resolvedVerification: [check] })),
		);
		strictEqual(spawned, 2);
		const runIds = bundle.contract.listRuns().map((run) => run.id);
		let locked = false;
		lock = withStateFileLock(join(stateDir, "runs.json"), async () => {
			locked = true;
			await new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
		});
		await waitFor(() => locked);
		for (const worker of workers) worker.finish();
		await waitFor(() => runIds.every((id) => existsSync(join(stateDir, "receipts", `${id}.json`))));
		const statuses = [];
		for (const age of [0, 15, 25]) {
			monotonic = age;
			t.mock.timers.tick(10);
			statuses.push(runIds.map((id) => bundle.contract.getRun(id)?.status));
		}
		releaseLock?.();
		await lock;
		const receipts = await batch.finalPromise;
		strictEqual(readFileSync(checkLog, "utf8"), "checked\n", "batch check actually ran once");
		for (const receipt of receipts) {
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.hostVerification?.status, "verified");
			strictEqual(receipt.hostVerification?.strategy, "batch-settled");
			const verification = verifyReceiptFileReport(stateDir, receipt.runId);
			ok(verification.ok, JSON.stringify(verification));
		}
		deepStrictEqual(
			statuses,
			Array.from({ length: 3 }, () => ["completed", "completed"]),
		);
		deepStrictEqual(
			workers.map((worker) => worker.aborts()),
			[0, 0],
		);
		const owner = receipts.find((receipt) => receipt.hostVerification?.checks[0]?.evidenceRunId === undefined);
		ok(owner);
		const sibling = receipts.find((receipt) => receipt.runId !== owner.runId);
		strictEqual(sibling?.hostVerification?.checks[0]?.evidenceRunId, owner.runId);
	} finally {
		releaseLock?.();
		await lock;
		for (const worker of workers) worker.finish();
		await bundle.extension.stop?.();
	}
});

it("still marks an unfinished worker stale and terminates it when its heartbeat dies", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const controlled = controlledWorker();
	let monotonic = 0;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: () => controlled.worker,
		heartbeatIntervalMs: 10,
		heartbeatSpec: { windowMs: 10, graceMs: 10 },
		monotonicNow: () => monotonic,
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch(request);
		monotonic = 15;
		t.mock.timers.tick(10);
		strictEqual(bundle.contract.getRun(run.runId)?.status, "stale");
		monotonic = 25;
		t.mock.timers.tick(10);
		strictEqual(controlled.aborts(), 1);
		const receipt = await run.finalPromise;
		strictEqual(receipt.outcome, "stalled");
		strictEqual(bundle.contract.getRun(run.runId)?.status, "dead");
	} finally {
		controlled.finish();
		await bundle.extension.stop?.();
	}
});
