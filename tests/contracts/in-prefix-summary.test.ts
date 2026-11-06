/** In-prefix compaction admission (A8): which routes may summarize inside the cached request prefix, and at what cost. */
import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type MainRequestRecord, prepareInPrefixSummary } from "../../src/engine/in-prefix-summary.js";
import type { EngineModel } from "../../src/engine/types.js";

function model(api: string, overrides: Partial<EngineModel> = {}): EngineModel {
	return {
		id: "fixture",
		name: "fixture",
		api,
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 8_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as EngineModel;
}

const history: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }];

function agent(m: EngineModel): Agent {
	return {
		state: { model: m, messages: history },
		convertToLlm: async (messages: Message[]) => messages,
	} as unknown as Agent;
}

function record(m: EngineModel, cachedTokens: number | null): MainRequestRecord {
	return {
		request: { model: m, context: { messages: history }, options: {} },
		sentAt: 1_000,
		promptTokens: 20_000,
		cachedTokens,
	};
}

test("a slot cache is trusted only on an unpriced route whose last request reused a prefix", async () => {
	const slot = model("openai-completions", { provider: "litellm" });
	const admitted = await prepareInPrefixSummary(agent(slot), record(slot, 18_432), undefined, 2_000);
	ok(typeof admitted === "object");
	// Prefill bills nothing for cached tokens, but up to one checkpoint of them is prefilled again.
	const tailCost = admitted.inputCost("") - 4096;
	ok(tailCost > 0 && tailCost < 100);
	strictEqual(await prepareInPrefixSummary(agent(slot), record(slot, 0), undefined, 2_000), "no-cache-reuse");
	const pricedSlot = model("openai-completions", { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
	strictEqual(
		await prepareInPrefixSummary(agent(pricedSlot), record(pricedSlot, 18_432), undefined, 2_000),
		"lifetime-unknown",
	);
});

test("OpenAI Responses prices the cached prefix from the catalog and expires with the hosted lifetime", async () => {
	const responses = model("openai-responses", { cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 } });
	const admitted = await prepareInPrefixSummary(agent(responses), record(responses, 0), undefined, 2_000);
	ok(typeof admitted === "object");
	const tailCost = admitted.inputCost("") - 0.1 * 20_000;
	ok(tailCost > 0 && tailCost < 100);
	strictEqual(
		await prepareInPrefixSummary(agent(responses), record(responses, 0), undefined, 1_000 + 300_000),
		"expired",
	);
	const google = model("google-generative-ai");
	strictEqual(await prepareInPrefixSummary(agent(google), record(google, 0), undefined, 2_000), "unsupported-api");
});
