import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import { newScratchClioHome } from "../harness/scratch-env.js";

/**
 * Drive the wired observability bundle (telemetry + cost + projection) through
 * the real dispatch bus channels and assert the product-facing snapshot folds
 * cost, tokens, metrics counters, and run summaries. Evidence readiness is
 * asserted only through the synchronous pending marker so the test never blocks
 * on the async forensic build.
 */

interface Scratch {
	dir: string;
	dataDir: string;
	stateDir: string;
}

function makeScratch(): Scratch {
	const dir = newScratchClioHome("clio-observability-snapshot-");
	const dataDir = join(dir, "data");
	const stateDir = join(dir, "state");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	return { dir, dataDir, stateDir };
}

function seedRun(stateDir: string, runId: string): void {
	const envelope = {
		id: runId,
		agentId: "agent-smoke",
		task: "run pytest to validate the change",
		targetId: "target-smoke",
		wireModelId: "model-smoke",
		runtimeId: "runtime-smoke",
		runtimeKind: "subprocess",
		startedAt: "2026-06-24T00:00:00.000Z",
		endedAt: "2026-06-24T00:00:01.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
		exitCode: 0,
		pid: 1234,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp/smoke",
		tokenCount: 0,
		costUsd: 0,
	};
	writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify([envelope], null, 2)}\n`, "utf8");
}

function makeContext(): DomainContext {
	return { bus: createSafeEventBus(), getContract: () => undefined };
}

function completedPayload(runId: string) {
	return {
		runId,
		agentId: "agent-smoke",
		targetId: "target-smoke",
		wireModelId: "model-smoke",
		runtimeId: "runtime-smoke",
		runtimeKind: "subprocess",
		requestOrigin: "user",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
		tokenCount: 800,
		inputTokenCount: 600,
		outputTokenCount: 200,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 15,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0.25,
		costProvenance: "estimated",
		durationMs: 4200,
		exitCode: 0,
		toolActivity: null,
	};
}

describe("contracts/observability-snapshot wiring", { concurrency: false }, () => {
	let scratch: Scratch;
	const savedEnv = { ...process.env };

	beforeEach(() => {
		scratch = makeScratch();
	});

	afterEach(() => {
		resetXdgCache();
		process.env = { ...savedEnv };
		rmSync(scratch.dir, { recursive: true, force: true });
	});

	it("folds a completed dispatch into cost, tokens, metrics, and a run summary", async () => {
		const runId = "snap-run-001";
		seedRun(scratch.stateDir, runId);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.DispatchCompleted, completedPayload(runId) as never);

		const snap = bundle.contract.snapshot();
		strictEqual(snap.session.costUsd, 0.25);
		deepStrictEqual(snap.session.cost, {
			knownUsd: 0.25,
			hasEstimated: true,
			hasUnknown: false,
			allKnownFree: false,
		});
		strictEqual(snap.session.tokens.totalTokens, 800);
		strictEqual(snap.session.tokens.input, 600);
		strictEqual(snap.session.tokens.output, 200);
		strictEqual(snap.session.tokens.cacheRead, 0);
		strictEqual(snap.session.tokens.cacheWrite, 0);
		strictEqual(snap.session.tokens.reasoningTokens, 15);
		strictEqual(snap.metrics.dispatchesCompleted, 1);
		strictEqual(snap.metrics.totalTokens, 800);
		const run = snap.runs.find((r) => r.runId === runId);
		ok(run !== undefined);
		strictEqual(run.status, "completed");
		strictEqual(run.costUsd, 0.25);
		strictEqual(run.costProvenance, "estimated");
		strictEqual(run.tokens.total, 800);

		// The evidence build is kicked off synchronously and tracked as pending
		// without blocking the bus handler.
		ok(snap.pendingEvidenceBuildRunIds.includes(runId));

		// sessionCost() and the snapshot agree.
		strictEqual(bundle.contract.sessionCost(), 0.25);

		await bundle.extension.stop?.();
	});

	it("resetSession() clears session-local cost/tokens and updates the snapshot", async () => {
		const runId = "snap-run-002";
		seedRun(scratch.stateDir, runId);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.DispatchCompleted, completedPayload(runId) as never);
		strictEqual(bundle.contract.snapshot().session.costUsd, 0.25);

		bundle.contract.resetSession();
		const snap = bundle.contract.snapshot();
		strictEqual(snap.session.costUsd, 0);
		strictEqual(snap.session.tokens.totalTokens, 0);
		strictEqual(snap.session.latestThroughput, null);
		// The run summary persists; resetSession only clears session-local totals.
		ok(snap.runs.some((r) => r.runId === runId));

		await bundle.extension.stop?.();
	});

	it("updates providerHealth on a probe event", async () => {
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.ProviderHealth, {
			id: "target-smoke",
			status: { available: true, reason: "ready" },
		} as never);

		const snap = bundle.contract.snapshot();
		strictEqual(snap.providerHealth["target-smoke"]?.available, true);

		await bundle.extension.stop?.();
	});
});
