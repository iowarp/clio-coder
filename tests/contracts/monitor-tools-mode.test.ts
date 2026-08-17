import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createDispatchRunEventRegistry } from "../../src/tools/dispatch.js";
import { createMonitorTool } from "../../src/tools/monitor.js";

/**
 * monitor(mode="tools") answers "what did this run execute", the question that
 * previously took an orchestrator 31 unrelated calls to approximate. It is
 * honest about its two sources: a bounded in-process event buffer that records
 * tool name and outcome, and the run's integrity-verified receipt totals.
 */

const scratchRoots: string[] = [];

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-monitor-tools-"));
	scratchRoots.push(root);
	return root;
}

function receiptDraft(runId: string, overrides: Partial<RunReceiptDraft> = {}): RunReceiptDraft {
	return {
		runId,
		agentId: "coder",
		executionRole: "builder",
		task: `task ${runId}`,
		targetId: "local",
		wireModelId: "test-model",
		runtimeId: "test-runtime",
		runtimeKind: "http",
		startedAt: "2026-08-13T00:00:00.000Z",
		endedAt: "2026-08-13T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 2,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0-test",
		piMonoVersion: "0.0.0-test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 3,
		toolStats: [
			{ tool: "bash", count: 2, ok: 1, errors: 0, blocked: 1, totalDurationMs: 40 },
			{ tool: "write", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 5 },
		],
		toolActivity: { calls: 3, succeeded: 2, failed: 0, blocked: 1, mutatingSucceeded: true },
		safety: {
			decisions: { allowed: 2, blocked: 0, permissionRequested: 1 },
			blockedAttempts: [{ tool: "bash", actionClass: "execute", ruleId: "bash-unrecognized", reasonCode: "no-operator" }],
			requestedActions: ["write"],
			runtimeLimitations: [],
		},
		sessionId: "monitor-tools-test",
		...overrides,
		verification: overrides.verification ?? { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: overrides.quality ?? {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: overrides.costProvenance ?? "unknown",
		outcome: overrides.outcome ?? "succeeded",
	};
}

function envelopeFor(draft: RunReceiptDraft, receiptPath: string | null): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
		executionRole: "builder",
		task: draft.task,
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: "completed",
		outcome: draft.outcome ?? null,
		outcomeDetail: null,
		outcomeCode: null,
		exitCode: draft.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath,
		sessionId: draft.sessionId,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
	};
}

function writeSealedReceipt(
	root: string,
	draft: RunReceiptDraft,
	tamper?: (receipt: RunReceipt) => RunReceipt,
): RunEnvelope {
	const receiptPath = join(root, `${draft.runId}.json`);
	const envelope = envelopeFor(draft, receiptPath);
	const sealed = withReceiptIntegrity(draft, envelope);
	writeFileSync(receiptPath, `${JSON.stringify(tamper ? tamper(sealed) : sealed)}\n`, "utf8");
	return envelope;
}

function monitorContract(envelopes: ReadonlyArray<RunEnvelope>): DispatchContract {
	const byId = new Map(envelopes.map((envelope) => [envelope.id, envelope]));
	return {
		dispatch: async () => {
			throw new Error("dispatch is not used by monitor tools-mode tests");
		},
		dispatchBatch: async () => {
			throw new Error("dispatchBatch is not used by monitor tools-mode tests");
		},
		listRuns: () => envelopes,
		getRun: (runId) => byId.get(runId) ?? null,
		abort: () => {},
		steer: () => {},
		planAgentSelection: () => {
			throw new Error("unexpected agent plan selection");
		},
		snapshot: () => ({
			generatedAt: new Date(0).toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
}

function toolFinish(tool: string, outcome: string): unknown {
	return { type: "clio_tool_finish", payload: { tool, outcome, posture: "operating", durationMs: 3 } };
}

describe("contracts/monitor tools mode", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("lists the run's executed calls and the receipt's per-tool totals", async () => {
		const root = scratchDir();
		const envelope = writeSealedReceipt(root, receiptDraft("run-tools"));
		const runEvents = createDispatchRunEventRegistry();
		runEvents.recordEvent("run-tools", "coder", toolFinish("bash", "ok"));
		runEvents.recordEvent("run-tools", "coder", toolFinish("write", "ok"));
		runEvents.recordEvent("run-tools", "coder", { type: "message_end" });
		runEvents.recordEvent("run-tools", "coder", toolFinish("bash", "blocked"));

		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]), runEvents });
		const result = await monitor.run({ run_id: "run-tools", mode: "tools" }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;

		match(result.output, /tool calls for run run-tools \(coder\)/);
		match(result.output, /executed calls from this process's event buffer \(newest last, 3 of 3\)/);
		match(result.output, /clio_tool_finish: bash ok/);
		match(result.output, /clio_tool_finish: write ok/);
		// Most recent last: the blocked bash call was the run's final tool event.
		ok(result.output.indexOf("bash blocked") > result.output.indexOf("write ok"), result.output);
		// Non-tool traffic stays out of a list of executed calls.
		ok(!result.output.includes("message_end"), result.output);
		match(result.output, /receipt totals \(integrity verified\)/);
		match(result.output, /totals: calls=3 succeeded=2 failed=0 blocked=1 mutating_succeeded=true/);
		match(result.output, /bash: count=2 ok=1 errors=0 blocked=1 total_ms=40/);
		match(result.output, /blocked: bash class=execute rule=bash-unrecognized/);
		match(result.output, /does not pretend|not command arguments/);
		strictEqual(result.details?.mode, "tools");
		strictEqual(result.details?.callCount, 3);
		strictEqual(result.details?.bufferAvailable, true);
		strictEqual(result.details?.receiptAvailable, true);
	});

	it("says so when the buffer is gone and still reports receipt totals", async () => {
		const root = scratchDir();
		const envelope = writeSealedReceipt(root, receiptDraft("run-no-buffer"));
		const monitor = createMonitorTool({
			dispatch: monitorContract([envelope]),
			runEvents: createDispatchRunEventRegistry(),
		});
		const result = await monitor.run({ run_id: "run-no-buffer", mode: "tools" }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /no event buffer for this run in this process/);
		match(result.output, /receipt totals \(integrity verified\)/);
		strictEqual(result.details?.callCount, 0);
		strictEqual(result.details?.bufferAvailable, false);
	});

	it("withholds totals from a receipt that fails its integrity check", async () => {
		const root = scratchDir();
		const envelope = writeSealedReceipt(root, receiptDraft("run-tampered"), (sealed) => ({
			...sealed,
			toolCalls: 999,
		}));
		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]) });
		const result = await monitor.run({ run_id: "run-tampered", mode: "tools" }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /receipt totals: unavailable\. receipt integrity failed/);
		ok(!result.output.includes("999"), result.output);
		strictEqual(result.details?.receiptAvailable, false);
	});

	it("keeps the newest calls when a run exceeds the line budget", async () => {
		const root = scratchDir();
		const envelope = writeSealedReceipt(root, receiptDraft("run-busy"));
		const runEvents = createDispatchRunEventRegistry();
		for (let index = 0; index < 80; index += 1) runEvents.recordEvent("run-busy", "coder", toolFinish(`t${index}`, "ok"));
		const monitor = createMonitorTool({ dispatch: monitorContract([envelope]), runEvents });
		const result = await monitor.run({ run_id: "run-busy", mode: "tools" }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		// The event buffer itself caps at 100 entries per run; the tools view caps
		// at 60 lines and says how many it dropped.
		match(result.output, /older omitted/);
		match(result.output, /t79 ok/);
		ok(!result.output.includes("t10 ok"), result.output);
		ok((result.details?.omitted as number) > 0, JSON.stringify(result.details));
	});

	it("rejects an unknown run and an unknown mode", async () => {
		const monitor = createMonitorTool({ dispatch: monitorContract([]) });
		const unknownRun = await monitor.run({ run_id: "nope", mode: "tools" }, {});
		strictEqual(unknownRun.kind, "error");
		const unknownMode = await monitor.run({ run_id: "nope", mode: "toolz" }, {});
		strictEqual(unknownMode.kind, "error");
		if (unknownMode.kind !== "error") return;
		match(unknownMode.message, /status, peek, receipt, list, wait, collect, or tools/);
	});
});
