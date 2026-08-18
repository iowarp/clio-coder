import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "../../src/domains/providers/types/capability-flags.js";
import { resetLlamaCppResidencyState } from "../../src/engine/apis/llamacpp-residency.js";
import {
	applyOpenAICompatReasoningEstimate,
	openAICompletionsApiProvider,
} from "../../src/engine/apis/openai-completions.js";

function usage(overrides: Record<string, unknown> = {}): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	} as AssistantMessage["usage"];
}

function thinkingMessage(messageUsage: AssistantMessage["usage"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "abcdefgh" }],
		api: "openai-completions",
		provider: "llamacpp",
		model: "qwen3.6-27b",
		usage: messageUsage,
		stopReason: "stop",
		timestamp: 0,
	};
}

function modelsPayload(entries: Array<{ id: string; state: string; tags?: string[] }>): unknown {
	return {
		data: entries.map((entry) => ({
			id: entry.id,
			object: "model",
			status: { value: entry.state },
			...(entry.tags ? { tags: entry.tags } : {}),
		})),
	};
}

function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("openai-completions thinking preservation", () => {
	it("keeps fallback reasoning usage estimates for local openai-compatible servers", () => {
		const message = thinkingMessage(usage());

		applyOpenAICompatReasoningEstimate(message);

		strictEqual((message.usage as { reasoningTokens?: number }).reasoningTokens, 2);
	});

	it("does not add fallback reasoning usage when upstream already reported it", () => {
		const cases: Array<[string, Record<string, unknown>, number | undefined]> = [
			["reasoning", { reasoning: 5 }, undefined],
			["reasoningTokens", { reasoningTokens: 6 }, 6],
			["reasoning_tokens", { reasoning_tokens: 7 }, undefined],
		];

		for (const [_label, overrides, expectedReasoningTokens] of cases) {
			const message = thinkingMessage(usage(overrides));

			applyOpenAICompatReasoningEstimate(message);

			strictEqual((message.usage as { reasoningTokens?: number }).reasoningTokens, expectedReasoningTokens);
		}
	});

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

	it("does not replay or request thinking for reasoning-never chat-template models", async () => {
		const model = {
			id: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
			name: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: "http://127.0.0.1:1/v1",
			// Simulates a live probe or gateway row that reports reasoning even
			// though the catalog quirks say this family is reasoning-never.
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				thinkingFormat: "qwen-chat-template",
			},
			clio: {
				targetId: "mini",
				runtimeId: "llamacpp",
				lifecycle: "user-managed",
				quirks: { thinking: { mechanism: "none" } },
			},
		} as unknown as Model<"openai-completions">;

		const context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "do not replay me", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "visible answer" },
					],
					api: "openai-completions",
					provider: "llamacpp",
					model: model.id,
					usage: usage(),
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: "continue", timestamp: 0 },
			],
		} as unknown as Context;

		const controller = new AbortController();
		let captured:
			| {
					messages?: Array<{ role?: string; reasoning_content?: string; content?: string }>;
					chat_template_kwargs?: Record<string, unknown>;
					enable_thinking?: boolean;
					reasoning?: unknown;
					reasoning_effort?: string;
					thinking?: unknown;
			  }
			| undefined;

		const stream = openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fake-key",
			reasoning: "low",
			signal: controller.signal,
			onPayload: (payload) => {
				captured = payload as typeof captured;
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

		ok(captured?.messages, "onPayload should have captured the body");
		const assistant = captured.messages.find((m) => m.role === "assistant");
		ok(assistant, "assistant message should survive in the replay history");
		strictEqual(assistant.reasoning_content, undefined);
		strictEqual(assistant.content, "visible answer");
		strictEqual(captured.chat_template_kwargs, undefined);
		strictEqual(captured.enable_thinking, undefined);
		strictEqual(captured.reasoning, undefined);
		strictEqual(captured.reasoning_effort, undefined);
		strictEqual(captured.thinking, undefined);
	});

	it("removes top-level reasoning objects for reasoning-never OpenRouter-format models", async () => {
		const model = {
			id: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
			name: "Qwopus3.6-35B-A3B-Coder-MTP-Q4_K_M-262K",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				thinkingFormat: "openrouter",
			},
			clio: {
				targetId: "mini-router",
				runtimeId: "openrouter",
				lifecycle: "user-managed",
				quirks: { thinking: { mechanism: "none" } },
			},
		} as unknown as Model<"openai-completions">;
		const context = { messages: [{ role: "user", content: "continue", timestamp: 0 }] } as unknown as Context;
		const controller = new AbortController();
		let captured: { reasoning?: unknown } | undefined;

		const stream = openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fake-key",
			reasoning: "low",
			signal: controller.signal,
			onPayload: (payload) => {
				captured = payload as typeof captured;
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
		strictEqual(captured.reasoning, undefined);
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

	it("maps every Clio thinking level to Qwen3.8-safe wire fields and sampling", async () => {
		const model = {
			id: "Qwen3.8-27B",
			name: "Qwen3.8-27B",
			api: "openai-completions",
			provider: "llamacpp",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				thinkingFormat: "qwen-chat-template",
			},
			clio: {
				targetId: "mini",
				runtimeId: "llamacpp",
				lifecycle: "user-managed",
				quirks: {
					thinking: {
						mechanism: "effort-levels",
						effortByLevel: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" },
					},
					sampling: {
						thinking: {
							temperature: 1,
							topP: 0.95,
							topK: 20,
							minP: 0,
							presencePenalty: 0,
							repeatPenalty: 1,
						},
						instruct: {
							temperature: 0.7,
							topP: 0.8,
							topK: 20,
							minP: 0,
							presencePenalty: 1.5,
							repeatPenalty: 1,
						},
					},
				},
			},
		} as unknown as Model<"openai-completions">;
		const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
		const cases: ReadonlyArray<{ level: ThinkingLevel; effort?: "low" | "medium" | "xhigh" }> = [
			{ level: "off" },
			{ level: "minimal", effort: "low" },
			{ level: "low", effort: "low" },
			{ level: "medium", effort: "medium" },
			{ level: "high", effort: "xhigh" },
			{ level: "xhigh", effort: "xhigh" },
			{ level: "max", effort: "xhigh" },
		];

		for (const expected of cases) {
			const controller = new AbortController();
			let captured: Record<string, unknown> | undefined;
			const stream = openAICompletionsApiProvider.streamSimple(model, context, {
				apiKey: "fake-key",
				...(expected.level === "off" ? {} : { reasoning: expected.level }),
				signal: controller.signal,
				onPayload: (payload) => {
					captured = payload as Record<string, unknown>;
					controller.abort();
					return undefined;
				},
			});
			try {
				for await (const _event of stream) {
					// Drain; the request aborts after the fully composed payload is captured.
				}
			} catch {
				// An aborted request may surface as an error/throw assertion.
			}

			ok(captured, `${expected.level} should reach onPayload`);
			strictEqual(captured.reasoning_effort, expected.effort, `${expected.level} reasoning_effort`);
			deepStrictEqual(
				captured.chat_template_kwargs,
				expected.level === "off"
					? { enable_thinking: false, preserve_thinking: true }
					: { enable_thinking: true, preserve_thinking: true },
				`${expected.level} chat_template_kwargs`,
			);
			const thinkingActive = expected.level !== "off";
			strictEqual(captured.temperature, thinkingActive ? 1 : 0.7, `${expected.level} temperature`);
			strictEqual(captured.top_p, thinkingActive ? 0.95 : 0.8, `${expected.level} top_p`);
			strictEqual(captured.top_k, 20, `${expected.level} top_k`);
			strictEqual(captured.min_p, 0, `${expected.level} min_p`);
			strictEqual(captured.presence_penalty, thinkingActive ? 0 : 1.5, `${expected.level} presence_penalty`);
			strictEqual(captured.repeat_penalty, 1, `${expected.level} repeat_penalty`);
		}
	});

	it("awaits llama.cpp router residency before constructing the chat payload", async () => {
		resetLlamaCppResidencyState();
		// The residency lock file lives in the state dir; point it at a scratch
		// dir so the contract test never writes outside the repo sandbox.
		const originalStateDir = process.env.CLIO_CODER_STATE_DIR;
		process.env.CLIO_CODER_STATE_DIR = mkdtempSync(join(tmpdir(), "clio-residency-test-"));
		const originalFetch = globalThis.fetch;
		const events: string[] = [];
		let modelPolls = 0;
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			events.push(`${method} ${href}`);
			if (href === "http://mini.test/v1/models") {
				modelPolls += 1;
				return jsonResponse(
					modelsPayload(
						modelPolls === 1
							? [
									{ id: "MiniCPM5-1B-Q8_0-131K", state: "loaded", tags: ["role:scout", "pinned:true"] },
									{ id: "old-code", state: "loaded", tags: ["role:code"] },
									{ id: "new-code", state: "unloaded", tags: ["role:code"] },
								]
							: [
									{ id: "MiniCPM5-1B-Q8_0-131K", state: "loaded", tags: ["role:scout", "pinned:true"] },
									{ id: "new-code", state: "loaded", tags: ["role:code"] },
								],
					),
				);
			}
			if (href === "http://mini.test/models/unload") return jsonResponse({ ok: true });
			if (href === "http://mini.test/models/load") return jsonResponse({ ok: true });
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		try {
			const model = {
				id: "new-code",
				name: "new-code",
				api: "openai-completions",
				provider: "llamacpp",
				baseUrl: "http://mini.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 4096,
				clio: {
					targetId: "mini",
					runtimeId: "llamacpp",
					lifecycle: "clio-managed",
					quirks: { thinking: { mechanism: "none" } },
				},
			} as unknown as Model<"openai-completions">;
			const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
			const controller = new AbortController();
			const stream = openAICompletionsApiProvider.streamSimple(model, context, {
				apiKey: "fake-key",
				signal: controller.signal,
				onPayload: () => {
					events.push("payload");
					controller.abort();
					return undefined;
				},
			});
			try {
				for await (const _event of stream) {
					// Drain; aborting inside onPayload can surface as a stream error.
				}
			} catch {
				// Expected on some undici/AbortSignal paths after payload capture.
			}

			const unloadIndex = events.indexOf("POST http://mini.test/models/unload");
			const loadIndex = events.indexOf("POST http://mini.test/models/load");
			const payloadIndex = events.indexOf("payload");
			ok(unloadIndex >= 0, events.join("\n"));
			ok(loadIndex > unloadIndex, events.join("\n"));
			ok(payloadIndex > loadIndex, events.join("\n"));
		} finally {
			globalThis.fetch = originalFetch;
			if (originalStateDir === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = originalStateDir;
			resetLlamaCppResidencyState();
		}
	});
});
