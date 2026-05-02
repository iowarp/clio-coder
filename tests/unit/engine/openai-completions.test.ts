import { ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { Type } from "typebox";

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

	it("does not let an explicit request exceed the model output cap", async () => {
		const model = {
			id: "nvidia-nemotron-3-nano-omni-30b-a3b-reasoning",
			name: "nvidia-nemotron-3-nano-omni-30b-a3b-reasoning",
			api: "openai-completions",
			provider: "lmstudio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 20480,
			compat: { maxTokensField: "max_tokens" },
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[1];

		let capturedPayload: unknown;
		const events = openAICompletionsApiProvider.stream(model, context, {
			apiKey: "sk-test",
			maxTokens: 131072,
			onPayload: (payload) => {
				capturedPayload = payload;
				throw new Error("captured request body");
			},
		});

		for await (const _event of events) {
			// The onPayload hook intentionally aborts before network I/O.
		}

		const body = asRecord(capturedPayload);
		strictEqual(body.max_tokens, 20480);
	});

	it("turns empty required tool arguments into a target-specific error", async () => {
		let server: Server | null = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "write", arguments: "" },
									},
								],
							},
						},
					],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as AddressInfo;
		const model: Parameters<typeof openAICompletionsApiProvider.stream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "user-managed" };
		} = {
			id: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
			name: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: `http://127.0.0.1:${addr.port}/v1`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
			clio: { targetId: "mini", runtimeId: "llamacpp", lifecycle: "user-managed" },
		};
		const context = {
			messages: [{ role: "user", content: "write a file", timestamp: 1 }],
			tools: [
				{
					name: "write",
					description: "Write a file",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				},
			],
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[1];

		try {
			const events = openAICompletionsApiProvider.stream(model, context, { apiKey: "sk-test" });
			let errorMessage = "";
			for await (const event of events) {
				if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
			}

			ok(errorMessage.includes("target 'mini'"), errorMessage);
			ok(errorMessage.includes("model 'Qwen3.6-35B-A3B-UD-Q4_K_XL'"), errorMessage);
			ok(errorMessage.includes("Required fields: path, content"), errorMessage);
			ok(errorMessage.includes("verify --jinja"), errorMessage);
		} finally {
			await new Promise<void>((resolve) => {
				const active = server;
				server = null;
				active?.close(() => resolve());
			});
		}
	});

	it("estimates reasoningTokens from streamed reasoning_content for openai-compat", async () => {
		const reasoningChunk =
			"Okay, let me think about this carefully. The user wants 17 times 23. " +
			"I can split that as (10 + 7) * 23 = 230 + 161 = 391. Final answer is 391.";
		let server: Server | null = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
					choices: [{ index: 0, delta: { reasoning_content: reasoningChunk } }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
					choices: [{ index: 0, delta: { content: "391" } }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 8, completion_tokens: 60, total_tokens: 68 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as AddressInfo;
		const model = {
			id: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
			name: "Qwen3-VL-30B-A3B-Thinking-UD-Q5_K_XL",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: `http://127.0.0.1:${addr.port}/v1`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 32768,
			compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
		const context = {
			messages: [{ role: "user", content: "what is 17 times 23?", timestamp: 1 }],
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[1];

		try {
			const events = openAICompletionsApiProvider.stream(model, context, { apiKey: "sk-test" });
			let doneUsage: { reasoningTokens?: number; output?: number } | undefined;
			for await (const event of events) {
				if (event.type === "done") {
					doneUsage = event.message.usage as { reasoningTokens?: number; output?: number };
				}
			}

			ok(doneUsage, "expected a done event with usage");
			const expected = Math.max(1, Math.round(reasoningChunk.length / 4));
			strictEqual(doneUsage?.reasoningTokens, expected);
			strictEqual(doneUsage?.output, 60);
		} finally {
			await new Promise<void>((resolve) => {
				const active = server;
				server = null;
				active?.close(() => resolve());
			});
		}
	});

	it("leaves reasoningTokens absent when no reasoning content was streamed", async () => {
		let server: Server | null = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "non-thinking-model",
					choices: [{ index: 0, delta: { content: "Hello there." } }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "non-thinking-model",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as AddressInfo;
		const model = {
			id: "non-thinking-model",
			name: "non-thinking-model",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: `http://127.0.0.1:${addr.port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
			compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[1];

		try {
			const events = openAICompletionsApiProvider.stream(model, context, { apiKey: "sk-test" });
			let doneUsage: { reasoningTokens?: number } | undefined;
			for await (const event of events) {
				if (event.type === "done") doneUsage = event.message.usage as { reasoningTokens?: number };
			}
			strictEqual(doneUsage?.reasoningTokens, undefined);
		} finally {
			await new Promise<void>((resolve) => {
				const active = server;
				server = null;
				active?.close(() => resolve());
			});
		}
	});
});
