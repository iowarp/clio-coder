import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeCapabilities } from "../../../src/domains/providers/capabilities.js";
import type { CapabilityFlags } from "../../../src/domains/providers/types/capability-flags.js";
import {
	availableThinkingLevels,
	EMPTY_CAPABILITIES,
	VALID_THINKING_LEVELS,
} from "../../../src/domains/providers/types/capability-flags.js";

function base(overrides: Partial<CapabilityFlags> = {}): CapabilityFlags {
	return { ...EMPTY_CAPABILITIES, chat: true, ...overrides };
}

describe("providers/capabilities mergeCapabilities", () => {
	it("precedence is userOverride > probe > kb > base", () => {
		const merged = mergeCapabilities(
			base({ contextWindow: 4096 }),
			{ contextWindow: 8192, tools: true },
			{ contextWindow: 16384, reasoning: true },
			{ contextWindow: 32768 },
		);
		strictEqual(merged.contextWindow, 32768);
		strictEqual(merged.tools, true);
		strictEqual(merged.reasoning, true);
		strictEqual(merged.chat, true);
	});

	it("ignores undefined keys so a layer can be partial without blanking prior layers", () => {
		const partialOverride: Partial<CapabilityFlags> = {};
		const merged = mergeCapabilities(base({ vision: false }), { vision: true }, null, partialOverride);
		strictEqual(merged.vision, true);
	});

	it("accepts null for any non-base layer (kb/probe/override optional)", () => {
		const merged = mergeCapabilities(base({ tools: false }), null, null, null);
		strictEqual(merged.tools, false);
		strictEqual(merged.chat, true);
	});

	it("probe overrides kb but not userOverride", () => {
		const merged = mergeCapabilities(
			base({ maxTokens: 1024 }),
			{ maxTokens: 2048 },
			{ maxTokens: 4096 },
			{ maxTokens: 512 },
		);
		strictEqual(merged.maxTokens, 512);
	});
});

describe("providers/capabilities EMPTY_CAPABILITIES", () => {
	it("is a valid CapabilityFlags base (every boolean false, numeric fields zero)", () => {
		strictEqual(EMPTY_CAPABILITIES.chat, false);
		strictEqual(EMPTY_CAPABILITIES.tools, false);
		strictEqual(EMPTY_CAPABILITIES.reasoning, false);
		strictEqual(EMPTY_CAPABILITIES.vision, false);
		strictEqual(EMPTY_CAPABILITIES.audio, false);
		strictEqual(EMPTY_CAPABILITIES.embeddings, false);
		strictEqual(EMPTY_CAPABILITIES.rerank, false);
		strictEqual(EMPTY_CAPABILITIES.fim, false);
		strictEqual(EMPTY_CAPABILITIES.contextWindow, 0);
		strictEqual(EMPTY_CAPABILITIES.maxTokens, 0);
	});

	it("does not carry the optional format fields so mergeCapabilities can layer them in", () => {
		const keys = Object.keys(EMPTY_CAPABILITIES);
		ok(!keys.includes("toolCallFormat"));
		ok(!keys.includes("thinkingFormat"));
		ok(!keys.includes("structuredOutputs"));
	});
});

describe("providers/capabilities availableThinkingLevels", () => {
	it("reasoning=false collapses the list to ['off']", () => {
		const levels = availableThinkingLevels(base({ reasoning: false }));
		deepStrictEqual(Array.from(levels), ["off"]);
	});

	it("anthropic-extended includes 'xhigh' at the tail", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "anthropic-extended" }));
		deepStrictEqual(Array.from(levels), [...VALID_THINKING_LEVELS]);
		ok(levels.includes("xhigh"));
	});

	it("openai-codex gpt-5.4 omits minimal but keeps xhigh", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "openai-codex" }), {
			runtimeId: "openai-codex",
			modelId: "gpt-5.4",
		});
		deepStrictEqual(Array.from(levels), ["off", "low", "medium", "high", "xhigh"]);
	});

	it("openai-codex gpt-5.1-codex-mini only offers medium/high", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "openai-codex" }), {
			runtimeId: "openai-codex",
			modelId: "gpt-5.1-codex-mini",
		});
		deepStrictEqual(Array.from(levels), ["off", "medium", "high"]);
	});

	it("non-anthropic thinking format omits 'xhigh'", () => {
		const levels = availableThinkingLevels(base({ reasoning: true, thinkingFormat: "qwen-chat-template" }));
		ok(levels.includes("high"));
		ok(!levels.includes("xhigh"));
	});

	it("VALID_THINKING_LEVELS is a 6-element readonly tuple", () => {
		strictEqual(VALID_THINKING_LEVELS.length, 6);
		deepStrictEqual(Array.from(VALID_THINKING_LEVELS), ["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
});
