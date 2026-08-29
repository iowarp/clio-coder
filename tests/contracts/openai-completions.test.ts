import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { uncachedPrefillTokens } from "../../src/core/cache-telemetry.js";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ThinkingLevel } from "../../src/domains/providers/types/capability-flags.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import { resetLlamaCppResidencyState } from "../../src/engine/apis/llamacpp-residency.js";
import {
	applyOpenAICompatReasoningEstimate,
	openAICompletionsApiProvider,
} from "../../src/engine/apis/openai-completions.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnContext } from "../../src/interactive/turn-context.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnState } from "../../src/interactive/turn-state.js";

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

function thinkingMessage(messageUsage: AssistantMessage["usage"], thinking = "abcdefgh"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
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

function llamaCppCaptureModel(): Model<"openai-completions"> {
	return {
		id: "qwen3.8-27b-dense",
		name: "qwen3.8-27b-dense",
		api: "openai-completions",
		provider: "llamacpp",
		baseUrl: "http://mini.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 4096,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		},
		clio: { targetId: "mini", runtimeId: "llamacpp", lifecycle: "user-managed" },
	} as unknown as Model<"openai-completions">;
}

function completionSseResponse(events: ReadonlyArray<Record<string, unknown>>): Response {
	const body = [...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function finalCompletionEvent(timings?: Record<string, unknown>): Record<string, unknown> {
	return {
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 59, completion_tokens: 2, total_tokens: 61 },
		...(timings === undefined ? {} : { timings }),
	};
}

async function capturedLlamaCppCompletion(events: ReadonlyArray<Record<string, unknown>>): Promise<{
	message: AssistantMessage;
	requestPayload: Record<string, unknown>;
}> {
	const streamed: AssistantMessageEvent[] = [];
	let requestPayload: Record<string, unknown> | undefined;
	const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
	for await (const event of openAICompletionsApiProvider.streamSimple(llamaCppCaptureModel(), context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
				requestPayload = payload as Record<string, unknown>;
			}
			return undefined;
		},
		fetch: async () => completionSseResponse(events),
	})) {
		streamed.push(event);
	}
	const done = streamed.find((event) => event.type === "done");
	ok(done && done.type === "done", "expected a completed fake llama.cpp stream");
	ok(requestPayload, "expected pi-ai to expose the request payload");
	return { message: done.message, requestPayload };
}

async function persistedLlamaCppPromptCache(timings?: Record<string, unknown>): Promise<Record<string, unknown>> {
	const { message } = await capturedLlamaCppCompletion([
		{ model: "qwen3.8-27b-dense", choices: [{ index: 0, delta: { content: "hello" } }] },
		finalCompletionEvent(timings),
	]);
	const appended: TurnInput[] = [];
	const session = {
		current: () => ({ id: "cache-contract-session" }),
		append: (turn: TurnInput) => {
			appended.push(turn);
			return { ...turn, id: `turn-${appended.length}`, at: "2026-08-29T00:00:00.000Z" };
		},
	} as unknown as SessionContract;
	const state = createTurnState("off");
	const context = createTurnContext({
		state,
		getSettings: () => DEFAULT_SETTINGS as ClioSettings,
		providers: { getRuntime: () => ({ tier: "local-native" }) } as never,
		middleware: {} as never,
		emitNotice: () => {},
	});
	const persistence = createTurnPersistence({
		state,
		session,
		getSettings: () => DEFAULT_SETTINGS as ClioSettings,
		middlewareToolChoice: { reset: () => {} } as never,
		consumePersistedEcho: () => false,
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: (messageUsage, backend) =>
			context.promptCachePayloadForAssistant(messageUsage, backend),
		promptSideTokens: () => 0,
	});
	try {
		persistence.appendAssistantTurn(message as unknown as AgentMessage);
		strictEqual(appended.length, 1, "the captured completion should persist one assistant turn");
		const payload = appended[0]?.payload as { promptCache?: unknown };
		ok(
			payload.promptCache !== null && typeof payload.promptCache === "object" && !Array.isArray(payload.promptCache),
			"the persisted assistant should carry prompt-cache telemetry",
		);
		return payload.promptCache as Record<string, unknown>;
	} finally {
		context.dispose();
	}
}

describe("openai-completions backend timing capture", () => {
	it("captures final llama.cpp timings after an earlier response model id", async () => {
		const { message, requestPayload } = await capturedLlamaCppCompletion([
			{
				model: "qwen3.8-27b-dense:served",
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }],
			},
			finalCompletionEvent({
				prompt_n: 4,
				cache_n: 55,
				predicted_n: 2,
				prompt_ms: 12.5,
				predicted_ms: 21.25,
			}),
		]);

		deepStrictEqual(message.responseModelIdObservation, {
			state: "reported",
			reportedModelId: "qwen3.8-27b-dense:served",
		});
		deepStrictEqual(message.backendTimings, {
			promptTokens: 59,
			cachedTokens: 55,
			predictedTokens: 2,
			promptMs: 12.5,
			predictedMs: 21.25,
			source: "llamacpp-timings",
		});
		strictEqual(uncachedPrefillTokens(message.backendTimings), 4);
		strictEqual(Object.hasOwn(requestPayload, "timings_per_token"), false);
	});

	it("marks cache reads unknown when llama.cpp timings omit cache_n", async () => {
		const { message } = await capturedLlamaCppCompletion([
			{ model: "qwen3.8-27b-dense", choices: [{ index: 0, delta: { content: "hello" } }] },
			finalCompletionEvent({
				prompt_n: 59,
				predicted_n: 2,
				prompt_ms: 50,
				predicted_ms: 20,
			}),
		]);

		deepStrictEqual(message.backendTimings, {
			promptTokens: 59,
			cachedTokens: null,
			predictedTokens: 2,
			promptMs: 50,
			predictedMs: 20,
			source: "llamacpp-timings",
		});
		strictEqual(uncachedPrefillTokens(message.backendTimings), null);
	});

	it("leaves the assistant message shape unchanged when timings are absent", async () => {
		const { message } = await capturedLlamaCppCompletion([
			{ model: "qwen3.8-27b-dense", choices: [{ index: 0, delta: { content: "hello" } }] },
			finalCompletionEvent(),
		]);

		strictEqual(Object.hasOwn(message, "backendTimings"), false);
	});

	it("keeps the last cumulative timing object from the stream", async () => {
		const { message } = await capturedLlamaCppCompletion([
			{
				model: "qwen3.8-27b-dense",
				choices: [{ index: 0, delta: { content: "hello" } }],
				timings: { prompt_n: 1, cache_n: 2, predicted_n: 1, prompt_ms: 3, predicted_ms: 4 },
			},
			finalCompletionEvent({
				prompt_n: 4,
				cache_n: 55,
				predicted_n: 2,
				prompt_ms: 12.5,
				predicted_ms: 21.25,
			}),
		]);

		strictEqual(message.backendTimings?.promptTokens, 59);
		strictEqual(message.backendTimings?.cachedTokens, 55);
	});

	it("rejects impossible uncached-prefill operands", () => {
		strictEqual(
			uncachedPrefillTokens({
				promptTokens: 4,
				cachedTokens: 5,
				predictedTokens: 1,
				promptMs: 1,
				predictedMs: 1,
				source: "llamacpp-timings",
			}),
			null,
		);
	});

	it("persists backend timings and backend-derived cold, hot, and partial verdicts", async () => {
		const cases = [
			{
				label: "cold",
				timings: { prompt_n: 5_000, cache_n: 0, predicted_n: 2, prompt_ms: 50, predicted_ms: 20 },
				backend: {
					promptTokens: 5_000,
					cachedTokens: 0,
					predictedTokens: 2,
					promptMs: 50,
					predictedMs: 20,
					source: "llamacpp-timings",
				},
			},
			{
				label: "hot",
				timings: { prompt_n: 1_000, cache_n: 1_000, predicted_n: 2, prompt_ms: 10, predicted_ms: 20 },
				backend: {
					promptTokens: 2_000,
					cachedTokens: 1_000,
					predictedTokens: 2,
					promptMs: 10,
					predictedMs: 20,
					source: "llamacpp-timings",
				},
			},
			{
				label: "partial",
				timings: { prompt_n: 2_500, cache_n: 7_500, predicted_n: 2, prompt_ms: 30, predicted_ms: 20 },
				backend: {
					promptTokens: 10_000,
					cachedTokens: 7_500,
					predictedTokens: 2,
					promptMs: 30,
					predictedMs: 20,
					source: "llamacpp-timings",
				},
			},
		] as const;

		for (const expected of cases) {
			const promptCache = await persistedLlamaCppPromptCache(expected.timings);
			deepStrictEqual(
				promptCache,
				{
					input: 59,
					cacheRead: 0,
					cacheWrite: 0,
					backendVerdict: expected.label,
					backend: expected.backend,
				},
				`${expected.label} should use the serving backend's cache observation`,
			);
		}
	});

	it("persists the exact legacy prompt-cache shape when SSE timings are absent", async () => {
		const promptCache = await persistedLlamaCppPromptCache();

		deepStrictEqual(promptCache, {
			input: 59,
			cacheRead: 0,
			cacheWrite: 0,
			backendVerdict: "small",
		});
		strictEqual(Object.hasOwn(promptCache, "backend"), false);
	});
});

describe("openai-completions thinking preservation", () => {
	it("accepts local streams that omit finish_reason through pi's compatibility flag", async () => {
		const model = {
			id: "local-no-finish-reason",
			name: "local-no-finish-reason",
			api: "openai-completions",
			provider: "openai-compat",
			baseUrl: "http://local.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				supportsFinishReason: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
			},
			clio: { targetId: "local", runtimeId: "openai-compat" },
		} as unknown as Model<"openai-completions">;
		const responseBody = ['data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}', "", "data: [DONE]", ""].join(
			"\n",
		);
		const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
		const events: AssistantMessageEvent[] = [];

		for await (const event of openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "fake-key",
			fetch: async () =>
				new Response(responseBody, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		})) {
			events.push(event);
		}

		const done = events.find((event) => event.type === "done");
		ok(done && done.type === "done", "pi should infer a completed local stream");
		strictEqual(done.reason, "stop");
		deepStrictEqual(done.message.content, [{ type: "text", text: "hello" }]);
	});

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

	it("bounds fallback reasoning usage by the reported completion count", () => {
		const message = thinkingMessage(usage({ output: 40 }), "x".repeat(900));
		applyOpenAICompatReasoningEstimate(message);
		strictEqual((message.usage as { reasoningTokens?: number }).reasoningTokens, 40);

		const empty = thinkingMessage(usage({ output: 0 }), "reasoning without reported completion tokens");
		applyOpenAICompatReasoningEstimate(empty);
		strictEqual((empty.usage as { reasoningTokens?: number }).reasoningTokens, undefined);
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
				samplingParams: { seed: 17 },
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
			strictEqual(captured.seed, 17, `${expected.level} arbitrary pi sampling parameter`);
		}
	});

	it("uses pi's vLLM thinking budget while preserving room for the answer", async () => {
		const model = {
			id: "AgenticQwen-14B",
			name: "AgenticQwen-14B",
			api: "openai-completions",
			provider: "vllm",
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
				supportsThinkingTokenBudget: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				thinkingFormat: "qwen-chat-template",
			},
			clio: {
				targetId: "gpu",
				runtimeId: "vllm",
				quirks: {
					thinking: {
						mechanism: "budget-tokens",
						budgetByLevel: { low: 1024, medium: 4096, high: 16384 },
					},
				},
			},
		} as unknown as Model<"openai-completions">;
		const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
		const cases = [
			{ reasoning: "low", expectedBudget: 1024 },
			{ reasoning: "medium", expectedBudget: 4096 },
			{ reasoning: "high", expectedBudget: 16384 },
			{ reasoning: "xhigh", expectedBudget: 16384 },
		] as const;

		for (const expected of cases) {
			const controller = new AbortController();
			let captured: Record<string, unknown> | undefined;
			const stream = openAICompletionsApiProvider.streamSimple(model, context, {
				apiKey: "fake-key",
				maxTokens: 32768,
				reasoning: expected.reasoning,
				signal: controller.signal,
				onPayload: (payload) => {
					captured = payload as Record<string, unknown>;
					controller.abort();
					return undefined;
				},
			});
			try {
				for await (const _event of stream) {
					// Drain; the request aborts after pi has built the payload.
				}
			} catch {
				// An aborted request may surface as an error/throw assertion.
			}

			ok(captured, `${expected.reasoning} should reach onPayload`);
			strictEqual(captured.thinking_token_budget, expected.expectedBudget);
			strictEqual(captured.thinking, undefined, "vLLM uses pi's top-level budget instead of a vendor object");
			strictEqual(captured.max_tokens, 32768, "the shared ceiling retains answer headroom beyond the budget");
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
