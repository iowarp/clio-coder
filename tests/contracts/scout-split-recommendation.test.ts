import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseScoutResult } from "../../src/domains/agents/result-contract.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";

const SCOUT_RESULT = JSON.stringify({
	citations: [{ path: "src/tools/dispatch.ts", line: 576 }],
	needsSplit: true,
	proposedSubtasks: ["Inspect src/tools/dispatch.ts"],
});

function receiptEnvelope(draft: RunReceiptDraft): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
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
				quality: {
					version: 1,
					typedValidations: [],
					responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
					resultContract: null,
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
		snapshot: () => ({
			generatedAt: "",
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
	return createDispatchTool({ dispatch });
}

describe("contracts/Scout structured result", () => {
	it("accepts citation-bearing structured output and rejects prose sentinels", () => {
		deepStrictEqual(parseScoutResult(SCOUT_RESULT), {
			citations: [{ path: "src/tools/dispatch.ts", line: 576 }],
			needsSplit: true,
			proposedSubtasks: ["Inspect src/tools/dispatch.ts"],
		});
		strictEqual(parseScoutResult("SPLIT RECOMMENDATION: prose\n- inspect"), null);
	});

	it("promotes one integrity-valid structured Scout result", async () => {
		const result = await toolForAnswer(SCOUT_RESULT).run({ task: "map", agent_id: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual(
			(result.details as { splitRecommendation?: unknown }).splitRecommendation,
			parseScoutResult(SCOUT_RESULT),
		);
		ok(result.output.includes(SCOUT_RESULT));
	});

	it("does not promote an identical structured result from another agent", async () => {
		const result = await toolForAnswer(SCOUT_RESULT).run({ task: "map", agent_id: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") strictEqual("splitRecommendation" in (result.details ?? {}), false);
	});
});
