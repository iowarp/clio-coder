/**
 * Shared receipt fixtures.
 *
 * The integrity digest covers every receipt field, so more than one contract
 * suite needs a complete, valid envelope and draft to seal and then tamper
 * with. Keeping one copy means a new required field breaks every suite at once
 * rather than letting one drift into asserting against a stale shape.
 */

import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";

export function fixtureEnvelope(runId = "run-1"): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
		executionRole: "builder",
		task: "run the test suite",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-06-25T12:00:00.000Z",
		endedAt: "2026-06-25T12:00:05.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: "session-1",
		cwd: "/workspace",
		tokenCount: 42,
		inputTokenCount: 20,
		outputTokenCount: 22,
		reasoningTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0.01,
	};
}

export function fixtureReceiptDraft(envelope: RunEnvelope): RunReceiptDraft {
	return {
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: envelope.agentId,
		executionRole: "builder",
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: envelope.endedAt ?? envelope.startedAt,
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: envelope.tokenCount,
		inputTokenCount: 20,
		outputTokenCount: 22,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: envelope.costUsd,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "0.2.7-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: envelope.sessionId,
	};
}
