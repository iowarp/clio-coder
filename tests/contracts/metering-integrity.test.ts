import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ledgerUsageCalls, type SessionEntry } from "../../src/domains/session/index.js";
import type { AgentMessage } from "../../src/engine/types.js";
import {
	remainingContextMaxTokens,
	setGlobalDefaultMaxOutputTokens,
} from "../../src/engine/apis/output-budget.js";
import { estimatedUsageForInterruptedTurn } from "../../src/interactive/chat-loop-messages.js";
import { reseedSessionUsageFromLedger } from "../../src/interactive/session-usage-reseed.js";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	id: string,
	stopReason: "stop" | "aborted",
	usage: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId: id,
		parentTurnId: null,
		timestamp: "2026-08-31T12:00:00.000Z",
		payload: {
			text: stopReason === "aborted" ? "partial output" : "done",
			stopReason,
			usage,
			...extra,
		},
	} as unknown as SessionEntry;
}

describe("contracts/metering integrity", () => {
	afterEach(() => setGlobalDefaultMaxOutputTokens(0));

	it("attributes provider usage to the target and the model that answered", () => {
		const [call] = ledgerUsageCalls(
			[
				assistant("a1", "stop", {
					input: 120,
					output: 30,
					cacheRead: 80,
					cacheWrite: 5,
					totalTokens: 235,
					cost: { total: 0.25 },
				}, { provider: "llamacpp", model: "requested-model", responseModel: "answering-model" }),
			],
			{ target: "local-cluster", model: "requested-model" },
		);

		strictEqual(call?.providerId, "local-cluster");
		strictEqual(call?.requestedModelId, "requested-model");
		strictEqual(call?.attributedModelId, "answering-model");
		strictEqual(call?.totalTokens, 235);
		strictEqual(call?.cacheRead, 80);
		strictEqual(call?.costUsd, 0.25);
	});

	it("estimates spent prompt and streamed output when cancellation prevents final usage", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "streamed result ".repeat(80) }],
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
			timestamp: Date.now(),
			usage: zeroUsage,
		} as unknown as AgentMessage;
		const corrected = estimatedUsageForInterruptedTurn(message, 9_658);

		ok(corrected);
		strictEqual(corrected.input, 9_658);
		ok(corrected.output > 0);
		strictEqual(corrected.totalTokens, corrected.input + corrected.output);
		strictEqual(corrected.estimated, true);
		strictEqual(estimatedUsageForInterruptedTurn({ ...message, stopReason: "stop" } as AgentMessage, 9_658), null);
	});

	it("honors explicit output budgets and the effective served-window boundary", () => {
		type Model = Parameters<typeof remainingContextMaxTokens>[0];
		type Context = Parameters<typeof remainingContextMaxTokens>[1];
		setGlobalDefaultMaxOutputTokens(32_768);
		const model = { contextWindow: 131_072, maxTokens: 131_072 } as Model;
		const empty = { systemPrompt: "", messages: [], tools: [] } as unknown as Context;
		const loaded = { systemPrompt: "x".repeat(480_000), messages: [], tools: [] } as unknown as Context;

		strictEqual(remainingContextMaxTokens(model, empty, { maxTokens: 4_096 }), 4_096);
		strictEqual(remainingContextMaxTokens(model, loaded, undefined), 10_048);
	});

	it("resets process totals and reseeds only completed calls from the resumed ledger", () => {
		let resets = 0;
		const recorded: Array<{ provider: string; model: string; tokens: number }> = [];
		const completed = {
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { total: 0.1 },
		};
		reseedSessionUsageFromLedger(
			{
				resetSession: () => {
					resets += 1;
				},
				recordTokens: (provider, model, tokens) => recorded.push({ provider, model, tokens }),
			},
			[
				assistant("aborted", "aborted", completed, { provider: "llamacpp", responseModel: "model-a" }),
				assistant("complete", "stop", completed, { provider: "llamacpp", responseModel: "model-a" }),
			],
			{ target: "local-cluster", model: "model-a" },
		);

		strictEqual(resets, 1);
		deepStrictEqual(recorded, [{ provider: "local-cluster", model: "model-a", tokens: 150 }]);
	});
});
