/**
 * The telemetry projection's run summary and the interactive dispatch board derive a run's terminal status from the
 * same DispatchCompleted/DispatchFailed bus payloads through resolveDispatchFailureStatus, the one shared definition,
 * and a target's pricer through resolveEffectivePricing, so no two surfaces disagree on the same run.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { resolveDispatchFailureStatus } from "../../src/core/dispatch-outcome.js";
import { resolveEffectivePricing } from "../../src/domains/providers/catalog.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";

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

describe("resolveEffectivePricing", () => {
	it("prices every unpriced model on a free-declared proxy target as free", () => {
		const { settings, issues } = validateSettings({
			version: 2,
			targets: [{ id: "proxy", runtime: "litellm", pricing: "free" }],
		});
		deepStrictEqual(issues, []);
		const target = settings.targets[0];
		ok(target);
		strictEqual(target.pricing, "free");
		for (const modelId of ["dynamo/qwopus3.8-27b-flash@q5_k_m", "another-model"]) {
			const pricing = resolveEffectivePricing(target, litellm, modelId);
			deepStrictEqual(pricing, {
				rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				pricedBy: "free",
			});
			deepStrictEqual(litellm.synthesizeModel(target, modelId, null).cost, pricing.rates);
		}
	});

	it("leaves an undeclared proxy unknown and honors explicit rates", () => {
		const target = { id: "proxy", runtime: "litellm" };
		const modelId = "dynamo/qwopus3.8-27b-flash@q5_k_m";
		deepStrictEqual(resolveEffectivePricing(target, litellm, modelId), { rates: null, pricedBy: "none" });
		const priced = { ...target, pricing: { input: 1, output: 2 } };
		const pricing = resolveEffectivePricing(priced, litellm, modelId);
		deepStrictEqual(pricing, {
			rates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			pricedBy: "target-rates",
		});
		deepStrictEqual(litellm.synthesizeModel(priced, modelId, null).cost, pricing.rates);
	});

	it("prices an unpriced local-native runtime as free and leaves an unpriced proxy unknown", () => {
		const target = (runtime: string) => ({ id: "t", runtime, defaultModel: "qwen" });
		const local = resolveEffectivePricing(target("lmstudio"), { id: "lmstudio", tier: "local-native" }, "qwen");
		strictEqual(local.pricedBy, "free");
		deepStrictEqual(local.rates, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		strictEqual(resolveEffectivePricing(target("litellm"), { id: "litellm", tier: "protocol" }, "qwen").pricedBy, "none");
		const priced = { ...target("litellm"), pricing: { input: 1, output: 2 } };
		strictEqual(resolveEffectivePricing(priced, { id: "litellm", tier: "protocol" }, "qwen").pricedBy, "target-rates");
	});
});
