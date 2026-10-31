import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attributedCalls,
	usageAmountText,
	usageCacheEvidence,
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

const quantity = (display: string, measured: number, unknownCount = 0) => ({
	fact: {
		measured,
		estimated: 0,
		unknownCount,
		absentCount: 0,
		coverage: { measured: 1, estimated: 0, unknown: unknownCount },
	},
	display,
	ref: "repo:all-30d#calls",
});
const pricedBy = { provider: 0, "target-rates": 1, catalog: 0, free: 0, none: 0 };
const group = (key: string, calls: ReturnType<typeof quantity>, tokens = quantity("100", 100)) => ({
	key,
	callShare: {
		fact: { kind: "measured", value: key.endsWith("big") ? 75 : 25, source: "local-count" },
		display: "server share",
		ref: "repo:all-30d#callShare",
	},
	calls,
	tokens,
	usd: quantity("$0.01", 0.01),
	pricedBy,
});
const byModel = (
	total: ReturnType<typeof quantity>,
	groups: ReturnType<typeof group>[],
): UsageReport["facts"][number] => ({
	name: "telemetry-cost",
	values: {
		groupBy: "model",
		report: {
			kind: "cost",
			scope: { repo: "all", days: 30 },
			groupBy: "model",
			total: { calls: total, tokens: quantity("900", 900), usd: quantity("$0.03", 0.03), pricedBy },
			groups,
		},
	},
});

test("a model's session calls and worker runs are one server row, read as the server wrote it (#434)", () => {
	const models = usageModelInsights(
		report([
			byModel(quantity("12", 12), [
				group("anthropic/sonnet", quantity("12", 12), quantity("≥900 (1 call unknown)", 900, 1)),
			]),
		]),
	);
	assert.deepEqual(
		models.map((row) => [row.target, row.model, row.calls.value, row.tokens.value, row.tokens.partial]),
		[["anthropic", "sonnet", 12, 900, true]],
	);
	// The client shows the canonical display and appends no marker of its own.
	const tokens = models[0]?.tokens;
	assert.ok(tokens);
	assert.equal(usageAmountText(tokens), "≥900 (1 call unknown)");
	assert.equal(tokens.label, "Known subtotal · missing usage");
	// A model id may hold a slash; the target id never does.
	assert.deepEqual(
		usageModelInsights(report([byModel(quantity("1", 1), [group("dynamo/qwen/coder", quantity("1", 1))])])).map((row) => [
			row.target,
			row.model,
		]),
		[["dynamo", "qwen/coder"]],
	);
});

test("call shares render the server distribution", () => {
	const big = group("a/big", quantity("9", 9));
	const groups = [big, group("a/small", quantity("3", 3))];
	const facts = [byModel(quantity("12", 12), groups)];
	const shares = usageCallShares(usageModelInsights(report(facts)), attributedCalls(report(facts)));
	assert.equal(shares?.total, 12);
	assert.deepEqual(
		shares?.segments.map((segment) => [segment.model, segment.share]),
		[
			["big", 0.75],
			["small", 0.25],
		],
	);
	assert.equal(attributedCalls(report([])), null, "no model report, no denominator");
	const partialTotal = [byModel(quantity("≥12 (1 call unknown)", 12, 1), groups)];
	assert.equal(attributedCalls(report(partialTotal)), null, "a lower-bound total divides nothing");
});

test("prompt-cache evidence reads each session's cache report displays", () => {
	const cache = usageCacheEvidence(
		report([
			{
				name: "telemetry-cache",
				values: {
					sessionId: "s1",
					report: {
						kind: "cache",
						sessionId: "s1",
						verdicts: { hot: 4, partial: 1, cold: 1, small: 0, unknown: 0 },
						uncachedPrefill: quantity("1,200", 1200),
						rePrefilled: quantity("~800", 800),
						breaks: [{}, {}],
					},
				},
			},
		]),
	);
	assert.deepEqual(cache.rows, [
		{
			key: "s1",
			session: "s1",
			uncached: "1,200",
			reprocessed: "~800",
			breaks: "2",
			verdicts: "hot: 4 · partial: 1 · cold: 1 · small: 0 · unknown: 0",
		},
	]);
});

test("a model row splits by who spent it, each side the server's fold with its own reference (#434 §11.3)", () => {
	const side = (calls: string, ref: string) => ({
		calls: { ...quantity(calls, Number(calls)), ref: `${ref}#calls` },
		tokens: { ...quantity("100", 100), ref: `${ref}#total` },
		usd: { ...quantity("$0.01", 0.01), ref: `${ref}#usd` },
	});
	const split = {
		...group("anthropic/sonnet", quantity("12", 12)),
		audience: { session: side("9", "repo:all-30d:own"), worker: side("3", "repo:all-30d:runs") },
	};
	const [row] = usageModelInsights(report([byModel(quantity("12", 12), [split])]));
	assert.deepEqual(
		row?.audience?.map((audience) => [audience.label, audience.measures.calls.value, audience.measures.calls.factRef]),
		[
			["Sessions' own calls", "9", "repo:all-30d:own#calls"],
			["Worker runs", "3", "repo:all-30d:runs#calls"],
		],
	);
	// A group the server sent without a split has none to draw.
	assert.equal(
		usageModelInsights(report([byModel(quantity("12", 12), [group("a/b", quantity("12", 12))])]))[0]?.audience,
		null,
	);
});
