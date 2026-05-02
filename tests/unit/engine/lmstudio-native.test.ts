import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { LLMLoadModelConfig } from "@lmstudio/sdk";
import { Type } from "typebox";

import { runStream } from "../../../src/engine/apis/lmstudio-native.js";

describe("engine/lmstudio-native runStream", () => {
	it("surfaces empty SDK tool arguments as a clear runtime error", async () => {
		const model: Parameters<typeof runStream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "clio-managed" };
		} = {
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
			clio: {
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				lifecycle: "clio-managed",
			},
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
		let errorUsage: { reasoningTokens?: number } | undefined;
		for await (const event of events) {
			if (event.type === "toolcall_start") toolCallStartCount += 1;
			if (event.type === "toolcall_end") toolCallEndCount += 1;
			if (event.type === "error") {
				errorMessage = event.error.errorMessage ?? "";
				errorUsage = event.error.usage as { reasoningTokens?: number };
			}
		}

		strictEqual(toolCallStartCount, 1);
		strictEqual(toolCallEndCount, 0);
		strictEqual(capturedMaxTokens, 65536);
		strictEqual(capturedLoadConfig?.contextLength, 262144);
		strictEqual(capturedLoadConfig?.gpuStrictVramCap, true);
		strictEqual(capturedLoadConfig?.offloadKVCacheToGpu, true);
		match(errorMessage, /LM Studio SDK returned empty tool-call arguments/);
		match(errorMessage, /openai-compat runtime/);
		// Reasoning tokens from the pre-error stream should still be reported on the
		// failed assistant message so receipts and the TUI footer reflect the real
		// chain-of-thought cost rather than zero.
		strictEqual(errorUsage?.reasoningTokens, 7);
	});

	it("tracks reasoning tokens across reasoning content and start/end tags", async () => {
		const model = {
			id: "qwopus3.5-9b-v3",
			name: "qwopus3.5-9b-v3",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "say hi", timestamp: 1 }],
		} satisfies Parameters<typeof runStream>[1];
		let doneUsage: { reasoningTokens?: number; output?: number; totalTokens?: number } | undefined;
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
								content: "<think>",
								tokensCount: 1,
								containsDrafted: false,
								reasoningType: "reasoningStartTag",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "weighing options",
								tokensCount: 12,
								containsDrafted: false,
								reasoningType: "reasoning",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "</think>",
								tokensCount: 1,
								containsDrafted: false,
								reasoningType: "reasoningEndTag",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "Hi.",
								tokensCount: 2,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 10,
										predictedTokensCount: 16,
										totalTokensCount: 26,
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

		const events = runStream(model, context, undefined, deps);
		for await (const event of events) {
			if (event.type === "done") {
				doneUsage = event.message.usage as { reasoningTokens?: number; output?: number; totalTokens?: number };
			}
		}

		strictEqual(doneUsage?.reasoningTokens, 14);
		strictEqual(doneUsage?.output, 16);
		strictEqual(doneUsage?.totalTokens, 26);
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

	it("does not pass load config for user-managed models when context metadata is unavailable", async () => {
		const model: Parameters<typeof runStream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "user-managed" };
		} = {
			id: "already-loaded-no-rest-context",
			name: "already-loaded-no-rest-context",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
			clio: {
				targetId: "mini",
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
			ensureResident: async () => ({ state: "unknown" }),
			discoverLoadedContext: async () => undefined,
		};

		const events = runStream(model, context, undefined, deps);
		let sawDone = false;
		for await (const event of events) {
			if (event.type === "done") sawDone = true;
		}

		ok(sawDone);
		strictEqual(capturedLoadConfig, undefined);
	});

	it("does not pass load config for clio-managed resident models when context metadata is unavailable", async () => {
		const model: Parameters<typeof runStream>[0] & {
			clio: { targetId: string; runtimeId: string; lifecycle: "clio-managed" };
		} = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
			clio: {
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				lifecycle: "clio-managed",
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
			ensureResident: async () => ({ state: "loaded" }),
			discoverLoadedContext: async () => undefined,
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

	it("re-classifies gemma-channel <|channel>thought ... <channel|> markers as thinking", async () => {
		const model = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "what is 2+2?", timestamp: 1 }],
		} satisfies Parameters<typeof runStream>[1];
		let doneUsage: { reasoningTokens?: number; output?: number } | undefined;
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
							// Three fragments that together carry a complete channel-thought
							// region. The first carries the start marker plus partial inner
							// content; the second straddles the boundary; the third carries
							// the end marker and the visible answer.
							opts.onPredictionFragment?.({
								content: "<|channel>thought\nFirst the user wants ",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "two plus two which is four.",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "<channel|>The answer is 4.",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 5,
										predictedTokensCount: 60,
										totalTokensCount: 65,
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

		const events = runStream(model, context, undefined, deps);
		const textDeltas: string[] = [];
		const thinkingDeltas: string[] = [];
		let textBlock: string | undefined;
		let thinkingBlock: string | undefined;
		for await (const event of events) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
			if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
			if (event.type === "text_end") textBlock = event.content;
			if (event.type === "thinking_end") thinkingBlock = event.content;
			if (event.type === "done") {
				doneUsage = event.message.usage as { reasoningTokens?: number; output?: number };
			}
		}

		// Channel markers must not leak into any visible text delta.
		const allText = textDeltas.join("");
		strictEqual(allText.includes("<|channel>"), false, `text contained start marker: ${JSON.stringify(allText)}`);
		strictEqual(allText.includes("<channel|>"), false, `text contained end marker: ${JSON.stringify(allText)}`);
		// Thinking content must include the inner thought, never the markers.
		const allThinking = thinkingDeltas.join("");
		match(allThinking, /First the user wants two plus two which is four\./);
		strictEqual(allThinking.includes("<|channel>"), false);
		strictEqual(allThinking.includes("<channel|>"), false);
		// The visible answer survives intact after the end marker.
		match(textBlock ?? "", /The answer is 4\./);
		ok(thinkingBlock && thinkingBlock.length > 0, "expected a non-empty thinking block");
		// Reasoning tokens estimate from the buffered inner content (chars/4).
		ok((doneUsage?.reasoningTokens ?? 0) > 0, "expected non-zero reasoningTokens for the channel-thought region");
	});

	it("drops bare gemma thought labels before structured tool calls", async () => {
		const model = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "edit a file", timestamp: 1 }],
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
							for (const label of [" ownthought\n", " own thought\n", " own-thought\n"]) {
								opts.onPredictionFragment?.({
									content: label,
									tokensCount: 0,
									containsDrafted: false,
									reasoningType: "none",
									isStructural: false,
								});
								opts.onToolCallRequestStart?.(1, {});
								opts.onToolCallRequestNameReceived?.(1, "read");
								opts.onToolCallRequestArgumentFragmentGenerated?.(1, '{"path":"package.json"}');
								opts.onToolCallRequestEnd?.(1, {
									toolCallRequest: {
										type: "function",
										name: "read",
										arguments: { path: "package.json" },
									},
									rawContent: undefined,
								});
							}
							opts.onPredictionFragment?.({
								content: "Done.",
								tokensCount: 1,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 5,
										predictedTokensCount: 60,
										totalTokensCount: 65,
										stopReason: "toolCalls",
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

		const events = runStream(model, context, undefined, deps);
		const textDeltas: string[] = [];
		let toolCallEndCount = 0;
		for await (const event of events) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
			if (event.type === "toolcall_end") toolCallEndCount += 1;
		}

		strictEqual(textDeltas.join(""), "Done.");
		strictEqual(toolCallEndCount, 3);
	});

	it("drops gemma <tool_call|> ... <|tool_call|> fallback regions from text and thinking", async () => {
		const model = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "call a tool", timestamp: 1 }],
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
								content: '<tool_call|>{"name":"x","arguments":{}}<|tool_call|>',
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 5,
										predictedTokensCount: 12,
										totalTokensCount: 17,
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

		const events = runStream(model, context, undefined, deps);
		const textDeltas: string[] = [];
		const thinkingDeltas: string[] = [];
		for await (const event of events) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
			if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
		}
		strictEqual(textDeltas.join(""), "");
		strictEqual(thinkingDeltas.join(""), "");
	});

	it("suppresses gemma tool-call regions when split across chunk boundaries", async () => {
		const model = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "call a tool", timestamp: 1 }],
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
								content: "<tool_ca",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: 'll|>{"name":"x","arguments":{}}<|tool_',
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							opts.onPredictionFragment?.({
								content: "call|>",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 5,
										predictedTokensCount: 12,
										totalTokensCount: 17,
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

		const events = runStream(model, context, undefined, deps);
		const textDeltas: string[] = [];
		const thinkingDeltas: string[] = [];
		for await (const event of events) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
			if (event.type === "thinking_delta") thinkingDeltas.push(event.delta);
		}
		const allText = textDeltas.join("");
		strictEqual(allText.includes("<tool_call|>"), false, `text leaked start marker: ${JSON.stringify(allText)}`);
		strictEqual(allText.includes("<|tool_call|>"), false, `text leaked end marker: ${JSON.stringify(allText)}`);
		strictEqual(allText.includes("name"), false, `tool-call inner content leaked: ${JSON.stringify(allText)}`);
		strictEqual(thinkingDeltas.join(""), "");
	});

	it("emits surrounding text but drops the tool-call region in mixed content", async () => {
		const model = {
			id: "gemma-4-31b-it-nvfp4-turbo",
			name: "gemma-4-31b-it-nvfp4-turbo",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 122880,
			maxTokens: 32768,
		} satisfies Parameters<typeof runStream>[0];
		const context = {
			messages: [{ role: "user", content: "mix", timestamp: 1 }],
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
								content: "pre<tool_call|>garbage<|tool_call|>post",
								tokensCount: 0,
								containsDrafted: false,
								reasoningType: "none",
								isStructural: false,
							});
							return {
								result: async () => ({
									stats: {
										promptTokensCount: 5,
										predictedTokensCount: 12,
										totalTokensCount: 17,
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

		const events = runStream(model, context, undefined, deps);
		const textDeltas: string[] = [];
		let textBlock: string | undefined;
		for await (const event of events) {
			if (event.type === "text_delta") textDeltas.push(event.delta);
			if (event.type === "text_end") textBlock = event.content;
		}
		const allText = textDeltas.join("");
		strictEqual(allText.includes("garbage"), false, `tool-call inner leaked: ${JSON.stringify(allText)}`);
		strictEqual(allText.includes("<tool_call|>"), false);
		strictEqual(allText.includes("<|tool_call|>"), false);
		match(textBlock ?? "", /^pre.*post$/);
	});

	it("budget-tokens mechanism does not mutate maxPredictedTokens (refinement 1)", async () => {
		// Refinement 1: the LM Studio SDK has no separate thinking-budget channel.
		// `maxPredictedTokens` is the total output cap and must stay driven by
		// remaining context. The mechanism shows up in the prompt, not the SDK
		// payload.
		const model: Parameters<typeof runStream>[0] & {
			clio: {
				targetId: string;
				runtimeId: string;
				lifecycle: "user-managed";
				quirks: { thinking: { mechanism: "budget-tokens"; budgetByLevel: { high: 16384 } } };
			};
		} = {
			id: "qwopus3.6-27b-v1-preview",
			name: "qwopus3.6-27b-v1-preview",
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl: "ws://127.0.0.1:1234",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			clio: {
				targetId: "dynamo",
				runtimeId: "lmstudio-native",
				lifecycle: "user-managed",
				quirks: { thinking: { mechanism: "budget-tokens", budgetByLevel: { high: 16384 } } },
			},
		};
		const context = {
			messages: [{ role: "user", content: "explain", timestamp: 1 }],
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

		const events = runStream(model, context, { maxTokens: 32768 }, deps, { thinkingLevel: "high" });
		for await (const _event of events) {
			// drain
		}
		// `maxTokens` is clamped by the remaining-context budget, not by the
		// 16384 thinking budget. The exact value depends on the input; the
		// invariant is that it does NOT equal the budget.
		ok(capturedMaxTokens !== 16384, `expected maxPredictedTokens != budget; got ${capturedMaxTokens}`);
	});
});
