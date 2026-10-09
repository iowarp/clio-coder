import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	calculatePricingCostUsd,
	getCatalogModelForRuntime,
	resolveEffectivePricing,
} from "../../src/domains/providers/catalog.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
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
	const haiku = anthropic.synthesizeModel({ id: "api", runtime: "anthropic" }, "claude-haiku-5-5", null);
	deepStrictEqual(haiku.cost, {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		tiers: [{ inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
	});
	for (const [input, expected] of [
		[92_000, { input: 0.0092, output: 0.00005, cacheRead: 0.00006, cacheWrite: 0.00025, total: 0.00956 }],
		[92_001, { input: 0.0460005, output: 0.00025, cacheRead: 0.0003, cacheWrite: 0.00125, total: 0.0478005 }],
	] as const) {
		const cost = calculateEngineCost(haiku, { ...usage, input, totalTokens: input + 8100, cost: { ...usage.cost } });
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
			ok(Math.abs(cost[field] - expected[field]) < 1e-12, `${input + 8000} prompt tokens: ${field}`);
		}
		const fallback = calculatePricingCostUsd(haiku.cost, { ...usage, input });
		ok(Math.abs(fallback - expected.total) < 1e-12);
	}
	const flatHaiku = anthropic.synthesizeModel(
		{ id: "api", runtime: "anthropic", pricing: { input: 1, output: 2 } },
		haiku.id,
		null,
	);
	deepStrictEqual(flatHaiku.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
	const pricing = resolveEffectivePricing({ id: "api", runtime: "anthropic" }, anthropic, haiku.id);
	ok(pricing.rates);
	deepStrictEqual(pricing.rates, haiku.cost);
	for (const [input, expected] of [
		[100_000, 0.01005],
		[100_001, 0.0502505],
	] as const) {
		ok(Math.abs(calculatePricingCostUsd(pricing.rates, { input, output: 100 }) - expected) < 1e-12);
	}
	const explicit = resolveEffectivePricing(
		{ id: "api", runtime: "anthropic", pricing: { input: 1, output: 2 } },
		anthropic,
		haiku.id,
	);
	ok(explicit.rates);
	strictEqual(explicit.rates.tiers, undefined);
	ok(Math.abs(calculatePricingCostUsd(explicit.rates, { input: 100_001, output: 100 }) - 0.100201) < 1e-12);
	const longWriteUsage = { ...usage, input: 92_001, cacheWrite1h: 2000, cost: { ...usage.cost } };
	ok(
		Math.abs(calculatePricingCostUsd(haiku.cost, longWriteUsage) - calculateEngineCost(haiku, longWriteUsage).total) <
			1e-12,
	);
	const sonnet = anthropic.synthesizeModel({ id: "api", runtime: "anthropic" }, "claude-sonnet-5-5", null);
	strictEqual(sonnet.cost.cacheRead, 0.1);
	const sonnetCost = calculateEngineCost(sonnet, { ...usage, input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 });
	ok(Math.abs(sonnetCost.total - 0.1) < 1e-12);
	const explicitSonnet = anthropic.synthesizeModel(
		{ id: "api", runtime: "anthropic", pricing: { input: 2, output: 10, cacheRead: 0.7 } },
		sonnet.id,
		null,
	);
	strictEqual(explicitSonnet.cost.cacheRead, 0.7);
});
