import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { RUN_OVERRIDES_ENV } from "../../src/core/run-overrides.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import {
	assistantMessage,
	type LmStudioRunDeps,
	loadModelConfig,
	type ResidentModelEntry,
	runStream,
} from "../../src/engine/apis/lmstudio-native.js";
import { reconcileResidency, resetResidencyState, setResidencyNoticeSink } from "../../src/engine/apis/residency.js";

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

/**
 * Predictions go over LM Studio's OpenAI-compatible port by default. Tests
 * that drive the SDK prediction surface through injected deps opt back into it
 * so they keep asserting on the transport they are about, and so no contract
 * test reaches for a socket.
 */
async function withSdkPrediction<T>(fn: () => Promise<T>): Promise<T> {
	const previous = process.env.CLIO_LMSTUDIO_SDK_PREDICT;
	process.env.CLIO_LMSTUDIO_SDK_PREDICT = "1";
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.CLIO_LMSTUDIO_SDK_PREDICT;
		else process.env.CLIO_LMSTUDIO_SDK_PREDICT = previous;
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
			reconcile: async () => ({ decision: "observe", evict: [], fallbackEvict: [], keepResident: false, notices: [] }),
			discoverLoadedContext: async () => undefined,
		};

		const events: Array<{ type: string; message?: AssistantMessage }> = [];
		await withSdkPrediction(async () => {
			for await (const event of runStream(noThinkingModel, context, undefined, deps, { thinkingLevel: "off" })) {
				events.push(event as { type: string; message?: AssistantMessage });
			}
		});

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
		// The reasoning-never class governs what is shown, never what the server
		// spent. This model reasoned anyway, for 1 + 3 + 1 tokens across the start
		// tag, the body, and the end tag, and usage reports all five.
		//
		// This assertion previously required `undefined`. That contract was wrong:
		// the SDK carries no chat-template-kwargs channel, so `enable_thinking`
		// never reaches this transport and a catalog `reasoning: false` cannot
		// stop a model from reasoning, only stop Clio from displaying it. Reporting
		// zero for a model burning most of its output on reasoning removed the one
		// reading that would show the catalog was wrong about the model.
		strictEqual((message.usage as { reasoningTokens?: number }).reasoningTokens, 5);
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

describe("contracts/lmstudio-native co-resident residency", () => {
	let previousSdkPredict: string | undefined;

	beforeEach(() => {
		resetResidencyState();
		setResidencyNoticeSink(() => {});
		// These assert on residency, and reach the prediction only to observe that
		// the turn completed. Pinning the SDK transport keeps them off the network.
		previousSdkPredict = process.env.CLIO_LMSTUDIO_SDK_PREDICT;
		process.env.CLIO_LMSTUDIO_SDK_PREDICT = "1";
	});

	afterEach(() => {
		setResidencyNoticeSink(null);
		resetResidencyState();
		if (previousSdkPredict === undefined) delete process.env.CLIO_LMSTUDIO_SDK_PREDICT;
		else process.env.CLIO_LMSTUDIO_SDK_PREDICT = previousSdkPredict;
	});

	function residencyDeps(opts: {
		resident: string[];
		unloaded: string[];
		failLoadsBeforeSuccess?: number;
	}): LmStudioRunDeps {
		let loadAttempts = 0;
		const residentEntries: ResidentModelEntry[] = opts.resident.map((modelKey) => ({
			modelKey,
			unload: async () => {
				opts.unloaded.push(modelKey);
			},
		}));
		return {
			createClient: () =>
				({
					files: {
						prepareImageBase64: async () => {
							throw new Error("image preparation not expected");
						},
					},
					llm: {
						listLoaded: async () => residentEntries,
						model: async () => {
							loadAttempts += 1;
							if (loadAttempts <= (opts.failLoadsBeforeSuccess ?? 0)) {
								throw new Error("insufficient VRAM for JIT load");
							}
							return {
								respond: (_history, _opts) => ({
									result: async () => ({
										stats: {
											promptTokensCount: 3,
											predictedTokensCount: 2,
											totalTokensCount: 5,
											stopReason: "eosFound" as const,
										},
									}),
								}),
							};
						},
					},
				}) as ReturnType<LmStudioRunDeps["createClient"]>,
			reconcile: reconcileResidency,
			discoverLoadedContext: async () => undefined,
			lock: async (_targetKey, fn) => fn(),
		};
	}

	const context = {
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	} as Parameters<typeof runStream>[1];

	it("co-hosts with an operator-loaded model when the JIT load succeeds", async () => {
		const unloaded: string[] = [];
		const deps = residencyDeps({ resident: ["operator-model"], unloaded });

		const events: Array<{ type: string }> = [];
		for await (const event of runStream(model(), context, undefined, deps, { thinkingLevel: "off" })) {
			events.push(event as { type: string });
		}

		deepStrictEqual(unloaded, [], "a successful co-resident load must not evict the operator's model");
		ok(events.some((event) => event.type === "done"));
	});

	it("swaps the fallback candidate and retries once after a will-not-fit JIT failure", async () => {
		const unloaded: string[] = [];
		const deps = residencyDeps({ resident: ["operator-model"], unloaded, failLoadsBeforeSuccess: 1 });

		const events: Array<{ type: string }> = [];
		for await (const event of runStream(model(), context, undefined, deps, { thinkingLevel: "off" })) {
			events.push(event as { type: string });
		}

		deepStrictEqual(unloaded, ["operator-model"], "the failed load justifies exactly one recorded swap");
		ok(events.some((event) => event.type === "done"));
	});

	it("fails with a will-not-fit error when the retry also cannot fit", async () => {
		const unloaded: string[] = [];
		const deps = residencyDeps({ resident: ["operator-model"], unloaded, failLoadsBeforeSuccess: 2 });

		const events: Array<{ type: string; error?: AssistantMessage }> = [];
		for await (const event of runStream(model(), context, undefined, deps, { thinkingLevel: "off" })) {
			events.push(event as { type: string; error?: AssistantMessage });
		}

		const error = events.find((event) => event.type === "error");
		ok(error?.error?.errorMessage?.includes("could not load"), error?.error?.errorMessage);
	});
});

describe("contracts/lmstudio-native prediction transport", () => {
	function sseResponse(text: string): Response {
		const chunks = [
			`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] })}\n\n`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
			"data: [DONE]\n\n",
		];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	function captureRequest(): {
		deps: LmStudioRunDeps;
		fetch: typeof globalThis.fetch;
		seen: { url?: string; body?: Record<string, unknown> };
	} {
		const seen: { url?: string; body?: Record<string, unknown> } = {};
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
							respond: () => {
								throw new Error("prediction must not go over the SDK");
							},
						}),
					},
				}) as ReturnType<LmStudioRunDeps["createClient"]>,
			reconcile: async () => ({ decision: "observe", evict: [], fallbackEvict: [], keepResident: false, notices: [] }),
			discoverLoadedContext: async () => undefined,
		};
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			seen.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return sseResponse("Visible answer.");
		}) as typeof globalThis.fetch;
		return { deps, fetch: fetchImpl, seen };
	}

	const context = {
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	} as Parameters<typeof runStream>[1];

	/**
	 * The defect this pins: `off` used to reach the SDK, which has no channel to
	 * carry it, so a model that reasons by default kept reasoning at every dial.
	 * LM Studio's OpenAI-compatible port reads `reasoning_effort`, and `none` is
	 * the value that suppresses reasoning there.
	 */
	it("sends thinking off to LM Studio's HTTP surface as reasoning_effort none", async () => {
		const { deps, fetch, seen } = captureRequest();
		const events: Array<{ type: string }> = [];
		for await (const event of runStream(model(undefined, { reasoning: true }), context, { fetch }, deps, {
			thinkingLevel: "off",
		})) {
			events.push(event as { type: string });
		}

		ok(seen.url?.startsWith("http://127.0.0.1:1234/v1/"), seen.url);
		strictEqual(seen.body?.reasoning_effort, "none");
		ok(events.some((event) => event.type === "done"));
	});

	it("sends an on dial as reasoning_effort low", async () => {
		const { deps, fetch, seen } = captureRequest();
		for await (const _event of runStream(model(undefined, { reasoning: true }), context, { fetch }, deps, {
			thinkingLevel: "low",
		})) {
			// draining the stream is what drives the request
		}

		strictEqual(seen.body?.reasoning_effort, "low");
	});
});
