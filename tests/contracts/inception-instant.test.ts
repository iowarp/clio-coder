import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { resolveModelRuntimeCapabilitiesForModel } from "../../src/domains/providers/model-runtime-capabilities.js";
import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";

it("Mercury retains instant in probe and chat payloads with discovered nonreasoning capabilities", async () => {
	const model = inceptionRuntime.synthesizeModel(
		{ id: "inception", runtime: "inception" },
		"mercury-2.5",
		null,
	) as Model<"openai-completions">;
	model.reasoning = false;
	strictEqual(resolveModelRuntimeCapabilitiesForModel(model).thinking.mechanism, "none");
	for (const maxTokens of [256, 65536]) {
		let body: Record<string, unknown> = {};
		const context: Parameters<typeof openAICompletionsApiProvider.streamSimple>[1] = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		};
		const stream = openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fixture",
			maxTokens,
			fetch: async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		for await (const _event of stream) {
		}
		strictEqual(body.reasoning_effort, "instant");
	}
});
