import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	resolveModelRuntimeCapabilities,
	resolveModelRuntimeCapabilitiesForModel,
} from "../../src/domains/providers/model-runtime-capabilities.js";
import type { CapabilityFlags } from "../../src/domains/providers/types/capability-flags.js";
import { availableThinkingLevels, EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { createEngineAi } from "../../src/engine/ai.js";
import { patchProviderThinkingPayload } from "../../src/engine/provider-payload.js";

const engineAi = createEngineAi();

function anthropicCaps(maxTokens = 8192): CapabilityFlags {
	return {
		...EMPTY_CAPABILITIES,
		chat: true,
		tools: true,
		reasoning: true,
		thinkingFormat: "anthropic-extended",
		contextWindow: 200000,
		maxTokens,
	};
}

describe("contracts/thinking-runtime", () => {
	it("does not advertise xhigh for uncataloged Anthropic extended-thinking targets", () => {
		deepStrictEqual(availableThinkingLevels(anthropicCaps()), ["off", "minimal", "low", "medium", "high"]);

		const resolved = resolveModelRuntimeCapabilities({
			runtimeId: "anthropic",
			apiFamily: "anthropic-messages",
			modelId: "custom-claude",
			capabilities: anthropicCaps(8192),
			configuredThinkingLevel: "xhigh",
		});

		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "high");
		strictEqual(resolved.thinking.mechanism, "budget-tokens");
		strictEqual(resolved.thinking.budgetEnforcement, "enforced");
		strictEqual(resolved.request.budgetTokens, 7168);
	});

	it("uses cataloged Anthropic adaptive-thinking metadata for xhigh effort", () => {
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus, "pi-ai catalog should include claude-opus-4-7");

		const resolved = resolveModelRuntimeCapabilitiesForModel(opus, "xhigh");

		strictEqual(resolved.capabilities.thinkingFormat, "anthropic-extended");
		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
		strictEqual(resolved.thinking.effectiveLevel, "xhigh");
		strictEqual(resolved.thinking.mechanism, "effort-levels");
		strictEqual(resolved.request.reasoningEffort, "xhigh");
		strictEqual(resolved.request.budgetTokens, undefined);
	});

	it("coerces xhigh to high for Anthropic models without xhigh metadata", () => {
		const sonnet = engineAi.getModel("anthropic", "claude-sonnet-4-6");
		ok(sonnet, "pi-ai catalog should include claude-sonnet-4-6");

		const resolved = resolveModelRuntimeCapabilitiesForModel(sonnet, "xhigh");

		deepStrictEqual(resolved.thinking.supportedLevels, ["off", "minimal", "low", "medium", "high"]);
		strictEqual(resolved.thinking.effectiveLevel, "high");
		strictEqual(resolved.thinking.mechanism, "effort-levels");
		strictEqual(resolved.request.reasoningEffort, "high");
	});

	it("patches Anthropic adaptive payloads with the resolved effort field", () => {
		const opus = engineAi.getModel("anthropic", "claude-opus-4-7");
		ok(opus, "pi-ai catalog should include claude-opus-4-7");
		const payload = {
			model: opus.id,
			messages: [],
			max_tokens: 128000,
			stream: true,
			thinking: { type: "adaptive", display: "summarized" },
		};

		const patched = patchProviderThinkingPayload(payload, opus, "xhigh") as Record<string, unknown>;

		deepStrictEqual(patched.thinking, { type: "adaptive", display: "summarized" });
		deepStrictEqual(patched.output_config, { effort: "xhigh" });
	});

	it("patches Anthropic budget payloads with bounded token budgets", () => {
		const sonnet = engineAi.getModel("anthropic", "claude-sonnet-4-5-20250929");
		ok(sonnet, "pi-ai catalog should include claude-sonnet-4-5-20250929");
		const payload = {
			model: sonnet.id,
			messages: [],
			max_tokens: 8192,
			stream: true,
			thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
		};

		const patched = patchProviderThinkingPayload(payload, sonnet, "high") as Record<string, unknown>;

		deepStrictEqual(patched.thinking, { type: "enabled", budget_tokens: 7168, display: "summarized" });
	});
});
