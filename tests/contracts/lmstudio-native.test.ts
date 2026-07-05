import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { RUN_OVERRIDES_ENV } from "../../src/core/run-overrides.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import {
	assistantMessage,
	type LmStudioRunDeps,
	loadModelConfig,
	runStream,
} from "../../src/engine/apis/lmstudio-native.js";

interface ClioModel extends Model<"lmstudio-native"> {
	clio?: {
		targetId: string;
		runtimeId: string;
		lifecycle: "user-managed" | "clio-managed";
		quirks?: LocalModelQuirks;
	};
}

interface CapturedLmStudioHistory {
	messages: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
}

function model(quirks?: LocalModelQuirks, opts?: { reasoning?: boolean }): Model<"lmstudio-native"> {
	const fixture: ClioModel = {
		id: "local-model",
		name: "Local Model",
		api: "lmstudio-native",
		provider: "lmstudio-native",
		baseUrl: "ws://127.0.0.1:1234",
		reasoning: opts?.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
		...(quirks === undefined
			? {}
			: {
					clio: {
						targetId: "local",
						runtimeId: "lmstudio",
						lifecycle: "clio-managed",
						quirks,
					},
				}),
	};
	return fixture;
}

function withKvCacheMode<T>(value: string, fn: () => T): T {
	const previous = process.env[RUN_OVERRIDES_ENV];
	process.env[RUN_OVERRIDES_ENV] = JSON.stringify({ kvCacheMode: value });
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env[RUN_OVERRIDES_ENV];
		else process.env[RUN_OVERRIDES_ENV] = previous;
	}
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { result: fn(), stderr };
	} finally {
		process.stderr.write = original;
	}
}

describe("lmstudio-native thinking replay", () => {
	it("assistant message with thinking yields a leading <think>...</think> text part", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Determining path..." },
			{ type: "text", text: "Done." },
		];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 2);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "<think>\nDetermining path...\n</think>",
		});
		deepStrictEqual(message.content[1], {
			type: "text",
			text: "Done.",
		});
	});

	it("assistant message without thinking matches current behavior (no leading think block)", () => {
		const content: AssistantMessage["content"] = [{ type: "text", text: "Done." }];
		const message = assistantMessage(content);
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 1);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "Done.",
		});
	});

	it("can skip assistant thinking replay for reasoning-never models", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Determining path..." },
			{ type: "text", text: "Done." },
		];
		const message = assistantMessage(content, { preserveThinking: false });
		strictEqual(message.role, "assistant");
		strictEqual(message.content.length, 1);
		deepStrictEqual(message.content[0], {
			type: "text",
			text: "Done.",
		});
	});

	it("suppresses SDK-classified reasoning fragments for reasoning-never models", async () => {
		const noThinkingModel = model({ thinking: { mechanism: "none" } }, { reasoning: true });
		const context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "old hidden reasoning" },
						{ type: "text", text: "old visible answer" },
					],
					api: "lmstudio-native",
					provider: "lmstudio-native",
					model: noThinkingModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: "continue", timestamp: 0 },
			],
		} as Parameters<typeof runStream>[1];
		let capturedHistory!: CapturedLmStudioHistory;
		const deps: LmStudioRunDeps = {
			createClient: () =>
				({
					files: {
						prepareImageBase64: async () => {
							throw new Error("image preparation not expected");
						},
					},
					llm: {
						listLoaded: async () => [],
						model: async () => ({
							respond: (history, opts) => {
								capturedHistory = history as CapturedLmStudioHistory;
								return {
									result: async () => {
										opts.onPredictionFragment?.({
											content: "<think>",
											tokensCount: 1,
											containsDrafted: false,
											reasoningType: "reasoningStartTag",
											isStructural: false,
										});
										opts.onPredictionFragment?.({
											content: "hidden reasoning",
											tokensCount: 3,
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
											content: "Visible answer.",
											tokensCount: 4,
											containsDrafted: false,
											reasoningType: "none",
											isStructural: false,
										});
										return {
											stats: {
												promptTokensCount: 5,
												predictedTokensCount: 9,
												totalTokensCount: 14,
												stopReason: "eosFound",
											},
										};
									},
								};
							},
						}),
					},
				}) as ReturnType<LmStudioRunDeps["createClient"]>,
			reconcile: async () => ({ decision: "observe", evict: [], keepResident: false, notices: [] }),
			discoverLoadedContext: async () => undefined,
		};

		const events: Array<{ type: string; message?: AssistantMessage }> = [];
		for await (const event of runStream(noThinkingModel, context, undefined, deps, { thinkingLevel: "off" })) {
			events.push(event as { type: string; message?: AssistantMessage });
		}

		ok(capturedHistory.messages, "history should have been sent to LM Studio");
		const replayedAssistant = capturedHistory.messages.find((entry) => entry.role === "assistant");
		ok(replayedAssistant, "assistant replay message should be present");
		strictEqual(
			replayedAssistant.content?.some((part) => part.text?.includes("old hidden reasoning")),
			false,
		);
		strictEqual(
			events.some((event) => event.type === "thinking_delta"),
			false,
		);
		const done = events.find((event) => event.type === "done");
		ok(done && "message" in done, "stream should finish with a done message");
		const message = done.message as AssistantMessage;
		strictEqual(
			message.content.some((block) => block.type === "thinking"),
			false,
		);
		strictEqual(message.content.find((block) => block.type === "text")?.text, "Visible answer.");
		strictEqual((message.usage as { reasoningTokens?: number }).reasoningTokens, undefined);
	});
});

describe("contracts/lmstudio-native KV-cache env override", () => {
	it("sets f16 mode and useFp16ForKVCache", () => {
		const config = withKvCacheMode("f16", () => loadModelConfig(model()));
		strictEqual(config.llamaKCacheQuantizationType, "f16");
		strictEqual(config.llamaVCacheQuantizationType, "f16");
		strictEqual(config.useFp16ForKVCache, true);
	});

	it("clears configured KV-cache settings for none", () => {
		const config = withKvCacheMode("none", () =>
			loadModelConfig(model({ kvCache: { kQuant: "q4_0", vQuant: "q5_0", useFp16: true } })),
		);
		ok(!("llamaKCacheQuantizationType" in config));
		ok(!("llamaVCacheQuantizationType" in config));
		ok(!("useFp16ForKVCache" in config));
	});

	it("sets valid quant modes without any casts", () => {
		const config = withKvCacheMode("q8_0", () => loadModelConfig(model()));
		strictEqual(config.llamaKCacheQuantizationType, "q8_0");
		strictEqual(config.llamaVCacheQuantizationType, "q8_0");
		strictEqual(config.useFp16ForKVCache, false);
	});

	it("warns once and leaves config unchanged for invalid values", () => {
		const quirks: LocalModelQuirks = { kvCache: { kQuant: "q4_0", vQuant: "q5_0", useFp16: true } };
		const { result, stderr } = withKvCacheMode("bogus", () => captureStderr(() => loadModelConfig(model(quirks))));
		strictEqual(result.llamaKCacheQuantizationType, "q4_0");
		strictEqual(result.llamaVCacheQuantizationType, "q5_0");
		strictEqual(result.useFp16ForKVCache, true);
		strictEqual(stderr, "clio: ignoring invalid kv-cache-mode override 'bogus'\n");
	});
});
