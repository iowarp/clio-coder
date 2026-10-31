/** Run envelope and result draft fixtures for settlement (#434). */

import type { PricedBy } from "../../src/core/telemetry/pricing.js";
import { pricedUsd } from "../../src/core/telemetry/pricing.js";
import type { RunUsageFacts } from "../../src/core/telemetry/schemas.js";
import type { RunEnvelope, RunResultDraft } from "../../src/domains/dispatch/types.js";

/** A run spend whose every count the provider measured, priced as given (#434). */
export function measuredSpend(
	counts: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cacheWrite1h?: number;
		reasoning?: number;
		total?: number;
		calls?: number;
	} = {},
	usd: number | null = null,
	pricedBy: PricedBy = usd === null ? "none" : "target-rates",
): RunUsageFacts {
	const measured = (value: number) => ({ kind: "measured" as const, value, source: "provider" as const });
	const input = counts.input ?? 0;
	const output = counts.output ?? 0;
	const cacheRead = counts.cacheRead ?? 0;
	const cacheWrite = counts.cacheWrite ?? 0;
	return {
		usage: {
			input: measured(input),
			output: measured(output),
			cacheRead: measured(cacheRead),
			cacheWrite: measured(cacheWrite),
			cacheWrite1h: measured(counts.cacheWrite1h ?? 0),
			reasoning: measured(counts.reasoning ?? 0),
		},
		totalTokens: measured(counts.total ?? input + output + cacheRead + cacheWrite),
		apiCalls: { kind: "measured", value: counts.calls ?? 1, source: "local-count" },
		pricing: pricedUsd(pricedBy, usd),
	};
}

export function fixtureEnvelope(runId = "run-1"): RunEnvelope {
	return {
		version: 1,
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
		sessionId: "session-1",
		cwd: "/workspace",
		spend: measuredSpend({ input: 20, output: 22 }, 0.01),
		sessionShellHash: null,
		dynamicHash: null,
	};
}

export function fixtureReceiptDraft(envelope: RunEnvelope): RunResultDraft {
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
		spend: envelope.spend,
		compiledPromptHash: null,
		staticCompositionHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioCoderVersion: "0.2.7-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: envelope.sessionId,
	};
}
