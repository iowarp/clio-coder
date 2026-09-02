import { strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import { resolveModelRuntimeCapabilities } from "../../src/domains/providers/model-runtime-capabilities.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import { extractLocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";

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

	it("forwards static chat-template kwargs for llama.cpp and LM Studio", () => {
		const staticQuirks = {
			chatTemplateKwargs: {
				static: { force_nonempty_content: true },
			},
		} as const;
		const llama = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "nemo3.5-30b-moe",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			quirks: staticQuirks as never,
		});
		strictEqual(llama.request.chatTemplateKwargs?.force_nonempty_content, true);

		const lmstudio = resolveModelRuntimeCapabilities({
			runtimeId: "lmstudio",
			modelId: "nvidia-nemotron-3.5-lightning-30b-a3b",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			quirks: staticQuirks as never,
		});
		strictEqual(lmstudio.request.chatTemplateKwargs?.force_nonempty_content, true);
	});

	it("resolves level-keyed chat-template kwargs from thinking level high", () => {
		const levelQuirks = {
			thinking: {
				mechanism: "effort-levels",
				chatTemplateKwargs: {
					byLevel: {
						key: "reasoning_strength",
						values: { low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
					},
				},
			},
		} as const;
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "muse-30b-dense",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: levelQuirks as never,
			configuredThinkingLevel: "high",
		});
		strictEqual(resolved.request.chatTemplateKwargs?.reasoning_strength, "high");
	});

	it("preserves numeric chat-template kwargs as numbers on the wire", () => {
		const numericQuirks = {
			thinking: {
				mechanism: "budget-tokens",
				chatTemplateKwargs: {
					static: { reasoning_budget: 16384 },
				},
			},
		} as const;
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "nemotron3-30b-moe-omni",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: numericQuirks as never,
		});
		strictEqual(resolved.request.chatTemplateKwargs?.reasoning_budget, 16384);
		strictEqual(typeof resolved.request.chatTemplateKwargs?.reasoning_budget, "number");
	});

	it("preserves existing thinking controls and lets them win on key collision", () => {
		const collisionQuirks = {
			thinking: {
				mechanism: "effort-levels",
				effortByLevel: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" },
				chatTemplateKwargs: {
					static: { enable_thinking: true, custom_flag: "active" },
				},
			},
		} as const;
		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "qwen3.8-27b-dense",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
			quirks: collisionQuirks as never,
			configuredThinkingLevel: "off",
		});
		strictEqual(resolved.request.chatTemplateKwargs?.enable_thinking, false);
		strictEqual(resolved.request.chatTemplateKwargs?.custom_flag, "active");
	});

	it("rejects unknown chat-template kwargs shapes during quirk extraction", () => {
		strictEqual(extractLocalModelQuirks({ chatTemplateKwargs: "not-an-object" }), undefined);
		strictEqual(extractLocalModelQuirks({ chatTemplateKwargs: { byLevel: { key: 123 } } }), undefined);
		strictEqual(extractLocalModelQuirks({ chatTemplateKwargs: { byLevel: { key: "x", values: "none" } } }), undefined);
		strictEqual(
			extractLocalModelQuirks({ chatTemplateKwargs: { byLevel: { key: "x", values: { invalid_level: "y" } } } }),
			undefined,
		);
	});

	it("resolves kwargs from local coding target knowledge base entries", () => {
		const kb = new FileKnowledgeBase(join(process.cwd(), "src/domains/providers/models"));
		const nemotronLightning = kb.lookup("nemo3.5-30b-moe");
		const museGlimmer = kb.lookup("muse-30b-dense");
		const nemotronOmni = kb.lookup("nemotron3-30b-moe-omni");

		strictEqual(nemotronLightning?.entry.family, "nemotron-3.5-lightning");
		const lightningResolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "nemo3.5-30b-moe",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true },
			kbHit: nemotronLightning,
		});
		strictEqual(lightningResolved.request.chatTemplateKwargs?.force_nonempty_content, true);

		strictEqual(museGlimmer?.entry.family, "muse-glimmer");
		const museResolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "muse-30b-dense",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			kbHit: museGlimmer,
			configuredThinkingLevel: "high",
		});
		strictEqual(museResolved.request.chatTemplateKwargs?.reasoning_strength, "high");

		strictEqual(nemotronOmni?.entry.family, "nemotron-3-nano-omni-30b-a3b-reasoning");
		const omniResolved = resolveModelRuntimeCapabilities({
			runtimeId: "llamacpp",
			modelId: "nemotron3-30b-moe-omni",
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			kbHit: nemotronOmni,
		});
		strictEqual(omniResolved.request.chatTemplateKwargs?.reasoning_budget, 16384);
		strictEqual(typeof omniResolved.request.chatTemplateKwargs?.reasoning_budget, "number");
	});
});
