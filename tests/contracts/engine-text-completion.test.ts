import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { completeEngineText } from "../../src/engine/ai.js";
import type { EngineModel } from "../../src/engine/types.js";

describe("contracts/engine text completion", () => {
	it("keeps one-shot prompt assembly and pi types behind the engine boundary", async () => {
		const faux = registerFauxProvider({
			api: "memory-completion-test",
			provider: "memory-completion-test",
			models: [{ id: "small-memory-model", reasoning: true }],
			tokensPerSecond: 0,
		});
		try {
			faux.setResponses([
				(context, options) => {
					strictEqual(context.systemPrompt, "memory system");
					strictEqual(context.messages.length, 1);
					strictEqual(context.messages[0]?.role, "user");
					strictEqual(context.messages[0]?.content, "memory input");
					strictEqual(options?.maxTokens, 1200);
					strictEqual(options?.apiKey, "local-placeholder");
					return fauxAssistantMessage("<operations>[]</operations>\n<no_intervention/>");
				},
			]);
			const result = await completeEngineText({
				model: faux.getModel() as EngineModel,
				systemPrompt: "memory system",
				userPrompt: "memory input",
				maxTokens: 1200,
				thinkingLevel: "off",
				signal: new AbortController().signal,
				timeoutMs: 1000,
				apiKey: "local-placeholder",
			});

			strictEqual(result.text, "<operations>[]</operations>\n<no_intervention/>");
			deepStrictEqual(Object.keys(result).sort(), ["inputTokens", "outputTokens", "text"]);
		} finally {
			faux.unregister();
		}
	});

	it("rejects provider error and aborted terminal messages", async () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const faux = registerFauxProvider({
				api: `memory-completion-${stopReason}`,
				provider: `memory-completion-${stopReason}`,
				models: [{ id: `memory-${stopReason}` }],
				tokensPerSecond: 0,
			});
			try {
				faux.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "isolated failure" })]);
				await rejects(
					completeEngineText({
						model: faux.getModel() as EngineModel,
						systemPrompt: "system",
						userPrompt: "user",
						maxTokens: 50,
						thinkingLevel: "off",
						signal: new AbortController().signal,
						timeoutMs: 1000,
					}),
					/isolated failure/u,
				);
			} finally {
				faux.unregister();
			}
		}
	});
});
