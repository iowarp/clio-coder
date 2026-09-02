import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { resolveModelRuntimeCapabilities } from "../../src/domains/providers/model-runtime-capabilities.js";

const effortLevelsQuirks = {
	thinking: {
		mechanism: "effort-levels",
		effortByLevel: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" },
	},
} as const;

describe("thinking off reaches the wire", () => {
	it("sends reasoning_effort none to LM Studio for an effort-levels family", () => {
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "lmstudio",
			modelId: "qwen3.8-27b-dynamo",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: effortLevelsQuirks as never,
			configuredThinkingLevel: "off",
		});
		strictEqual(resolved.thinking.thinkingActive, false);
		strictEqual(resolved.request.reasoningEffort, "none");
		strictEqual(resolved.request.chatTemplateKwargs?.enable_thinking, false);
	});

	it("keeps llama.cpp on the template flag alone, which that runtime honors", () => {
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "qwen3.8-27b-dense",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: effortLevelsQuirks as never,
			configuredThinkingLevel: "off",
		});
		strictEqual(resolved.request.reasoningEffort, undefined);
		strictEqual(resolved.request.chatTemplateKwargs?.enable_thinking, false);
	});

	it("does not touch an active level", () => {
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "lmstudio",
			modelId: "qwen3.8-27b-dynamo",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: effortLevelsQuirks as never,
			configuredThinkingLevel: "medium",
		});
		strictEqual(resolved.thinking.thinkingActive, true);
		strictEqual(resolved.request.reasoningEffort, "medium");
	});
});
