import type { UsageReport } from "../../contracts/reports.js";
import { formatCost, formatTokens } from "../api/clock.js";

export type UsageMetric = "calls" | "tokens" | "cost";
export const USAGE_METRICS: ReadonlyArray<{ id: UsageMetric; label: string; description: string }> = [
	{ id: "calls", label: "API calls", description: "Recorded API calls by target and model." },
	{ id: "tokens", label: "Tokens", description: "Recorded total tokens; missing usage contributes no invented amount." },
	{
		id: "cost",
		label: "Known cost",
		description: "Known USD amounts, including estimates. Unpriced calls remain unknown.",
	},
];

export interface UsageAmount {
	value: number | null;
	partial: boolean;
	estimated: boolean;
	label: string;
}
export interface UsageModelInsight {
	id: string;
	model: string;
	target: string;
	sources: string[];
	facts: UsageReport["facts"];
	calls: UsageAmount;
	tokens: UsageAmount;
	cost: UsageAmount;
}

const number = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const name = (value: unknown, fallback: string): string =>
	typeof value === "string" && value.trim() ? value : fallback;
const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function costOf(values: Record<string, unknown>): UsageAmount {
	const cost = record(values.cost);
	const estimated = cost?.hasEstimated === true;
	const partial = cost?.hasUnknown === true || (number(values.unpricedRuns) ?? 0) > 0;
	const amount = number(cost ? cost.knownUsd : (values.costUsd ?? values.knownCostUsd));
	const value = cost?.calls === 0 || (partial && amount === 0) ? null : amount;
	return {
		value,
		partial,
		estimated,
		label:
			value === null
				? partial
					? "Unpriced"
					: "Not recorded"
				: `${estimated ? "Estimated" : cost ? (cost.allKnownFree === true ? "Known free" : "Reported") : "Pricing provenance unavailable"}${partial ? " · unpriced calls" : ""}`,
	};
}

function amountsOf(values: Record<string, unknown>) {
	const calls = number(values.apiCalls);
	const missing = Math.max(number(values.missingTokenCalls) ?? 0, number(values.missingTokenRuns) ?? 0);
	const partial = missing > 0 || values.knownSubtotals === true;
	const total = number(values.totalTokens);
	const tokens = total === 0 && missing > 0 && (calls === null || missing >= calls) ? null : total;
	return {
		calls: { value: calls, partial: false, estimated: false, label: calls === null ? "Not recorded" : "Recorded calls" },
		tokens: {
			value: tokens,
			partial,
			estimated: false,
			label: tokens === null ? "Missing usage" : partial ? "Known subtotal · missing usage" : "Recorded tokens",
		},
		cost: costOf(values),
	};
}

function combine(a: UsageAmount, b: UsageAmount): UsageAmount {
	const value = a.value === null && b.value === null ? null : (a.value ?? 0) + (b.value ?? 0);
	const partial = a.partial || b.partial || a.value === null || b.value === null;
	const estimated = a.estimated || b.estimated;
	const labels = [...new Set([a.label, b.label])];
	return { value, partial, estimated, label: labels.join("; ") };
}

/** CLI model rows are disjoint: metered worker sessions are excluded from receipt totals upstream. */
export function usageModelInsights(report: UsageReport): UsageModelInsight[] {
	const models = new Map<string, UsageModelInsight>();
	for (const fact of report.facts) {
		if (fact.name !== "model-usage" && fact.name !== "worker-model-usage") continue;
		const worker = fact.name === "worker-model-usage";
		const target = name(worker ? fact.values.targetId : fact.values.providerId, "Unknown target");
		const model = name(worker ? fact.values.modelId : fact.values.attributedModelId, "Unknown model");
		const id = JSON.stringify([target, model]);
		const amounts = amountsOf(fact.values);
		const source = worker ? "Worker receipts" : "Session & side calls";
		const existing = models.get(id);
		if (!existing) {
			models.set(id, { id, target, model, ...amounts, sources: [source], facts: [fact] });
		} else {
			existing.calls = combine(existing.calls, amounts.calls);
			existing.tokens = combine(existing.tokens, amounts.tokens);
			existing.cost = combine(existing.cost, amounts.cost);
			existing.facts.push(fact);
			if (!existing.sources.includes(source)) existing.sources.push(source);
		}
	}
	return [...models.values()];
}

export function usageAmountText(amount: UsageAmount, metric: UsageMetric): string {
	if (amount.value === null) return metric === "cost" && amount.partial ? "Unpriced" : "Not recorded";
	const value = metric === "cost" ? formatCost(amount.value) : formatTokens(amount.value);
	return `${amount.estimated ? "~" : ""}${value}${amount.partial ? " +?" : ""}`;
}

export function compareUsageModels(models: UsageModelInsight[], metric: UsageMetric) {
	const rows = [...models].sort((a, b) => {
		const av = a[metric].value;
		const bv = b[metric].value;
		return (
			(av === null ? (bv === null ? 0 : 1) : bv === null ? -1 : bv - av) ||
			a.model.localeCompare(b.model) ||
			a.target.localeCompare(b.target)
		);
	});
	const max = Math.max(0, ...rows.map((row) => row[metric].value ?? 0));
	return rows.map((row) => ({ ...row, width: max > 0 ? ((row[metric].value ?? 0) / max) * 100 : 0 }));
}

export function usageCallShares(models: UsageModelInsight[]) {
	const total = models.reduce((sum, row) => sum + (row.calls.value ?? 0), 0);
	if (!models.length || models.some((row) => row.calls.value === null || row.calls.partial) || total <= 0) return null;
	let offset = 0;
	return {
		total,
		segments: models
			.filter((row) => (row.calls.value ?? 0) > 0)
			.map((row) => {
				const share = (row.calls.value ?? 0) / total;
				const segment = { id: row.id, model: row.model, target: row.target, calls: row.calls.value, share, offset };
				offset += share;
				return segment;
			}),
	};
}

export function filterUsageModels(
	models: readonly UsageModelInsight[],
	query: string,
	coverage: string,
): UsageModelInsight[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((row) => {
		const text = [row.model, row.target, ...row.sources].join(" ").toLocaleLowerCase();
		const incomplete = [row.calls, row.tokens, row.cost].some((amount) => amount.value === null || amount.partial);
		return terms.every((term) => text.includes(term)) && (coverage !== "incomplete" || incomplete);
	});
}

/** Session prompt-cache telemetry is a separate observation, never another token or cost total. */
export function usageCacheEvidence(report: UsageReport) {
	const facts = report.facts.filter((fact) => fact.name === "session-cache");
	return {
		total: facts.length,
		omitted: Math.max(0, facts.length - 24),
		rows: facts.slice(0, 24).map((fact, index) => {
			const values = fact.values;
			const verdicts = record(values.verdictCounts);
			const count = (value: unknown) => {
				const amount = number(value);
				return amount === null ? "Not recorded" : amount.toLocaleString("en-US");
			};
			return {
				key: `${index}:${name(values.sessionId, "unknown")}`,
				session: name(values.sessionId, "Session not recorded"),
				uncached: count(values.uncachedPrefillTokens),
				reprocessed: count(values.reprefilledTokens),
				breaks: count(values.cacheBreakCalls),
				verdicts: ["hot", "partial", "cold", "small", "unknown"]
					.map((verdict) => `${verdict}: ${count(verdicts?.[verdict])}`)
					.join(" · "),
			};
		}),
	};
}
