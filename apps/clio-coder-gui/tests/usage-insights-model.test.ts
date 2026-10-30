import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attributedCalls,
	usageAmountText,
	usageCallShares,
	usageModelInsights,
} from "../client/pages/usage-insights-model.js";
import type { UsageReport } from "../contracts/reports.js";

const report = (facts: UsageReport["facts"]): UsageReport => ({
	schema: "experimental",
	workspaceId: "0".repeat(32),
	windowDays: 30,
	from: "2026-10-01",
	to: "2026-10-30",
	facts,
	opportunities: [],
});

test("a model's session calls and worker receipts stay two rows, never one client-side sum (#434)", () => {
	const models = usageModelInsights(
		report([
			{ name: "tokens", values: { apiCalls: 12, totalTokens: 900 } },
			{
				name: "model-usage",
				values: { providerId: "anthropic", attributedModelId: "sonnet", apiCalls: 8, totalTokens: 600 },
			},
			{ name: "worker-model-usage", values: { targetId: "anthropic", modelId: "sonnet", apiCalls: 4, totalTokens: 300 } },
		]),
	);
	assert.deepEqual(
		models.map((row) => [row.sources[0], row.calls.value, row.tokens.value]),
		[
			["Session & side calls", 8, 600],
			["Worker receipts", 4, 300],
		],
	);
	assert.equal(
		usageAmountText(
			models[0]?.tokens ?? { value: null, partial: false, estimated: false, label: "", display: null },
			"tokens",
		),
		"600",
	);
	// A partial count is named by its label; the client appends no marker of its own.
	assert.equal(
		usageAmountText(
			{ value: 600, partial: true, estimated: false, label: "Known subtotal · missing usage", display: null },
			"tokens",
		),
		"600",
	);
});

test("call shares use the report's own attributed total, and stay absent without it or with an unknown row", () => {
	const facts: UsageReport["facts"] = [
		{ name: "model-usage", values: { providerId: "a", attributedModelId: "big", apiCalls: 9 } },
		{ name: "model-usage", values: { providerId: "a", attributedModelId: "small", apiCalls: 3 } },
	];
	const models = usageModelInsights(report(facts));
	assert.equal(usageCallShares(models, attributedCalls(report(facts))), null, "no attributed total in the report");
	const shares = usageCallShares(
		models,
		attributedCalls(report([{ name: "tokens", values: { apiCalls: 12 } }, ...facts])),
	);
	assert.equal(shares?.total, 12);
	assert.deepEqual(
		shares?.segments.map((segment) => [segment.model, segment.share]),
		[
			["big", 0.75],
			["small", 0.25],
		],
	);
	const unknown = usageModelInsights(
		report([...facts, { name: "model-usage", values: { providerId: "a", attributedModelId: "odd" } }]),
	);
	assert.equal(usageCallShares(unknown, 12), null, "a row without a count makes no share");
});
