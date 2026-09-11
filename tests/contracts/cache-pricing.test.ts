import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { getCatalogModelForRuntime } from "../../src/domains/providers/catalog.js";
import openai from "../../src/domains/providers/runtimes/cloud/openai.js";
import { calculateEngineCost } from "../../src/engine/ai.js";
import type { Usage } from "../../src/engine/types.js";

test("catalog synthesis preserves SDK context price tiers and explicit target prices replace them", () => {
	const catalog = getCatalogModelForRuntime("openai", "gpt-5.4");
	ok(catalog?.cost.tiers?.length);
	const target = { id: "api", runtime: "openai" };
	const model = openai.synthesizeModel(target, catalog.id, null);
	const tier = catalog.cost.tiers[0];
	ok(tier);
	const usage: Usage = {
		input: tier.inputTokensAbove + 1,
		output: 100,
		cacheRead: 6000,
		cacheWrite: 2000,
		totalTokens: tier.inputTokensAbove + 8101,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	deepStrictEqual(
		calculateEngineCost(model, structuredClone(usage)),
		calculateEngineCost(catalog, structuredClone(usage)),
	);
	const priced = openai.synthesizeModel({ ...target, pricing: { input: 1, output: 2 } }, catalog.id, null);
	strictEqual(priced.cost.tiers, undefined, "an operator flat rate must not inherit unrelated catalog tiers");
	deepStrictEqual(priced.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});
