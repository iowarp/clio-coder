import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";

import { sumFacts } from "../../src/core/telemetry/pricing.js";
import { acpUsageSums } from "../../src/engine/acp/adapter.js";

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
	const sums = acpUsageSums({ totalTokens: 0, input_tokens: 4, costUsd: 0.5 });
	deepStrictEqual(sums.totalTokens, sumFacts([{ kind: "measured", value: 0, source: "provider" }]));
	deepStrictEqual(sums.usage.input, sumFacts([{ kind: "measured", value: 4, source: "provider" }]));
	strictEqual(sums.usage.output.unknownCount, 1);
	strictEqual(sums.pricing.usd.unknownCount, 1);
	strictEqual(sums.pricing.pricedBy, "none");
	strictEqual(acpUsageSums({}).apiCalls.unknownCount, 1);
});

it("reads a Clio peer's quantities as the sums they state, keeping a partial sum's known subtotal (#434)", () => {
	const pricedBy = { provider: 0, "target-rates": 1, catalog: 1, free: 0, none: 1 };
	const sums = acpUsageSums({
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
	deepStrictEqual(sums.usage.input, sumFacts([{ kind: "measured", value: 140, source: "provider" }]));
	deepStrictEqual(sums.totalTokens, sum(150, 1));
	deepStrictEqual(sums.unmeteredCalls, sumFacts([{ kind: "measured", value: 1, source: "provider" }]));
	deepStrictEqual(sums.apiCalls, sum(3, 0));
	deepStrictEqual(sums.pricing.usd, sum(0.25, 1, 0.25));
	strictEqual(sums.pricing.pricedBy, "provider");
});
