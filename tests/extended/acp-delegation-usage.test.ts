import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";

import { acpUsageFacts } from "../../src/engine/acp/adapter.js";

const quantity = (metric: string, fact: unknown) => ({ fact, display: "-", ref: `session:peer#${metric}` });
const measured = (value: number) => ({ kind: "measured", value, source: "provider" });
const sum = (measuredPart: number, unknownCount: number, estimated = 0) => ({
	measured: measuredPart,
	estimated,
	unknownCount,
	absentCount: 0,
	coverage: { measured: measuredPart > 0 ? 1 : 0, estimated: estimated > 0 ? 1 : 0, unknown: unknownCount },
});

it("reads another agent's plain counts as measured tokens it put no price on", () => {
	const facts = acpUsageFacts({ totalTokens: 0, input_tokens: 4, costUsd: 0.5 });
	deepStrictEqual(facts.totalTokens, { kind: "measured", value: 0, source: "provider" });
	deepStrictEqual(facts.usage.input, { kind: "measured", value: 4, source: "provider" });
	strictEqual(facts.usage.output.kind, "unknown");
	strictEqual(facts.pricing.usd.kind, "unknown");
	strictEqual(facts.pricing.pricedBy, "none");
	strictEqual(acpUsageFacts({}).apiCalls.kind, "unknown");
});

it("reads a Clio peer's quantities as the facts they state, its partial sums as unknown (#434)", () => {
	const pricedBy = { provider: 0, "target-rates": 1, catalog: 1, free: 0, none: 1 };
	const facts = acpUsageFacts({
		session: {
			quantities: {
				input: quantity("input", measured(140)),
				output: quantity("output", measured(10)),
				cacheRead: quantity("cacheRead", measured(0)),
				cacheWrite: quantity("cacheWrite", measured(0)),
				reasoning: quantity("reasoning", measured(0)),
				total: quantity("total", sum(150, 1)),
				usd: quantity("usd", sum(0.25, 1, 0.25)),
				calls: quantity("calls", sum(3, 0)),
			},
			pricedBy,
		},
	});
	deepStrictEqual(facts.usage.input, { kind: "measured", value: 140, source: "provider" });
	strictEqual(facts.totalTokens.kind, "unknown");
	deepStrictEqual(facts.missingTokenCalls, { kind: "measured", value: 1, source: "provider" });
	deepStrictEqual(facts.apiCalls, { kind: "measured", value: 3, source: "local-count" });
	strictEqual(facts.pricing.usd.kind, "unknown");
	strictEqual(facts.pricingCoverage, "partial");
	strictEqual(facts.callCountCoverage, "complete");
});
