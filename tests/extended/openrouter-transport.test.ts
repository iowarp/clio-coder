import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { getCatalogModelForRuntime } from "../../src/domains/providers/catalog.js";
import openrouter from "../../src/domains/providers/runtimes/cloud/openrouter.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { streamSimple } from "../../src/engine/ai.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";

registerClioApiProviders();

function response(anthropic: boolean): Response {
	const events = anthropic
		? [
				{
					type: "message_start",
					message: {
						id: "fixture",
						type: "message",
						role: "assistant",
						model: "fixture",
						content: [],
						usage: { input_tokens: 1, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wire-ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]
		: [
				{ choices: [{ index: 0, delta: { content: "wire-ok" } }] },
				{
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
			];
	const body = events
		.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body + (anthropic ? "" : "data: [DONE]\n\n"), {
		headers: { "content-type": "text/event-stream" },
	});
}

const cases = [
	{
		name: "catalog Anthropic transport",
		id: "anthropic/claude-fable-5.1",
		api: "anthropic-messages",
		base: "https://openrouter.ai/api",
		path: "/v1/messages",
	},
	{
		name: "catalog OpenAI transport",
		id: "openai/gpt-4o",
		api: "openai-completions",
		base: "https://openrouter.ai/api/v1",
		path: "/chat/completions",
	},
	{
		name: "unknown model default",
		id: "fixture/unknown-model",
		api: "openai-completions",
		base: "https://openrouter.ai/api/v1",
		path: "/chat/completions",
	},
	{
		name: "explicit standard URL for a Claude model",
		id: "anthropic/claude-fable-5.1",
		url: "https://openrouter.ai/api/v1",
		api: "openai-completions",
		base: "https://openrouter.ai/api/v1",
		path: "/chat/completions",
	},
	{
		name: "custom endpoint for a Claude model",
		id: "anthropic/claude-fable-5.1",
		url: "https://gateway.invalid/router/v1/",
		api: "openai-completions",
		base: "https://gateway.invalid/router/v1/",
		path: "chat/completions",
	},
	{
		name: "custom endpoint for an OpenAI model",
		id: "openai/gpt-4o",
		url: "https://gateway.invalid/v1",
		api: "openai-completions",
		base: "https://gateway.invalid/v1",
		path: "/chat/completions",
	},
	{
		name: "custom endpoint for an unknown model",
		id: "fixture/unknown-model",
		url: "https://gateway.invalid/v1",
		api: "openai-completions",
		base: "https://gateway.invalid/v1",
		path: "/chat/completions",
	},
] as const;

describe("OpenRouter catalog transport", () => {
	for (const fixture of cases) {
		it(`constructs and dispatches the ${fixture.name} request`, async () => {
			const target: TargetDescriptor = {
				id: "router",
				runtime: "openrouter",
				...("url" in fixture ? { url: fixture.url } : {}),
				auth: { headers: { "X-Contract": "transport", "X-OpenRouter-Title": "Contract title" } },
				capabilities: { contextWindow: 123456 },
				pricing: { input: 2, output: 3 },
			};
			const model = openrouter.synthesizeModel(target, fixture.id, null);
			const catalog = getCatalogModelForRuntime("openrouter", fixture.id);
			strictEqual(model.api, fixture.api);
			strictEqual(model.baseUrl, fixture.base);
			strictEqual(model.contextWindow, 123456);
			strictEqual(model.cost.input, 2);
			strictEqual(model.cost.output, 3);
			if (catalog && catalog.api === model.api) {
				deepStrictEqual(model.compat, catalog.compat);
				deepStrictEqual(model.thinkingLevelMap, catalog.thinkingLevelMap);
			} else {
				strictEqual(model.compat, undefined, "another API's compatibility flags must not leak");
				strictEqual(model.thinkingLevelMap, undefined, "another API's native effort map must not leak");
			}
			let calls = 0;
			let payload: Record<string, unknown> | undefined;
			const result = await streamSimple(
				model,
				{
					systemPrompt: "System fixture",
					messages: [{ role: "user", content: "Hello", timestamp: 0 }],
				},
				{
					apiKey: "fixture-key",
					maxTokens: 128,
					...(model.reasoning ? { reasoning: "high" as const } : {}),
					fetch: async (input, init) => {
						calls += 1;
						const request = new Request(input, init);
						strictEqual(request.url.split("?")[0], fixture.base + fixture.path);
						strictEqual(request.headers.get("x-contract"), "transport");
						strictEqual(request.headers.get("x-openrouter-title"), "Contract title");
						strictEqual(request.headers.get("http-referer"), "https://github.com/iowarp/clio-coder");
						payload = (await request.json()) as Record<string, unknown>;
						return response(fixture.api === "anthropic-messages");
					},
				},
			).result();
			strictEqual(calls, 1, result.errorMessage);
			strictEqual(result.stopReason, "stop", result.errorMessage);
			deepStrictEqual(result.content, [{ type: "text", text: "wire-ok" }]);
			ok(payload);
			strictEqual(payload.model, fixture.id);
			ok(Array.isArray(payload.messages));
			if (fixture.api === "anthropic-messages") {
				ok(Array.isArray(payload.system));
				deepStrictEqual(payload.thinking, {
					type: "adaptive",
					display: "summarized",
					block_binding: { prefix_mismatch_behavior: "drop_block" },
				});
				strictEqual(result.providerThinkingLevel, "high");
			} else {
				strictEqual(payload.system, undefined);
				strictEqual(payload.thinking, undefined);
				strictEqual(result.api, "openai-completions");
			}
		});
	}
});
