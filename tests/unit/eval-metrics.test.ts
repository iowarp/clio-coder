import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import {
	type EvalRunRecord,
	evalHarnessMetricsFromCommands,
	evalHarnessMetricsFromReceipt,
	sumEvalHarnessMetrics,
} from "../../src/domains/eval/index.js";

describe("eval harness metrics", () => {
	it("counts verifier commands as validation evidence", () => {
		deepStrictEqual(
			evalHarnessMetricsFromCommands([command("setup", 0), command("verifier", 0), command("verifier", 1)]),
			{
				receiptCount: 0,
				toolCalls: 0,
				retries: 0,
				safetyBlocks: 0,
				correctionLatencyMs: 0,
				validationEvidence: 2,
			},
		);
	});

	it("extracts receipt-backed tool and safety counts", () => {
		deepStrictEqual(evalHarnessMetricsFromReceipt(receipt(), { retries: 1, correctionLatencyMs: 250 }), {
			receiptCount: 1,
			toolCalls: 3,
			retries: 1,
			safetyBlocks: 2,
			correctionLatencyMs: 250,
			validationEvidence: 0,
		});
	});

	it("sums per-record harness metrics for comparison", () => {
		deepStrictEqual(
			sumEvalHarnessMetrics([
				record({ toolCalls: 2, validationEvidence: 1 }),
				record({ retries: 1, safetyBlocks: 1, correctionLatencyMs: 100 }),
			]),
			{
				receiptCount: 0,
				toolCalls: 2,
				retries: 1,
				safetyBlocks: 1,
				correctionLatencyMs: 100,
				validationEvidence: 1,
			},
		);
	});
});

function command(phase: "setup" | "verifier", index: number) {
	return {
		phase,
		index,
		command: "true",
		exitCode: 0,
		signal: null,
		timedOut: false,
		wallTimeMs: 1,
		stdout: "",
		stderr: "",
	};
}

function record(overrides: Partial<EvalRunRecord["harness"]>): EvalRunRecord {
	return {
		taskId: "task",
		runId: "run",
		repeatIndex: 0,
		cwd: "/repo",
		prompt: "Run verifier.",
		tags: [],
		pass: true,
		exitCode: 0,
		tokens: 0,
		costUsd: 0,
		wallTimeMs: 0,
		harness: {
			receiptCount: 0,
			toolCalls: 0,
			retries: 0,
			safetyBlocks: 0,
			correctionLatencyMs: 0,
			validationEvidence: 0,
			...overrides,
		},
		commands: [],
	};
}

function receipt(): RunReceipt {
	return {
		runId: "run",
		agentId: "agent",
		task: "task",
		endpointId: "local",
		wireModelId: "model",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-05-16T00:00:00.000Z",
		endedAt: "2026-05-16T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 0,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: "linux",
		nodeVersion: "v22.0.0",
		toolCalls: 3,
		toolStats: [],
		safety: {
			decisions: { allowed: 1, blocked: 2, elevated: 0 },
			blockedAttempts: [],
			dispatchScope: "any",
			workerMode: "default",
			requestedActions: ["read"],
			runtimeLimitations: [],
		},
		sessionId: null,
		integrity: {
			version: 1,
			algorithm: "sha256",
			digest: "0".repeat(64),
		},
	};
}
