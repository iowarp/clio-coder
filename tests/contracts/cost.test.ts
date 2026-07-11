import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateCostAmounts, createCostTracker, emptyCostAggregate } from "../../src/domains/observability/cost.js";
import { normalizeCostProvenance } from "../../src/domains/providers/index.js";

describe("contracts/cost provenance algebra", () => {
	it("preserves a known subtotal when another component has unknown pricing", () => {
		deepStrictEqual(
			aggregateCostAmounts([
				{ usd: 0.42, provenance: "known" },
				{ usd: 0, provenance: "unknown" },
			]),
			{ knownUsd: 0.42, hasEstimated: false, hasUnknown: true, allKnownFree: false },
		);
	});

	it("tracks estimated, unknown, and all-known-free facts independently", () => {
		deepStrictEqual(emptyCostAggregate(), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: false,
			allKnownFree: false,
		});
		deepStrictEqual(aggregateCostAmounts([{ usd: 0, provenance: "known_free" }]), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: false,
			allKnownFree: true,
		});
		deepStrictEqual(
			aggregateCostAmounts([
				{ usd: 0.12, provenance: "estimated" },
				{ usd: 0, provenance: "unknown" },
			]),
			{ knownUsd: 0.12, hasEstimated: true, hasUnknown: true, allKnownFree: false },
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
			},
		);
	});

	it("treats omitted legacy provenance as unknown, never known-free", () => {
		strictEqual(normalizeCostProvenance(undefined), "unknown");
		const tracker = createCostTracker();
		tracker.accumulate("provider", "model", 10, 0);
		deepStrictEqual(tracker.entries()[0]?.provenance, "unknown");
		deepStrictEqual(tracker.sessionCost(), {
			knownUsd: 0,
			hasEstimated: false,
			hasUnknown: true,
			allKnownFree: false,
		});
	});
});
