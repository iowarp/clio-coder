/**
 * The observability projection's run summary and the interactive dispatch
 * board each derived a run's terminal status and cost provenance from the
 * same DispatchCompleted/DispatchFailed bus payloads through their own,
 * independently-maintained copies of the mapping. resolveDispatchFailureStatus
 * and resolveCostProvenance are now the one shared definition each side
 * imports, so the two surfaces cannot silently disagree on the same run.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDispatchFailureStatus } from "../../src/core/dispatch-outcome.js";
import { resolveEffectivePricing } from "../../src/domains/providers/catalog.js";
import { resolveCostProvenance } from "../../src/domains/providers/types/cost-provenance.js";

describe("resolveDispatchFailureStatus", () => {
	it("maps dead and stalled to dead", () => {
		strictEqual(resolveDispatchFailureStatus("dead"), "dead");
		strictEqual(resolveDispatchFailureStatus("stalled"), "dead");
	});

	it("maps interrupted and canceled to aborted", () => {
		strictEqual(resolveDispatchFailureStatus("interrupted"), "aborted");
		strictEqual(resolveDispatchFailureStatus("canceled"), "aborted");
	});

	it("defaults every other reason, including absent or malformed, to failed", () => {
		strictEqual(resolveDispatchFailureStatus("timed_out"), "failed");
		strictEqual(resolveDispatchFailureStatus(undefined), "failed");
		strictEqual(resolveDispatchFailureStatus(null), "failed");
		strictEqual(resolveDispatchFailureStatus(42), "failed");
	});
});

describe("resolveCostProvenance", () => {
	it("accepts every real provenance value", () => {
		strictEqual(resolveCostProvenance("known", "unknown"), "known");
		strictEqual(resolveCostProvenance("known_free", "unknown"), "known_free");
		strictEqual(resolveCostProvenance("estimated", "unknown"), "estimated");
		strictEqual(resolveCostProvenance("unknown", "known"), "unknown");
	});

	it('falls back rather than accepting a value outside the closed set, unlike the dispatch board\'s prior payload.costProvenance ?? "unknown"', () => {
		strictEqual(resolveCostProvenance("not-a-real-provenance", "estimated"), "estimated");
		strictEqual(resolveCostProvenance(undefined, "known"), "known");
		strictEqual(resolveCostProvenance(null, "known"), "known");
		strictEqual(resolveCostProvenance(42, "known"), "known");
	});
});

describe("resolveEffectivePricing", () => {
	it("prices an unpriced local-native runtime as free and leaves an unpriced proxy unknown", () => {
		const target = (runtime: string) => ({ id: "t", runtime, defaultModel: "qwen" });
		const local = resolveEffectivePricing(target("lmstudio"), { id: "lmstudio", tier: "local-native" }, "qwen");
		strictEqual(local.provenance, "known_free");
		deepStrictEqual(local.rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		strictEqual(
			resolveEffectivePricing(target("litellm"), { id: "litellm", tier: "protocol" }, "qwen").provenance,
			"unknown",
		);
		const priced = { ...target("litellm"), pricing: { input: 1, output: 2 } };
		strictEqual(resolveEffectivePricing(priced, { id: "litellm", tier: "protocol" }, "qwen").provenance, "known");
	});
});
