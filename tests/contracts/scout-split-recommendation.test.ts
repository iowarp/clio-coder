import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseScoutResult, resultContractSourceId } from "../../src/domains/agents/result-contract.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";

const SCOUT_RESULT = JSON.stringify({
	findings: [],
	needsSplit: true,
	proposedSubtasks: [
		{
			id: "inspect-dispatch",
			task: "Inspect src/tools/dispatch.ts",
			dependencies: [],
			expectedResultContract: "scout-report",
			requestedAuthority: "read-only",
		},
	],
});

const SCOUT_SPEC: AgentSpec = {
	version: 1,
	id: "scout",
	name: "Scout",
	description: "test Scout",
	source: "builtin",
	filepath: "scout.md",
	tools: [],
	toolRequirements: { required: [], optional: [] },
	category: "explore",
	capabilityClass: "read-only",
	latencyClass: "fast",
	projectContextTier: "none",
	audience: "base",
	tags: [],
	skills: [],
	resultContract: { kind: "scout-report" },
	budget: { toolCalls: 1, readReserve: 0, synthesis: false },
	body: "",
};

function receiptEnvelope(draft: RunReceiptDraft): RunEnvelope {
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
		outcome: draft.outcome,
		exitCode: draft.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath: `/tmp/${draft.runId}.json`,
		sessionId: draft.sessionId,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
	};
}

function assistantEvents(text: string): AsyncIterableIterator<unknown> {
	return (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: text } };
	})();
}

function toolForAnswer(answer: string) {
	let envelope: RunEnvelope | null = null;
	const dispatch: DispatchContract = {
		dispatch: async (request: DispatchRequest) => {
			const draft: RunReceiptDraft = {
				costProvenance: "unknown",
				outcome: "succeeded",
				runId: "run-scout",
				agentId: request.agentId,
				executionRole: "builder",
				task: request.task,
				targetId: "target",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				startedAt: "",
				endedAt: "",
				exitCode: 0,
				tokenCount: 0,
				costUsd: 0,
				compiledPromptHash: null,
				staticCompositionHash: null,
				clioVersion: "0.0.0",
				piMonoVersion: "0.0.0",
				platform: "",
				nodeVersion: "",
				toolCalls: 0,
				toolStats: [],
				sessionId: null,
				verification: { state: "not_applicable", basis: "read-only-agent" },
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
					resultContract: {
						sourceId: resultContractSourceId({ kind: "scout-report" }),
						validatorDigest: "a".repeat(64),
						conformance: "pass",
						quality: "pass",
					},
				},
				output: { state: "final", text: answer, bytes: Buffer.byteLength(answer), truncated: false },
			};
			envelope = receiptEnvelope(draft);
			return {
				runId: draft.runId,
				events: assistantEvents(answer),
				finalPromise: Promise.resolve(withReceiptIntegrity(draft, envelope)),
			};
		},
		dispatchBatch: async () => {
			throw new Error("unexpected batch");
		},
		listRuns: () => [],
		getRun: () => envelope,
		abort: () => {},
		steer: () => {},
		planAgentSelection: () => {
			throw new Error("unexpected agent plan selection");
		},
		snapshot: () => ({
			generatedAt: "",
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
	return createDispatchTool({ dispatch, getAgentSpecs: () => [SCOUT_SPEC] });
}

describe("contracts/Scout structured result", () => {
	it("accepts citation-bearing structured output and rejects prose sentinels", () => {
		deepStrictEqual(parseScoutResult(SCOUT_RESULT), {
			findings: [],
			citations: [],
			needsSplit: true,
			proposedSubtasks: [
				{
					id: "inspect-dispatch",
					task: "Inspect src/tools/dispatch.ts",
					dependencies: [],
					expectedResultContract: "scout-report",
					requestedAuthority: "read-only",
				},
			],
		});
		strictEqual(parseScoutResult("SPLIT RECOMMENDATION: prose\n- inspect"), null);
	});

	it("exposes one integrity-valid structured Scout transition", async () => {
		const result = await toolForAnswer(SCOUT_RESULT).run({ task: "map", agent: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual((result.details as { scoutTransition?: unknown }).scoutTransition, {
			kind: "proposed",
			sourceRunId: "run-scout",
			sourceReceiptDigest: (result.details as { runs: Array<{ receiptIntegrity: { ok: boolean } }> }).runs
				? (envelopeDigest(result.details) ?? "")
				: "",
			subtaskCount: 1,
			continueWith: {
				from_scout: { run_id: "run-scout", receipt_digest: envelopeDigest(result.details) ?? "" },
			},
		});
		strictEqual("splitRecommendation" in (result.details ?? {}), false);
		ok(result.output.includes(SCOUT_RESULT));
	});

	it("does not promote an identical structured result from another agent", async () => {
		const result = await toolForAnswer(SCOUT_RESULT).run({ task: "map", agent: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") strictEqual("scoutTransition" in (result.details ?? {}), false);
	});
});

function envelopeDigest(details: unknown): string | null {
	if (typeof details !== "object" || details === null) return null;
	const transition = (details as { scoutTransition?: { sourceReceiptDigest?: unknown } }).scoutTransition;
	return typeof transition?.sourceReceiptDigest === "string" ? transition.sourceReceiptDigest : null;
}
