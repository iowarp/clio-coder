import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { readAccountabilitySummary } from "../../src/domains/observability/accountability.js";
import { readEvidenceIndex } from "../../src/domains/observability/evidence-index.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import { newScratchClioHome } from "../harness/scratch-env.js";

/**
 * Drive the auto-build path in-process: emit a DispatchCompleted on the bus and
 * assert that the observability listener builds an evidence bundle under
 * <dataDir>/evidence/run-<id>/ and writes a sidecar index row, with no
 * `clio evidence` CLI call. Also assert that an unknown runId (whose build
 * throws inside buildEvidence) is swallowed and never crashes the run.
 */

interface Scratch {
	dir: string;
	dataDir: string;
	stateDir: string;
}

function makeScratch(): Scratch {
	// newScratchClioHome points the CLIO_* env at a fresh scratch home and resets
	// the XDG cache; we still mkdir the data/state dirs this suite seeds directly.
	const dir = newScratchClioHome("clio-auto-evidence-");
	const dataDir = join(dir, "data");
	const stateDir = join(dir, "state");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	return { dir, dataDir, stateDir };
}

function runEnvelope(runId: string, sessionId: string | null = null): Record<string, unknown> {
	return {
		id: runId,
		agentId: "agent-smoke",
		executionRole: "builder",
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
		sessionId,
		cwd: "/tmp/smoke",
		tokenCount: 0,
		costUsd: 0,
	};
}

function seedRun(stateDir: string, runId: string, sessionId: string | null = null): void {
	const envelope = runEnvelope(runId, sessionId);
	writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify([envelope], null, 2)}\n`, "utf8");
}

function seedRuns(stateDir: string, runIds: readonly string[]): void {
	const envelopes = runIds.map((runId) => runEnvelope(runId));
	writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify(envelopes, null, 2)}\n`, "utf8");
}

function seedValidationSession(stateDir: string, sessionId: string): void {
	seedValidationSessionAt(stateDir, sessionId, "2026-06-24T00:00:00.500Z");
}

function seedValidationSessionAt(stateDir: string, sessionId: string, timestamp: string): void {
	const sessionDir = join(stateDir, "sessions", "smoke-cwd", sessionId);
	mkdirSync(sessionDir, { recursive: true });
	const entry = {
		kind: "bashExecution",
		turnId: "turn-validation",
		parentTurnId: null,
		timestamp,
		command: "npm test",
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
	writeFileSync(join(sessionDir, "current.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

function makeContext(): DomainContext {
	return {
		bus: createSafeEventBus(),
		getContract: () => undefined,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`child exited code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderr}`));
		});
	});
}

async function sealRunWithConservativeReceiptSummary(input: { stateDir: string; sessionId: string }): Promise<string> {
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "agent-smoke",
		executionRole: "builder",
		task: "validate transcript-level evidence",
		targetId: "target-smoke",
		wireModelId: "model-smoke",
		runtimeId: "runtime-smoke",
		runtimeKind: "subprocess",
		sessionId: input.sessionId,
		cwd: "/tmp/smoke",
	});
	const validationTimestamp = new Date(Date.parse(envelope.startedAt) + 500).toISOString();
	const validationTime = Date.parse(validationTimestamp);
	const endedAt = new Date(validationTime + 1000).toISOString();
	ledger.update(envelope.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		endedAt,
		exitCode: 0,
		lineage: { parentRunId: null, rootRunId: envelope.id, attempt: 0, depth: 0 },
		tokenCount: 0,
		inputTokenCount: 0,
		outputTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0,
	});
	const receipt = ledger.recordReceipt(envelope.id, {
		verification: { state: "unverified", basis: "no-validation-tool" },
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: "agent-smoke",
		executionRole: "builder",
		task: "validate transcript-level evidence",
		targetId: "target-smoke",
		wireModelId: "model-smoke",
		runtimeId: "runtime-smoke",
		runtimeKind: "subprocess",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage: { parentRunId: null, rootRunId: envelope.id, attempt: 0, depth: 0 },
		startedAt: envelope.startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 0,
		inputTokenCount: 0,
		outputTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		toolActivity: { calls: 0, succeeded: 0, failed: 0, blocked: 0, mutatingSucceeded: false },
		sessionId: input.sessionId,
	});
	strictEqual(receipt.findingsSummary?.firstPassSuccess, false);
	await ledger.persist();
	seedValidationSessionAt(input.stateDir, input.sessionId, validationTimestamp);
	return envelope.id;
}

describe("auto-build evidence on dispatch completion", { concurrency: false }, () => {
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

	it("builds a bundle and writes a no-validation index row with no CLI call", async () => {
		const runId = "smoke-run-001";
		seedRun(scratch.stateDir, runId);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.DispatchCompleted, {
			runId,
			agentId: "agent-smoke",
			targetId: "target-smoke",
			wireModelId: "model-smoke",
			runtimeId: "runtime-smoke",
			runtimeKind: "subprocess",
			requestOrigin: "user",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			tokenCount: 0,
			inputTokenCount: 0,
			outputTokenCount: 0,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
			durationMs: 1000,
			exitCode: 0,
			toolActivity: null,
		});

		const bundleDir = join(scratch.dataDir, "evidence", `run-${runId}`);
		const indexPath = join(scratch.stateDir, "evidence-index.json");
		const built = await waitFor(() => existsSync(bundleDir) && existsSync(indexPath));
		ok(built, "expected evidence bundle dir and index file to appear");
		ok(existsSync(join(bundleDir, "overview.json")), "expected overview.json in the bundle");

		const rows = readEvidenceIndex(scratch.stateDir);
		strictEqual(rows.length, 1);
		const row = rows[0];
		ok(row !== undefined);
		strictEqual(row.runId, runId);
		strictEqual(row.evidenceId, `run-${runId}`);
		// Succeeded and attempt 0 are not enough: first-pass requires linked
		// validation evidence, so a bare run is tagged no-validation and false.
		strictEqual(row.firstPassSuccess, false);
		ok(row.tags.includes("no-validation"), `expected no-validation tag in ${JSON.stringify(row.tags)}`);
		strictEqual(typeof row.findingCount, "number");

		await bundle.extension.stop?.();
	});

	it("marks first-pass success only when the completed run has validation evidence", async () => {
		const runId = "smoke-run-validated";
		const sessionId = "session-validated";
		seedRun(scratch.stateDir, runId, sessionId);
		seedValidationSession(scratch.stateDir, sessionId);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.DispatchCompleted, {
			runId,
			agentId: "agent-smoke",
			targetId: "target-smoke",
			wireModelId: "model-smoke",
			runtimeId: "runtime-smoke",
			runtimeKind: "subprocess",
			requestOrigin: "user",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			tokenCount: 0,
			inputTokenCount: 0,
			outputTokenCount: 0,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
			durationMs: 1000,
			exitCode: 0,
			toolActivity: null,
		});

		const built = await waitFor(() => readEvidenceIndex(scratch.stateDir).length === 1);
		ok(built, "expected index row to appear");
		const row = readEvidenceIndex(scratch.stateDir)[0];
		ok(row !== undefined);
		strictEqual(row.runId, runId);
		strictEqual(row.firstPassSuccess, true);
		strictEqual(row.tags.includes("no-validation"), false);

		await bundle.extension.stop?.();
	});

	it("uses forensic validation as the user-visible first-pass authority when the receipt is conservative", async () => {
		const sessionId = "session-forensic-authority";
		const runId = await sealRunWithConservativeReceiptSummary({
			stateDir: scratch.stateDir,
			sessionId,
		});
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		context.bus.emit(BusChannels.DispatchCompleted, {
			runId,
			agentId: "agent-smoke",
			targetId: "target-smoke",
			wireModelId: "model-smoke",
			runtimeId: "runtime-smoke",
			runtimeKind: "subprocess",
			requestOrigin: "user",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			tokenCount: 0,
			inputTokenCount: 0,
			outputTokenCount: 0,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
			durationMs: 1000,
			exitCode: 0,
			toolActivity: null,
		});

		const built = await waitFor(() => readEvidenceIndex(scratch.stateDir).length === 1);
		ok(built, "expected index row to appear");
		const row = readEvidenceIndex(scratch.stateDir)[0];
		ok(row !== undefined);
		strictEqual(row.runId, runId);
		strictEqual(row.firstPassSuccess, true);
		strictEqual(row.tags.includes("no-validation"), false);

		const summary = readAccountabilitySummary(scratch.stateDir);
		strictEqual(summary.totalRuns, 1);
		strictEqual(summary.firstPassRuns, 1);
		strictEqual(summary.firstPassRate, 1);

		await bundle.extension.stop?.();
	});

	it("flushes an in-flight build on stop so a headless run still persists the bundle", async () => {
		const runId = "smoke-run-stop";
		seedRun(scratch.stateDir, runId);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		// Emit completion, then stop immediately without waiting. This mirrors a
		// headless `clio run` that tears the process down right after dispatch:
		// stop() must flush the pending forensic build rather than abandon it.
		context.bus.emit(BusChannels.DispatchCompleted, {
			runId,
			agentId: "agent-smoke",
			targetId: "target-smoke",
			wireModelId: "model-smoke",
			runtimeId: "runtime-smoke",
			runtimeKind: "subprocess",
			requestOrigin: "user",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
			tokenCount: 0,
			inputTokenCount: 0,
			outputTokenCount: 0,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
			durationMs: 1000,
			exitCode: 0,
			toolActivity: null,
		});

		await bundle.extension.stop?.();

		// No waitFor: the bundle and index row must exist the moment stop resolves.
		ok(existsSync(join(scratch.dataDir, "evidence", `run-${runId}`)), "expected the bundle dir after stop");
		const rows = readEvidenceIndex(scratch.stateDir);
		strictEqual(rows.length, 1);
		strictEqual(rows[0]?.runId, runId);
	});

	it("preserves every sidecar row when multiple builds finish during stop", async () => {
		const runIds = ["smoke-run-parallel-a", "smoke-run-parallel-b"];
		seedRuns(scratch.stateDir, runIds);
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		for (const runId of runIds) {
			context.bus.emit(BusChannels.DispatchCompleted, {
				runId,
				agentId: "agent-smoke",
				targetId: "target-smoke",
				wireModelId: "model-smoke",
				runtimeId: "runtime-smoke",
				runtimeKind: "subprocess",
				requestOrigin: "user",
				outcome: "succeeded",
				outcomeCode: null,
				outcomeDetail: null,
				lineage: { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 },
				tokenCount: 0,
				inputTokenCount: 0,
				outputTokenCount: 0,
				cacheReadTokenCount: 0,
				cacheWriteTokenCount: 0,
				reasoningTokenCount: 0,
				staticShellHash: null,
				sessionShellHash: null,
				dynamicHash: null,
				costUsd: 0,
				durationMs: 1000,
				exitCode: 0,
				toolActivity: null,
			});
		}

		await bundle.extension.stop?.();

		const rows = readEvidenceIndex(scratch.stateDir);
		strictEqual(rows.length, 2);
		deepStrictEqual(rows.map((row) => row.runId).sort(), [...runIds].sort());
	});

	it("serializes sidecar index merges across Clio processes", async () => {
		const startFile = join(scratch.dir, "start-index-writers");
		const writerPath = join(process.cwd(), "tests", "fixtures", "evidence-index-writer.ts");
		const runIds = Array.from({ length: 16 }, (_, index) => `process-run-${String(index).padStart(2, "0")}`);
		const waits = runIds.map((runId) => {
			const child = spawn(process.execPath, ["--import", "tsx", writerPath, scratch.stateDir, runId, startFile], {
				cwd: process.cwd(),
				env: { ...process.env },
				stdio: ["ignore", "ignore", "pipe"],
			});
			return waitForChild(child);
		});

		writeFileSync(startFile, "go\n", "utf8");
		await Promise.all(waits);

		const rows = readEvidenceIndex(scratch.stateDir);
		strictEqual(rows.length, runIds.length);
		deepStrictEqual(rows.map((row) => row.runId).sort(), [...runIds].sort());
	});

	it("swallows a build that throws for an unknown runId and never crashes", async () => {
		const context = makeContext();
		const bundle = createObservabilityBundle(context);
		await bundle.extension.start();

		// No run seeded: buildEvidence throws "run not found". The handler must
		// swallow it. emit() returns normally and no index row is written.
		context.bus.emit(BusChannels.DispatchCompleted, {
			runId: "does-not-exist",
			agentId: "agent-smoke",
			targetId: "target-smoke",
			wireModelId: "model-smoke",
			runtimeId: "runtime-smoke",
			runtimeKind: "subprocess",
			requestOrigin: "user",
			outcome: "succeeded",
			outcomeCode: null,
			outcomeDetail: null,
			lineage: { parentRunId: null, rootRunId: "does-not-exist", attempt: 0, depth: 0 },
			tokenCount: 0,
			inputTokenCount: 0,
			outputTokenCount: 0,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
			durationMs: 1000,
			exitCode: 0,
			toolActivity: null,
		});

		// Give the fire-and-forget build a window to settle, then assert the run
		// is unaffected: no throw escaped, no bundle, no index row.
		await new Promise((resolve) => setTimeout(resolve, 250));
		strictEqual(existsSync(join(scratch.stateDir, "evidence-index.json")), false);
		strictEqual(existsSync(join(scratch.dataDir, "evidence", "run-does-not-exist")), false);
		strictEqual(readEvidenceIndex(scratch.stateDir).length, 0);

		await bundle.extension.stop?.();
	});
});
