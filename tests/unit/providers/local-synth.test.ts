import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { ProvidersContract } from "../../../src/domains/providers/contract.js";
import llamacppRuntime from "../../../src/domains/providers/runtimes/local-native/llamacpp.js";
import llamacppCompletionRuntime from "../../../src/domains/providers/runtimes/local-native/llamacpp-completion.js";
import lmstudioNativeRuntime from "../../../src/domains/providers/runtimes/local-native/lmstudio-native.js";
import type { KnowledgeBaseHit } from "../../../src/domains/providers/types/knowledge-base.js";
import type { LocalModelQuirks } from "../../../src/domains/providers/types/local-model-quirks.js";
import { synthesizeOrchestratorModel } from "../../../src/entry/orchestrator.js";

describe("providers/runtimes/local synthesis", () => {
	it("applies self-dev caps and local OpenAI-compatible request overrides", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "qwen3.6-35b-a3b",
				matchPatterns: ["qwen3.6-35b-a3b"],
				capabilities: {
					chat: true,
					tools: true,
					toolCallFormat: "qwen",
					reasoning: true,
					thinkingFormat: "qwen-chat-template",
					structuredOutputs: "json-schema",
					vision: true,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 262144,
					maxTokens: 65536,
				},
			},
			matchKind: "family",
		};
		const model = llamacppCompletionRuntime.synthesizeModel(
			{ id: "mini", runtime: "llamacpp-completion", url: "http://mini:8080" },
			"Qwen3.6-35B-A3B-UD-Q4_K_XL",
			kb,
		);

		strictEqual(model.contextWindow, 262144);
		strictEqual(model.maxTokens, 65536);
		strictEqual(model.reasoning, true);
		deepStrictEqual(model.input, ["text", "image"]);
		const metadata = (
			model as typeof model & {
				clio?: { targetId: string; runtimeId: string; lifecycle: string };
			}
		).clio;
		strictEqual(metadata?.targetId, "mini");
		strictEqual(metadata?.runtimeId, "llamacpp-completion");
		strictEqual(metadata?.lifecycle, "user-managed");
		const compat = model.compat as OpenAICompletionsCompat | undefined;
		strictEqual(compat?.maxTokensField, "max_tokens");
		strictEqual(compat?.supportsDeveloperRole, false);
		strictEqual(compat?.supportsReasoningEffort, false);
		strictEqual(compat?.supportsStrictMode, false);
		strictEqual(compat?.thinkingFormat, "qwen-chat-template");
	});

	it("carries kvCache and sampling quirks onto model.clio.quirks via the common synth path", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "qwen3.6-27b",
				matchPatterns: ["qwen3.6-27b"],
				capabilities: {
					chat: true,
					tools: true,
					reasoning: true,
					vision: false,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 262144,
					maxTokens: 32768,
				},
				quirks: {
					kvCache: { kQuant: "q8_0", vQuant: "q8_0" },
					sampling: {
						thinking: { temperature: 0.6, topP: 0.95, topK: 20, repetitionPenalty: 1.0 },
						instruct: { temperature: 0.7, topP: 0.8, topK: 20 },
					},
					gpuTiers: { "32gb": "fits at f16 KV" },
				},
			},
			matchKind: "family",
		};
		const model = llamacppCompletionRuntime.synthesizeModel(
			{ id: "mini", runtime: "llamacpp-completion", url: "http://mini:8080" },
			"Qwen3.6-27B-UD-Q4_K_XL",
			kb,
		);
		const quirks = (model as typeof model & { clio?: { quirks?: LocalModelQuirks } }).clio?.quirks;
		deepStrictEqual(quirks?.kvCache, { kQuant: "q8_0", vQuant: "q8_0" });
		strictEqual(quirks?.sampling?.thinking?.temperature, 0.6);
		strictEqual(quirks?.sampling?.thinking?.topK, 20);
		strictEqual(quirks?.sampling?.thinking?.repeatPenalty, 1.0);
		strictEqual(quirks?.sampling?.instruct?.temperature, 0.7);
	});

	it("does not attach quirks when the catalog only carries free-form fields", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "freeform",
				matchPatterns: ["freeform"],
				capabilities: {
					chat: true,
					reasoning: false,
					vision: false,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					tools: false,
					contextWindow: 4096,
					maxTokens: 1024,
				},
				quirks: { gpuTiers: { "32gb": "ok" }, runtimePreference: { lmstudioNative: "primary" } },
			},
			matchKind: "family",
		};
		const model = llamacppCompletionRuntime.synthesizeModel(
			{ id: "mini", runtime: "llamacpp-completion", url: "http://mini:8080" },
			"freeform",
			kb,
		);
		strictEqual((model as typeof model & { clio?: { quirks?: LocalModelQuirks } }).clio?.quirks, undefined);
	});

	it("carries quirks onto model.clio.quirks via the lmstudio-native synth path", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "gemma-4-31b-it-nvfp4-turbo",
				matchPatterns: ["gemma-4-31b-it-nvfp4-turbo"],
				capabilities: {
					chat: true,
					tools: true,
					reasoning: true,
					vision: true,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 122880,
					maxTokens: 32768,
				},
				quirks: {
					kvCache: { kQuant: "q8_0", vQuant: "q8_0" },
					sampling: { thinking: { temperature: 1.0, topP: 0.95, topK: 64 } },
				},
			},
			matchKind: "family",
		};
		const model = lmstudioNativeRuntime.synthesizeModel(
			{ id: "dynamo", runtime: "lmstudio-native", url: "http://dynamo:1234", lifecycle: "clio-managed" },
			"gemma-4-31b-it-nvfp4-turbo",
			kb,
		);
		const quirks = (model as typeof model & { clio?: { quirks?: LocalModelQuirks } }).clio?.quirks;
		deepStrictEqual(quirks?.kvCache, { kQuant: "q8_0", vQuant: "q8_0" });
		strictEqual(quirks?.sampling?.thinking?.topK, 64);
	});

	it("maps DeepSeek-R1 reasoning to pi-ai's deepseek thinking format", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "deepseek-r1",
				matchPatterns: ["deepseek-r1"],
				capabilities: {
					chat: true,
					tools: true,
					reasoning: true,
					thinkingFormat: "deepseek-r1",
					vision: false,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 128000,
					maxTokens: 32768,
				},
			},
			matchKind: "family",
		};
		const model = llamacppCompletionRuntime.synthesizeModel(
			{ id: "mini", runtime: "llamacpp-completion", url: "http://mini:8080" },
			"DeepSeek-R1",
			kb,
		);

		const compat = model.compat as OpenAICompletionsCompat | undefined;
		strictEqual(compat?.thinkingFormat, "deepseek");
	});

	it("uses knowledge-base hits when synthesizing the orchestrator compaction model", () => {
		const kb: KnowledgeBaseHit = {
			entry: {
				family: "qwen3.6-35b-a3b",
				matchPatterns: ["qwen3.6-35b-a3b"],
				capabilities: {
					chat: true,
					tools: true,
					reasoning: true,
					vision: false,
					audio: false,
					embeddings: false,
					rerank: false,
					fim: false,
					contextWindow: 262144,
					maxTokens: 65536,
				},
				quirks: {
					sampling: {
						thinking: { temperature: 0.6, topP: 0.95, topK: 20 },
					},
					thinking: {
						mechanism: "budget-tokens",
						budgetByLevel: { high: 16384 },
					},
				},
			},
			matchKind: "family",
		};
		const providers = {
			getRuntime: (id: string) => (id === "llamacpp" ? llamacppRuntime : null),
			knowledgeBase: {
				lookup: () => kb,
				entries: () => [kb.entry],
			},
		} as unknown as ProvidersContract;

		const model = synthesizeOrchestratorModel(
			providers,
			{ id: "mini", runtime: "llamacpp", url: "http://mini:8080" },
			"Qwen3.6-35B-A3B-UD-Q4_K_XL",
		);

		strictEqual(model?.contextWindow, 262144);
		strictEqual(model?.maxTokens, 65536);
		const quirks = (model as typeof model & { clio?: { quirks?: LocalModelQuirks } }).clio?.quirks;
		strictEqual(quirks?.sampling?.thinking?.temperature, 0.6);
		strictEqual(quirks?.thinking?.mechanism, "budget-tokens");
	});
});
