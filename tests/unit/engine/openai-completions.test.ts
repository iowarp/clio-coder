import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	estimateInputTokensFromContext,
	openAICompletionsApiProvider,
} from "../../../src/engine/apis/openai-completions.js";

function asRecord(value: unknown): Record<string, unknown> {
	ok(value && typeof value === "object" && !Array.isArray(value), "expected a request body object");
	return value as Record<string, unknown>;
}

describe("engine/openai-completions", () => {
	it("clamps max_tokens to the remaining context budget", async () => {
		const model = {
			id: "nvidia/nemotron-3-super-120b-a12b:free",
			name: "nvidia/nemotron-3-super-120b-a12b:free",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 262144,
			compat: { maxTokensField: "max_tokens" },
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[1];

		let capturedPayload: unknown;
		const events = openAICompletionsApiProvider.stream(model, context, {
			apiKey: "sk-test",
			maxTokens: 262144,
			onPayload: (payload) => {
				capturedPayload = payload;
				throw new Error("captured request body");
			},
		});

		let errorMessage = "";
		for await (const event of events) {
			if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
		}

		strictEqual(errorMessage, "captured request body");
		const body = asRecord(capturedPayload);
		const maxTokens = body.max_tokens;
		if (typeof maxTokens !== "number") {
			throw new TypeError(`expected numeric max_tokens, got ${typeof maxTokens}`);
		}
		ok(maxTokens < 262144, `expected max_tokens to be clamped, got ${maxTokens}`);
		const promptTokens = estimateInputTokensFromContext(context);
		ok(promptTokens + maxTokens <= model.contextWindow, "prompt plus max_tokens must fit the context window");
	});
});
