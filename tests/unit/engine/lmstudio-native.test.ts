import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { LLMLoadModelConfig } from "@lmstudio/sdk";
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
		let capturedLoadConfig: LLMLoadModelConfig | undefined;
		let capturedMaxTokens: number | false | undefined;
		const deps: NonNullable<Parameters<typeof runStream>[3]> = {
			createClient: () => ({
				files: {
					prepareImageBase64: async () => {
						throw new Error("unexpected image input");
					},
				},
				llm: {
					listLoaded: async () => [],
					model: async (_modelId, opts) => {
						capturedLoadConfig = opts.config;
						return {
							respond: (_history, opts) => {
								capturedMaxTokens = opts.maxTokens;
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
						};
					},
				},
			}),
			ensureResident: async () => {},
			discoverLoadedContext: async () => undefined,
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
		strictEqual(capturedMaxTokens, 65536);
		strictEqual(capturedLoadConfig?.contextLength, 131072);
		strictEqual(capturedLoadConfig?.gpuStrictVramCap, true);
		strictEqual(capturedLoadConfig?.offloadKVCacheToGpu, true);
		match(errorMessage, /LM Studio SDK returned empty tool-call arguments/);
		match(errorMessage, /openai-compat runtime/);
	});

	it("clamps SDK maxTokens to the remaining context budget", async () => {
		const model = {
			id: "oversized-local",
			name: "oversized-local",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 2048,
			maxTokens: 262144,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof runStream>[1];
		let capturedMaxTokens: number | false | undefined;
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
							capturedMaxTokens = opts.maxTokens;
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 1,
										predictedTokensCount: 2,
										totalTokensCount: 3,
										stopReason: "eosFound",
									},
								}),
							};
						},
					}),
				},
			}),
			ensureResident: async () => {},
			discoverLoadedContext: async () => undefined,
		};

		const events = runStream(model, context, { maxTokens: 262144 }, deps);
		let sawDone = false;
		for await (const event of events) {
			if (event.type === "done") sawDone = true;
		}

		ok(sawDone);
		strictEqual(capturedMaxTokens, 1024);
	});

	it("uses discovered loaded context when it is smaller than catalog context", async () => {
		const model = {
			id: "loaded-small-context",
			name: "loaded-small-context",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof runStream>[1];
		let capturedMaxTokens: number | false | undefined;
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
							capturedMaxTokens = opts.maxTokens;
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 1,
										predictedTokensCount: 2,
										totalTokensCount: 3,
										stopReason: "eosFound",
									},
								}),
							};
						},
					}),
				},
			}),
			ensureResident: async () => {},
			discoverLoadedContext: async () => 2048,
		};

		const events = runStream(model, context, { maxTokens: 65536 }, deps);
		let sawDone = false;
		for await (const event of events) {
			if (event.type === "done") sawDone = true;
		}

		ok(sawDone);
		strictEqual(capturedMaxTokens, 1024);
	});

	it("does not pass load config for already-loaded user-managed models", async () => {
		const model: Parameters<typeof runStream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "user-managed" };
		} = {
			id: "already-loaded",
			name: "already-loaded",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 131072,
			clio: {
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				lifecycle: "user-managed",
			},
		};
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		} satisfies Parameters<typeof runStream>[1];
		let capturedLoadConfig: LLMLoadModelConfig | undefined;
		const deps: NonNullable<Parameters<typeof runStream>[3]> = {
			createClient: () => ({
				files: {
					prepareImageBase64: async () => {
						throw new Error("unexpected image input");
					},
				},
				llm: {
					listLoaded: async () => [],
					model: async (_modelId, opts) => {
						capturedLoadConfig = opts.config;
						return {
							respond: () => ({
								result: async () => ({
									stats: {
										promptTokensCount: 1,
										predictedTokensCount: 2,
										totalTokensCount: 3,
										stopReason: "eosFound",
									},
								}),
							}),
						};
					},
				},
			}),
			ensureResident: async () => {},
			discoverLoadedContext: async () => 800000,
		};

		const events = runStream(model, context, undefined, deps);
		let sawDone = false;
		for await (const event of events) {
			if (event.type === "done") sawDone = true;
		}

		ok(sawDone);
		strictEqual(capturedLoadConfig, undefined);
	});

	it("surfaces LM Studio load failures with target, model, and context guidance", async () => {
		const model: Parameters<typeof runStream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "user-managed" };
		} = {
			id: "too-large-local",
			name: "too-large-local",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 131072,
			clio: {
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				lifecycle: "user-managed",
			},
		};
		const context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
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
					model: async () => {
						throw new Error("not enough vram");
					},
				},
			}),
			ensureResident: async () => {},
			discoverLoadedContext: async () => undefined,
		};

		const events = runStream(model, context, undefined, deps);
		let errorMessage = "";
		for await (const event of events) {
			if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
		}

		match(errorMessage, /target 'dynamo'/);
		match(errorMessage, /model 'too-large-local'/);
		match(errorMessage, /Requested context/);
		match(errorMessage, /VRAM pressure/);
		match(errorMessage, /not enough vram/);
	});
});
