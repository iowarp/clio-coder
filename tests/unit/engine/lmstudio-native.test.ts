import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { Type } from "typebox";

import { runStream } from "../../../src/engine/apis/lmstudio-native.js";

describe("engine/lmstudio-native runStream", () => {
	it("surfaces empty SDK tool arguments as a clear runtime error", async () => {
		const model = {
			id: "nemotron-nano-omni",
			name: "nemotron-nano-omni",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "write a file", timestamp: 1 }],
			tools: [
				{
					name: "write",
					description: "Write a file",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				},
			],
		} satisfies Parameters<typeof runStream>[1];
		const deps: NonNullable<Parameters<typeof runStream>[3]> = {
			createClient: () => ({
				files: {
					prepareImageBase64: async () => {
						throw new Error("unexpected image input");
					},
				},
				llm: {
					listLoaded: async () => [],
					model: async () => ({
						respond: (_history, opts) => {
							opts.onPredictionFragment?.({
								content: "reasoning before the tool call",
								tokensCount: 7,
								containsDrafted: false,
								reasoningType: "reasoning",
								isStructural: false,
							});
							opts.onToolCallRequestStart?.(1, {});
							opts.onToolCallRequestEnd?.(1, {
								toolCallRequest: { type: "function", name: "write" },
								rawContent: undefined,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 2,
										predictedTokensCount: 24000,
										totalTokensCount: 24002,
										stopReason: "toolCalls",
									},
								}),
							};
						},
					}),
				},
			}),
			ensureResident: async () => {},
		};

		const events = runStream(model, context, undefined, deps);
		let toolCallStartCount = 0;
		let toolCallEndCount = 0;
		let errorMessage = "";
		for await (const event of events) {
			if (event.type === "toolcall_start") toolCallStartCount += 1;
			if (event.type === "toolcall_end") toolCallEndCount += 1;
			if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
		}

		strictEqual(toolCallStartCount, 1);
		strictEqual(toolCallEndCount, 0);
		match(errorMessage, /LM Studio SDK returned empty tool-call arguments/);
		match(errorMessage, /openai-compat runtime/);
	});
});
