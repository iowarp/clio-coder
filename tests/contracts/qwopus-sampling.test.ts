import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyModelCapabilityPatch } from "../../src/domains/providers/model-capabilities.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import type { LocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { pickSamplingProfile, samplingParamsFromProfile } from "../../src/engine/apis/sampling-overrides.js";
import type { Model } from "../../src/engine/types.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";

// Bundled catalog only, so an operator overlay on the test machine cannot change the answer.
const kb = new FileKnowledgeBase(fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url)));

// The quirks the openai-completions API reads at request time, as the LiteLLM runtime attaches them.
function quirksOf(id: string): LocalModelQuirks | undefined {
	const hit = kb.lookup(id);
	ok(hit, `${id} resolves to no family`);
	const model = litellm.synthesizeModel({ id: "blade", runtime: "litellm", url: "http://127.0.0.1:9" }, id, hit);
	return (model as { clioCoder?: { quirks?: LocalModelQuirks } }).clioCoder?.quirks;
}

// Jackrong's cards for the served Qwopus builds state no sampler of their own, so each
// Qwopus family samples like the Qwen family it was tuned from, in both thinking modes.
describe("Qwopus samples like its Qwen base", () => {
	const qwen38 = quirksOf("dynamo/qwen3.8-27b");
	const qwen36 = quirksOf("qwen3.6-27b");
	it("the Qwen reference families carry both samplers", () => {
		for (const quirks of [qwen38, qwen36]) {
			ok(quirks?.sampling?.thinking);
			ok(quirks?.sampling?.instruct);
		}
	});
	for (const route of [
		"dynamo/qwopus3.8-27b-flash@q4_k_m",
		"dynamo/qwopus3.8-27b-flash@q5_k_m",
		"mini/qwopus3.8-27b-dense-q4km",
		"mini/qwopus3.8-27b-dense-q6k",
		"zbook-lemonade/Qwopus3.8-27B-Flash-MTP-Q4_K_M",
	]) {
		it(`${route} uses the Qwen3.8 thinking and non-thinking samplers`, () => {
			strictEqual(kb.lookup(route)?.entry.family, "qwopus3.8-27b-dense");
			const quirks = quirksOf(route);
			deepStrictEqual(pickSamplingProfile(quirks, true), pickSamplingProfile(qwen38, true));
			deepStrictEqual(pickSamplingProfile(quirks, false), pickSamplingProfile(qwen38, false));
		});
	}

	for (const route of [
		"dynamo/qwopus3.6-27b-coder-mtp",
		"dynamo/qwopus3.6-35b-a3b-coder-mtp",
		"mini/qwopus3.6-35b-moe-q4km",
	]) {
		it(`${route} uses the Qwen3.6 thinking and non-thinking samplers`, () => {
			const quirks = quirksOf(route);
			deepStrictEqual(pickSamplingProfile(quirks, true), pickSamplingProfile(qwen36, true));
			deepStrictEqual(pickSamplingProfile(quirks, false), pickSamplingProfile(qwen36, false));
		});
	}

	it("thinking on and off send different samplers on the wire", () => {
		const quirks = quirksOf("dynamo/qwopus3.8-27b-flash@q4_k_m");
		const thinking = pickSamplingProfile(quirks, true);
		const instruct = pickSamplingProfile(quirks, false);
		ok(thinking && instruct);
		strictEqual(thinking.temperature, 1.0);
		strictEqual(instruct.temperature, 0.7);
		deepStrictEqual(samplingParamsFromProfile(thinking, "litellm"), {
			top_p: 0.95,
			top_k: 20,
			min_p: 0,
			repeat_penalty: 1.0,
			presence_penalty: 0,
		});
		deepStrictEqual(samplingParamsFromProfile(instruct, "litellm"), {
			top_p: 0.8,
			top_k: 20,
			min_p: 0,
			repeat_penalty: 1.0,
			presence_penalty: 1.5,
		});
	});

	it("the request body carries every sampler field, repeat_penalty included, in both modes", async () => {
		// The catalog spells it repetitionPenalty; the wire must still say repeat_penalty.
		const modelId = "dynamo/qwopus3.8-27b-flash@q4_k_m";
		const fixture = await startGatewayThinkingFixture("lm-studio", modelId);
		try {
			const target = { id: "blade", runtime: "litellm", url: fixture.url, defaultModel: modelId };
			const probe = await litellm.probe?.(target, { credentialsPresent: new Set(), httpTimeoutMs: 1000 });
			ok(probe?.ok);
			const model = applyModelCapabilityPatch(
				litellm.synthesizeModel(target, modelId, kb.lookup(modelId)),
				probe.modelCapabilities?.[modelId],
			) as Model<"openai-completions">;
			for (const [level, expected] of [
				["off", { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 }],
				["low", { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }],
			] as const) {
				await openAICompletionsApiProvider
					.streamSimple(
						model,
						{ messages: [{ role: "user", content: "17 times 19", timestamp: 0 }] },
						{ apiKey: "fixture", ...(level === "off" ? {} : { reasoning: level }) },
					)
					.result();
				const request = fixture.requests.at(-1);
				ok(request);
				for (const [key, value] of Object.entries(expected)) strictEqual(request[key], value, `${level}: ${key}`);
			}
		} finally {
			await fixture.close();
		}
	});
});
