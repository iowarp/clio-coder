import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenAICompletionsCompat } from "@mariozechner/pi-ai";

import llamacppCompletionRuntime from "../../../src/domains/providers/runtimes/local-native/llamacpp-completion.js";
import type { KnowledgeBaseHit } from "../../../src/domains/providers/types/knowledge-base.js";

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
		const compat = model.compat as OpenAICompletionsCompat | undefined;
		strictEqual(compat?.maxTokensField, "max_tokens");
		strictEqual(compat?.supportsDeveloperRole, false);
		strictEqual(compat?.supportsReasoningEffort, false);
		strictEqual(compat?.supportsStrictMode, false);
		strictEqual(compat?.thinkingFormat, "qwen-chat-template");
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
});
