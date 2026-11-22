import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { FundingPool } from "../../src/core/funding-config.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import {
	calculatePricingCostUsd,
	compactionBudget,
	getCatalogModelForRuntime,
	resolveEffectivePricing,
} from "../../src/domains/providers/catalog.js";
import { estimateLocalEnergy } from "../../src/domains/providers/energy-accounting.js";
import type { TariffTokens } from "../../src/domains/providers/reference-tariff.js";
import { auditReferenceTariff, quoteReferenceTariff } from "../../src/domains/providers/reference-tariff.js";
import anthropic from "../../src/domains/providers/runtimes/cloud/anthropic.js";
import openai from "../../src/domains/providers/runtimes/cloud/openai.js";
import {
	periodFees,
	runEconomicsFromCalls,
	settleCallEconomics,
	splitGrantCharge,
} from "../../src/domains/telemetry/economy-settlement.js";
import { calculateEngineCost } from "../../src/engine/ai.js";
import type { Usage } from "../../src/engine/types.js";

test("local energy counts overlapping calls once and splits only the shared span", () => {
	const energy = estimateLocalEnergy({ activeWatts: 120, idleWatts: 20 }, [
		{ startMs: 20_000, endMs: 40_000 },
		{ startMs: 0, endMs: 60_000 },
	]);
	ok(energy?.perCall && energy.value !== null);
	const expected = 100 / 60_000;
	const tolerance = 1e-12;
	const [short, long] = energy.perCall;
	ok(short?.value != null && long?.value != null);
	ok(energy.value <= expected + tolerance && energy.value >= expected - tolerance);
	ok(Math.abs(short.value - expected / 6) < tolerance);
	ok(Math.abs(long.value - (expected * 5) / 6) < tolerance);
	strictEqual(energy.cost.value, null);
});

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
	deepStrictEqual(priced.cost, { input: 1, output: 2, cacheRead: 1, cacheWrite: 0 });
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
	deepStrictEqual(flatHaiku.cost, { input: 1, output: 2, cacheRead: 1, cacheWrite: 0 });
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
	strictEqual(explicit.rates.cacheRead, 1, "an unpriced cache read bills at the input price");
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

test("economic compaction honors catalog tiers, flat-row fallbacks, and smaller real windows", () => {
	for (const [runtime, id, maxTokens, expected] of [
		["anthropic", "claude-haiku-5-5", 200_000, 98_000],
		["openai-codex", "gpt-6-luna", 200_000, 200_000],
		["openai", "gpt-6.1-sol", 400_000, 266_560],
	] as const) {
		const model = getCatalogModelForRuntime(runtime, id);
		ok(model);
		for (const row of [model, { ...model, cost: { ...model.cost, tiers: [] } }]) {
			const budget = compactionBudget(1_000_000, 0.8, maxTokens, row);
			strictEqual(budget.ceilingTokens, expected);
			ok(Math.abs(budget.threshold * 1_000_000 - expected) < 1e-9);
			ok(0.6 * budget.budgetWindow < expected, "eviction target stays below the trigger");
		}
	}
	const wide = compactionBudget(1_000_000, 0.8);
	strictEqual(wide.ceilingTokens, 400_000);
	strictEqual(wide.threshold * 1_000_000, 400_000);
	const small = compactionBudget(32_000, 0.8);
	strictEqual(small.threshold, 0.8);
	strictEqual(small.budgetWindow, 32_000);
	const incident = compactionBudget(500_000, 0.87, 200_000, getCatalogModelForRuntime("openai-codex", "gpt-6.1-sol"));
	strictEqual(incident.threshold * 500_000, 200_000);
	strictEqual(incident.budgetWindow * 0.6, 120_000);
	strictEqual(incident.budgetWindow * 0.1, 20_000);
});

test("reference tariff quotes the dated list price per request and refuses what it cannot price", () => {
	deepStrictEqual(auditReferenceTariff("2026-11-22").errors, []);
	const witness: TariffTokens = { fresh: 0, read: 45_000, write: { "30m": 5_000 }, output: 2_000 };
	const usd = (tokens: TariffTokens, day = "2026-11-22", model = "gpt-6-luna", scenario?: string) => {
		const quote = quoteReferenceTariff(model, day, tokens, scenario !== undefined ? { scenario } : {});
		return quote.kind === "quoted" ? [quote.usd, quote.tier, quote.basis, quote.effectiveFrom] : quote.kind;
	};
	deepStrictEqual(usd(witness), [0.002075, "base", "effective", "2026-11-22"]);
	deepStrictEqual(usd({ ...witness, fresh: 222_000 }), [0.024275, "base", "effective", "2026-11-22"]);
	deepStrictEqual(usd({ ...witness, fresh: 222_001 }), [0.0480502, "prompt>272000", "effective", "2026-11-22"]);
	deepStrictEqual(usd({ ...witness, write: { unknown: 5_000 } }), "unknown", "30m and 12h write rates differ");
	const carbon: TariffTokens = { fresh: 5_000, read: 45_000, write: {}, output: 2_000 };
	const promo = "gemini-4-carbon-introductory";
	deepStrictEqual(usd(carbon, "2026-11-30", "gemini-4-carbon"), [0.069, "base", "announced-list", "2026-12-01"]);
	deepStrictEqual(usd(carbon, "2026-11-21", "gemini-4-carbon"), "unknown", "no promotion bridges to the list row");
	deepStrictEqual(usd(carbon, "2026-11-30", "gemini-4-carbon", promo), [0.0345, "base", "effective", "2026-11-22"]);
	deepStrictEqual(usd(carbon, "2026-12-01", "gemini-4-carbon"), [0.069, "base", "effective", "2026-12-01"]);
	deepStrictEqual(usd(carbon, "2026-12-01", "gemini-4-carbon", promo), "unknown");
	deepStrictEqual(usd(witness, "2026-11-22", "gpt-6.2-terra"), "unknown");
	deepStrictEqual(usd(witness, "2026-11-31"), "unknown", "an invalid calendar day never rolls into December");
	deepStrictEqual(usd(witness, "2026-11-31T10:00:00Z"), "unknown");
	deepStrictEqual(usd({ ...witness, write: { toString: 5_000 } }), "unknown", "an inherited name is no retention");
	const early = auditReferenceTariff("2026-11-21").errors;
	const models = new Set(auditReferenceTariff("2026-11-22").rows.map((row) => row.model));
	deepStrictEqual(
		early,
		[...models].map((model) => {
			const starts = model === "gemini-4-carbon" ? "2026-12-01" : "2026-11-22";
			return `${model}: future-only on 2026-11-21; standard list price starts ${starts}`;
		}),
	);
	deepStrictEqual(auditReferenceTariff("2026-11-30").errors, [], "the Carbon promotion bridges to its announced row");
});

test("a seat call and an API call share one list-price equivalent and differ only in what the user pays (S8)", () => {
	const measured = (value: number) => ({ kind: "measured", value, source: "provider" }) as const;
	const at = new Date("2026-11-22T12:00:00Z");
	const call = (requestedModel: string, economics?: CallSettled["economics"]) =>
		({
			disposition: "settled",
			usage: {
				input: measured(0),
				output: measured(2_000),
				cacheRead: measured(45_000),
				cacheWrite: measured(5_000),
				cacheWrite1h: measured(0),
				reasoning: measured(0),
			},
			pricing: { usd: { kind: "unknown", reason: "not-observed" }, pricedBy: "none" },
			target: { requestedModel, reportedModel: { kind: "unknown", reason: "provider-omitted" } },
			...(economics ? { economics } : {}),
		}) as unknown as CallSettled;
	const seatPool: FundingPool = {
		scheme: "declared",
		payer: "personal",
		fee: { amount: 39, currency: "USD", period: "month" },
	};
	const seat = {
		prices: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 8 },
		batchSize: 1_000_000,
		promo: { discountPercent: 50, endsAt: "2026-12-01T00:00:00Z" },
		readAt: "2026-11-22T11:59:00Z",
	};
	const onSeat = settleCallEconomics(call("gpt-6-luna"), at, {
		funding: { status: "declared", poolId: "copilot", pool: seatPool },
		runtime: { id: "copilot-sdk", tier: "subscription" },
		cacheWriteRetention: "30m",
		seat,
	});
	const charge = { currency: "USD", amount: measured(0.0021) };
	const empty = { kind: "absent", reason: "not-applicable" } as const;
	const reported = {
		additive: {
			providerCharge: charge,
			marginalCharge: { amount: empty },
			seatCredits: { nanoAiu: empty },
			energy: { kwh: empty, cost: { amount: empty } },
		},
		comparison: { apiEquivalent: { amount: empty } },
		funding: empty,
	};
	const onApi = settleCallEconomics(call("gpt-6-luna", reported), at, {
		funding: { status: "declared", poolId: "api", pool: { scheme: "declared", payer: "personal" } },
		runtime: { id: "openai", tier: "cloud" },
		cacheWriteRetention: "30m",
	});
	strictEqual(
		onSeat.comparison.apiEquivalent.amount.kind === "estimated" && onSeat.comparison.apiEquivalent.amount.value,
		0.002075,
	);
	deepStrictEqual(onApi.comparison.apiEquivalent, onSeat.comparison.apiEquivalent);
	strictEqual(
		"referenceRowId" in onSeat.comparison.apiEquivalent && onSeat.comparison.apiEquivalent.referenceRowId,
		"openai/gpt-6-luna@2026-11-22",
	);
	deepStrictEqual(onSeat.additive.marginalCharge, {
		currency: "USD",
		amount: { kind: "estimated", value: 0, method: "plan-coverage" },
	});
	deepStrictEqual(onSeat.additive.seatCredits, {
		nanoAiu: { kind: "estimated", value: 13_375_000, method: "seat-listing-tariff" },
		listingAsOf: "2026-11-22T11:59:00.000Z",
	});
	deepStrictEqual(onApi.additive.marginalCharge, charge, "only a provider-asserted charge reads as actual");
	deepStrictEqual(onApi.additive.seatCredits.nanoAiu, empty);
	const noFee = settleCallEconomics(call("gpt-6-luna"), new Date("2026-12-02T00:00:00Z"), {
		funding: { status: "declared", poolId: "copilot", pool: { scheme: "declared", payer: "personal" } },
		runtime: { id: "copilot-sdk", tier: "subscription" },
		cacheWriteRetention: "30m",
		seat,
	});
	deepStrictEqual(
		noFee.additive.marginalCharge,
		{ amount: { kind: "unknown", reason: "not-observed" } },
		"extra unknown, never zero",
	);
	strictEqual(
		noFee.additive.seatCredits.nanoAiu.kind === "estimated" && noFee.additive.seatCredits.nanoAiu.value,
		26_750_000,
	);
	const longWrite = (fact: unknown) => {
		const base = call("gpt-6-luna");
		return { ...base, usage: { ...base.usage, cacheWrite1h: fact } } as unknown as CallSettled;
	};
	const seatInputs = {
		funding: { status: "declared", poolId: "copilot", pool: seatPool },
		runtime: { id: "copilot-sdk", tier: "subscription" },
		cacheWriteRetention: "30m",
		seat,
	} as const;
	deepStrictEqual(
		settleCallEconomics(longWrite({ kind: "unknown", reason: "provider-omitted" }), at, seatInputs),
		onSeat,
		"a runtime that never reports the 1h subset splits none out",
	);
	deepStrictEqual(
		settleCallEconomics(longWrite(measured(6_000)), at, seatInputs).comparison.apiEquivalent.amount,
		{ kind: "unknown", reason: "not-observed" },
		"cacheWrite includes its 1h subset, so a larger subset is invalid",
	);
	const idleless = settleCallEconomics(call("gpt-6-luna"), at, {
		funding: {
			status: "declared",
			poolId: "box",
			pool: { scheme: "declared", payer: "personal", local: { activeWatts: 300 } },
		},
		runtime: { id: "llamacpp", tier: "local-native" },
		cacheWriteRetention: "unknown",
		energyIntervals: [{ startMs: 0, endMs: 3_600_000 }],
	});
	deepStrictEqual(idleless.additive.energy.kwh, { kind: "unknown", reason: "not-observed" }, "no idle baseline, no kWh");
	const run = runEconomicsFromCalls([onSeat, onApi], { kind: "absent", reason: "not-applicable" });
	ok(run.comparison.apiEquivalent.amount.kind === "estimated");
	ok(Math.abs(run.comparison.apiEquivalent.amount.value - 0.00415) < 1e-12);
	ok(Array.isArray(run.funding) && run.funding.length === 2);
	const split = splitGrantCharge({ currency: "USD", amount: 0.3 }, 0.1);
	ok(split.sponsor.amount.kind === "estimated" && split.personal.amount.kind === "estimated");
	deepStrictEqual([split.sponsor.amount.value, split.personal.amount.value], [0.1, 0.2]);
	strictEqual(Math.round(split.sponsor.amount.value * 1e9) + Math.round(split.personal.amount.value * 1e9), 300_000_000);
	const fees = periodFees(
		{
			copilot: seatPool,
			once: { scheme: "declared", payer: "personal", fee: { amount: 5, currency: "USD", period: "one-time" } },
		},
		{ start: new Date("2026-11-20T00:00:00Z"), end: new Date("2026-12-02T00:00:00Z") },
	);
	deepStrictEqual(
		fees.map((fee) => [fee.poolId, fee.amount, fee.period.start]),
		[
			["copilot", 39, "2026-11-01T00:00:00.000Z"],
			["copilot", 39, "2026-12-01T00:00:00.000Z"],
		],
		"a period fee stands once per pool and period, with or without calls",
	);
});
