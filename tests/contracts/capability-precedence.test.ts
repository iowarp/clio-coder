import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { hintCapabilities, ignoredCapabilityRaises } from "../../src/domains/providers/capabilities.js";
import { EMPTY_CAPABILITIES, mergeCapabilities } from "../../src/domains/providers/index.js";
import { capabilitiesFromLiteLLMModelInfo } from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";

// Bundled catalog only, so an operator overlay on the test machine cannot change the answer.
const kb = new FileKnowledgeBase(fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url)));

describe("capability precedence", () => {
	it("a deployment that reports no image input is not vision-capable, whatever the family says", () => {
		// mini serves Qwopus3.6-35B without an mmproj; the gateway says so, the family entry says vision.
		const hit = kb.lookup("mini/qwopus3.6-35b-moe-q4km");
		strictEqual(hit?.entry.capabilities.vision, true);
		const probe = capabilitiesFromLiteLLMModelInfo({
			mode: "chat",
			supports_vision: false,
			supports_function_calling: true,
		});
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, hit.entry.capabilities, probe, null).vision, false);
	});

	it("an explicit audio false from the probe also wins", () => {
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { audio: true }, { audio: false }, null).audio, false);
	});

	it("the knowledge base still fills vision when the probe is silent", () => {
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { vision: true }, { tools: true }, null).vision, true);
	});

	it("a reported false is a report and a reported true is not repaired by the profile", () => {
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { vision: false }, { vision: true }, null).vision, true);
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { tools: true }, { tools: false }, null).tools, false);
	});

	it("an operator value fills only what the server left silent", () => {
		const declared = { vision: true, tools: true, reasoning: true };
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, declared, { vision: false }, { vision: true }).vision, false);
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, declared, { tools: true }, { vision: false }).vision, false);
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, declared, null, { reasoning: false }).reasoning, false);
	});

	it("an operator false lowers a reported true, and an operator true never raises a reported false", () => {
		const reported = { tools: true, vision: false, reasoning: true };
		const merged = mergeCapabilities(EMPTY_CAPABILITIES, null, reported, { tools: false, vision: true, reasoning: true });
		strictEqual(merged.tools, false);
		strictEqual(merged.vision, false);
		strictEqual(merged.reasoning, true);
		deepStrictEqual(ignoredCapabilityRaises(reported, { tools: false, vision: true, reasoning: true }), ["vision"]);
		deepStrictEqual(ignoredCapabilityRaises({ vision: true }, { vision: true }), []);
		deepStrictEqual(ignoredCapabilityRaises(null, { vision: true }), []);
	});

	it("an operator limit only lowers a live limit, and the profile adds no window", () => {
		const live = { contextWindow: 131_072, maxTokens: 16_384 };
		const base = { ...EMPTY_CAPABILITIES, contextWindow: 8_192 };
		const hint = hintCapabilities({ capabilities: { tools: true, contextWindow: 1_048_576, maxTokens: 65_536 } });
		strictEqual(mergeCapabilities(base, hint, live, { contextWindow: 262_144 }).contextWindow, 131_072);
		strictEqual(mergeCapabilities(base, hint, live, { contextWindow: 32_768 }).contextWindow, 32_768);
		strictEqual(mergeCapabilities(base, hint, null, { contextWindow: 262_144 }).contextWindow, 262_144);
		strictEqual(mergeCapabilities(base, hint, null, null).contextWindow, 8_192);
		strictEqual(mergeCapabilities(base, hint, live, { maxTokens: 65_536 }).maxTokens, 16_384);
		strictEqual(mergeCapabilities(base, hint, null, null).maxTokens, 0);
		const declaredCap = hintCapabilities({ capabilities: {}, modelMaxOutput: 8_192 });
		strictEqual(mergeCapabilities(base, declaredCap, null, null).maxTokens, 8_192);
		strictEqual(mergeCapabilities(base, declaredCap, live, null).maxTokens, 16_384);
	});
});
