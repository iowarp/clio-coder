import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

	it("the knowledge base still corrects a probe that over-claims", () => {
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { vision: false }, { vision: true }, null).vision, false);
		strictEqual(mergeCapabilities(EMPTY_CAPABILITIES, { tools: true }, { tools: false }, null).tools, true);
	});

	it("a target-level override outranks the deployment", () => {
		strictEqual(
			mergeCapabilities(EMPTY_CAPABILITIES, { vision: true }, { vision: false }, { vision: true }).vision,
			true,
		);
	});
});
