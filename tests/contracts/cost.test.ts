import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import {
	aggregateCostAmounts,
	createCostTracker,
	emptyCostAggregate,
	formatCostAggregate,
} from "../../src/domains/observability/cost.js";
import {
	listCatalogModelsForRuntime,
	resolveCostProvenance,
	resolveEffectivePricing,
} from "../../src/domains/providers/catalog.js";
import { normalizeCostProvenance } from "../../src/domains/providers/index.js";

describe("contracts/cost provenance algebra", () => {
	it("mints provenance from the authoritative target-to-catalog fallback", () => {
		const target = { id: "target", runtime: "openai" };
		strictEqual(resolveCostProvenance({ ...target, pricing: { input: 1, output: 2 } }, "openai", "missing"), "known");
		strictEqual(
			resolveCostProvenance({ ...target, pricing: { input: 0, output: 0 } }, "openai", "missing"),
			"known_free",
		);
		deepStrictEqual(resolveEffectivePricing({ ...target, pricing: { input: 1, output: 2 } }, "openai", "missing"), {
			rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			provenance: "known",
		});
		deepStrictEqual(resolveEffectivePricing({ ...target, pricing: { input: 0, output: 0 } }, "openai", "missing"), {
			rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provenance: "known_free",
		});
		const catalogModel = listCatalogModelsForRuntime("openai").find(
			(model) => model.cost.input > 0 || model.cost.output > 0,
		);
		strictEqual(catalogModel ? resolveCostProvenance(target, "openai", catalogModel.id) : "estimated", "estimated");
		if (catalogModel) {
			deepStrictEqual(resolveEffectivePricing(target, "openai", catalogModel.id), {
				rates: {
					input: catalogModel.cost.input,
					output: catalogModel.cost.output,
					cacheRead: catalogModel.cost.cacheRead,
					cacheWrite: catalogModel.cost.cacheWrite,
				},
				provenance: "estimated",
			});
		}
		deepStrictEqual(resolveEffectivePricing(target, "openai", "definitely-not-cataloged"), {
			rates: null,
			provenance: "unknown",
		});
	});
	it("preserves a known subtotal when another component has unknown pricing", () => {
		deepStrictEqual(
			aggregateCostAmounts([
				{ usd: 0.42, provenance: "known" },
				{ usd: 0, provenance: "unknown" },
			]),
			{ knownUsd: 0.42, hasEstimated: false, hasUnknown: true, allKnownFree: false, calls: 2 },
		);
	});

	it("tracks estimated, unknown, and all-known-free facts independently", () => {
		deepStrictEqual(emptyCostAggregate(), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: false,
			allKnownFree: false,
			calls: 0,
		});
		deepStrictEqual(aggregateCostAmounts([{ usd: 0, provenance: "known_free" }]), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: false,
			allKnownFree: true,
			calls: 1,
		});
		deepStrictEqual(
			aggregateCostAmounts([
				{ usd: 0.12, provenance: "estimated" },
				{ usd: 0, provenance: "unknown" },
			]),
			{ knownUsd: 0.12, hasEstimated: true, hasUnknown: true, allKnownFree: false, calls: 2 },
		);
	});

	it("clears all-known-free when a paid component is folded", () => {
		deepStrictEqual(
			aggregateCostAmounts([
				{ usd: 0, provenance: "known_free" },
				{ usd: 0.1, provenance: "known" },
			]),
			{
				knownUsd: 0.1,
				hasEstimated: false,
				hasUnknown: false,
				allKnownFree: false,
				calls: 2,
			},
		);
	});

	it("treats omitted legacy provenance as unknown, never known-free", () => {
		strictEqual(normalizeCostProvenance(undefined), "unknown");
		const tracker = createCostTracker();
		tracker.accumulate("provider", "model", 10, 0);
		const entry = tracker.entries()[0];
		deepStrictEqual(entry?.provenance, "unknown");
		strictEqual(entry?.attributedModelId, "model");
		deepStrictEqual(entry?.requestedModelIds, ["model"]);
		deepStrictEqual(entry?.responseModelIdObservationCounts, {
			reportedCalls: 0,
			notReportedCalls: 0,
			notObservedCalls: 1,
			legacyDifferenceOnlyCalls: 0,
		});
		deepStrictEqual(tracker.sessionCost(), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: true,
			allKnownFree: false,
			calls: 1,
		});
	});

	it("formats every provenance state through one shared vocabulary", () => {
		strictEqual(formatCostAggregate(aggregateCostAmounts([{ usd: 0.42, provenance: "known" }])), "$0.42");
		strictEqual(formatCostAggregate(aggregateCostAmounts([{ usd: 0, provenance: "known_free" }])), "$0.00 local");
		strictEqual(formatCostAggregate(aggregateCostAmounts([{ usd: 0.42, provenance: "estimated" }])), "~$0.42 est");
		strictEqual(
			formatCostAggregate(
				aggregateCostAmounts([
					{ usd: 0.42, provenance: "known" },
					{ usd: 0, provenance: "unknown" },
				]),
			),
			"$0.42 +?",
		);
		// Nothing priced any of it, so there is no cost claim to render. Surfaces
		// that can drop the field drop it; a table cell substitutes
		// COST_NOT_MEASURED rather than inventing a number for its column.
		strictEqual(formatCostAggregate(aggregateCostAmounts([{ usd: 0, provenance: "unknown" }])), null);
	});
});
