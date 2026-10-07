import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { DispatchCompletedPayload } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import { TraceReader, TraceStore } from "../../src/domains/observability/trace-store.js";
import type { CostProvenance } from "../../src/domains/providers/index.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/session-control/turn-persistence.js";
import type { AgentRuntime, ChatTurnState } from "../../src/session-control/turn-state.js";

it("session traces retain known subtotals, call coverage, and pricing uncertainty", () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-session-trace-cost-"));
	const path = join(scratch, "trace.sqlite");
	const store = new TraceStore(path);
	try {
		for (const [id, prices, expected] of [
			["unknown", ["unknown"], null],
			["free", ["known_free"], 0],
			["priced", ["known", "known"], 0.5],
			["mixed", ["known", "unknown", "known"], 0.5],
			["estimated", ["estimated"], 0.25],
		] as const) {
			let sequence = 0;
			const session = {
				current: () => ({ id }),
				append: () => ({ id: `${id}-${++sequence}` }),
			} as unknown as SessionContract;
			const runtime = {
				targetId: "target",
				wireModelId: "model",
				runtimeId: "litellm",
				runtimeResolution: { costProvenance: prices[0] as CostProvenance },
				agent: {},
			} as unknown as AgentRuntime;
			const state = { runtime, lastTurnId: null } as ChatTurnState;
			const persistence = createTurnPersistence({
				state,
				session,
				getSettings: () => DEFAULT_SETTINGS,
				middlewareToolChoice: {} as MiddlewareToolChoiceControl,
				consumePersistedEcho: () => false,
				removeQueuedMirrorEntry: () => {},
				promptCachePayloadForAssistant: () => ({}),
				promptSideTokens: () => 0,
				observability: { recordSessionTurn: (trace) => store.recordSessionTurn(trace) } as ObservabilityContract,
			});
			const userTurn = persistence.appendSubmittedUserTurn(runtime, "calibration", undefined, false);
			for (const [index, provenance] of prices.entries()) {
				runtime.runtimeResolution.costProvenance = provenance;
				const continues = index < prices.length - 1;
				persistence.appendAssistantTurn({
					role: "assistant",
					content: continues
						? [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: "temperature.mjs" } }]
						: [{ type: "text", text: "checked" }],
					stopReason: continues ? "toolUse" : "stop",
					usage: {
						input: 10,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: id === "priced" && index === 0 ? 0 : 12,
						...(id === "mixed" && index === 1 ? { estimated: true } : {}),
						cost: { total: provenance === "known" || provenance === "estimated" ? 0.25 : 0 },
					},
				} as AgentMessage);
			}
			const reader = new TraceReader(path);
			try {
				const runId = `session:${userTurn}`;
				strictEqual(reader.run(runId)?.total_cost_usd, expected, id);
				strictEqual(reader.phases(runId)[0]?.total_cost_usd, expected, id);
				strictEqual(reader.run(runId)?.total_tokens, id === "priced" ? 12 : id === "mixed" ? 24 : prices.length * 12, id);
				strictEqual(reader.run(runId)?.api_calls, prices.length, id);
				strictEqual(reader.run(runId)?.missing_token_calls, id === "mixed" ? 1 : 0, id);
				strictEqual(reader.run(runId)?.cost_estimated, id === "estimated" ? 1 : 0, id);
				strictEqual(reader.run(runId)?.cost_unknown, id === "unknown" || id === "mixed" ? 1 : 0, id);
				strictEqual(reader.run(runId)?.status, "success", id);
			} finally {
				reader.close();
			}
		}
	} finally {
		store.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});

it("dispatch traces keep declared costs and withhold amounts with unknown or absent pricing", () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-dispatch-trace-cost-"));
	const path = join(scratch, "trace.sqlite");
	const store = new TraceStore(path);
	try {
		for (const [id, provenance, amount, expected] of [
			["unknown", "unknown", 0, null],
			["absent", undefined, 0, null],
			["unpriced-amount", "unknown", 0.25, null],
			["known", "known", 0.25, 0.25],
			["free", "known_free", 0, 0],
			["partial", "unknown", 0.25, 0.25],
		] as const) {
			store.finishRun(
				{
					runId: id,
					agentId: "coder",
					targetId: "target",
					wireModelId: "model",
					runtimeId: "litellm",
					tokenCount: 12,
					costUsd: amount,
					...(provenance === undefined ? {} : { costProvenance: provenance }),
					...(id === "partial"
						? {
								apiCalls: 3,
								missingTokenCalls: 1,
								costSummary: { knownUsd: 0.25, calls: 3, hasEstimated: true, hasUnknown: true, allKnownFree: false },
							}
						: {}),
				} as DispatchCompletedPayload,
				true,
			);
			const reader = new TraceReader(path);
			try {
				strictEqual(reader.run(id)?.total_cost_usd, expected, id);
				strictEqual(reader.phases(id)[0]?.total_cost_usd, expected, id);
				strictEqual(reader.run(id)?.total_tokens, 12, id);
				if (id === "partial") {
					strictEqual(reader.run(id)?.api_calls, 3);
					strictEqual(reader.run(id)?.missing_token_calls, 1);
					strictEqual(reader.run(id)?.cost_estimated, 1);
					strictEqual(reader.run(id)?.cost_unknown, 1);
				}
			} finally {
				reader.close();
			}
		}
	} finally {
		store.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});
