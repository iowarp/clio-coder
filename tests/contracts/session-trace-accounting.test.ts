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
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import type { AgentRuntime, ChatTurnState } from "../../src/interactive/turn-state.js";

it("session traces retain tokens but withhold an unpriced total, including mixed-price turns", () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-session-trace-cost-"));
	const path = join(scratch, "trace.sqlite");
	const store = new TraceStore(path);
	try {
		for (const [id, prices, expected] of [
			["unknown", ["unknown"], null],
			["free", ["known_free"], 0],
			["priced", ["known", "known"], 0.5],
			["mixed", ["known", "unknown", "known"], null],
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
						totalTokens: 12,
						cost: { total: provenance === "known" ? 0.25 : 0 },
					},
				} as AgentMessage);
			}
			const reader = new TraceReader(path);
			try {
				const runId = `session:${userTurn}`;
				strictEqual(reader.run(runId)?.total_cost_usd, expected, id);
				strictEqual(reader.phases(runId)[0]?.total_cost_usd, expected, id);
				strictEqual(reader.run(runId)?.total_tokens, prices.length * 12, id);
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
				} as DispatchCompletedPayload,
				true,
			);
			const reader = new TraceReader(path);
			try {
				strictEqual(reader.run(id)?.total_cost_usd, expected, id);
				strictEqual(reader.phases(id)[0]?.total_cost_usd, expected, id);
				strictEqual(reader.run(id)?.total_tokens, 12, id);
			} finally {
				reader.close();
			}
		}
	} finally {
		store.close();
		rmSync(scratch, { recursive: true, force: true });
	}
});
