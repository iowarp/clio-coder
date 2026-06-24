import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";

describe("openai-completions thinking preservation", () => {
	it("replays a prior assistant thinking block as reasoning_content (no strip)", async () => {
		const model = {
			id: "qwen3.6-27b",
			name: "qwen3.6-27b",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			clio: { targetId: "local", runtimeId: "llamacpp", lifecycle: "user-managed" },
		} as unknown as Model<"openai-completions">;

		const context = {
			messages: [
				{ role: "user", content: "solve it", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret reasoning", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "the answer" },
					],
					api: "openai-completions",
					provider: "llamacpp",
					model: "qwen3.6-27b",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: "continue", timestamp: 0 },
			],
		} as unknown as Context;

		const controller = new AbortController();
		let captured: { messages?: Array<{ role?: string; reasoning_content?: string }> } | undefined;
		const getCaptured = () => captured;

		const stream = openAICompletionsApiProvider.stream(model, context, {
			apiKey: "fake-key",
			signal: controller.signal,
			onPayload: (payload) => {
				captured = payload as { messages?: Array<{ role?: string; reasoning_content?: string }> };
				controller.abort();
				return undefined;
			},
		});
		try {
			for await (const _event of stream) {
				// drain; the request aborts inside onPayload
			}
		} catch {
			// an aborted request may surface as an error/throw assertion
		}

		const result = getCaptured();
		ok(result?.messages, "onPayload should have captured the body");
		const assistant = result.messages.find((m) => m.role === "assistant");
		ok(assistant, "assistant message should survive in the replay history");
		strictEqual(assistant.reasoning_content, "secret reasoning");
	});

	it("suppresses chat_template_kwargs for strict gateways while keeping reasoning_effort", async () => {
		const model = {
			id: "gpt-oss-120b",
			name: "gpt-oss-120b",
			api: "openai-completions",
			provider: "alcf",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
			clio: {
				targetId: "alcf-metis",
				runtimeId: "alcf",
				lifecycle: "user-managed",
				chatTemplateKwargsUnsupported: true,
			},
		} as unknown as Model<"openai-completions">;

		const context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		} as unknown as Context;

		const controller = new AbortController();
		let captured: Record<string, unknown> | undefined;
		const stream = openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fake-key",
			reasoning: "medium",
			signal: controller.signal,
			onPayload: (payload) => {
				captured = payload as Record<string, unknown>;
				controller.abort();
				return undefined;
			},
		});
		try {
			for await (const _event of stream) {
				// drain; the request aborts inside onPayload
			}
		} catch {
			// an aborted request may surface as an error/throw assertion
		}

		ok(captured, "onPayload should have captured the body");
		strictEqual(captured.reasoning_effort, "medium");
		strictEqual(Object.hasOwn(captured, "chat_template_kwargs"), false);
	});
});
