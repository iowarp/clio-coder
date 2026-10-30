import type { UsageReport } from "../../contracts/reports.js";
import type { CostReportV1, Quantity } from "../../contracts/wire.js";
import { countText, quantityParts } from "../telemetry/quantity-model.js";
import { cacheReportsOf, costReportOf } from "./usage-model.js";

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
	/** The amount bars scale by, a lower bound while `partial`; null when nothing is known or the kinds mix. */
	value: number | null;
	partial: boolean;
	estimated: boolean;
	label: string;
	/** The canonical renderer's wording; the only text shown for the amount (#434). */
	display: string;
}
export interface UsageModelInsight {
	id: string;
	model: string;
	target: string;
	facts: UsageReport["facts"];
	calls: UsageAmount;
	tokens: UsageAmount;
	cost: UsageAmount;
}

type CostGroup = CostReportV1["groups"][number];

function amountOf(quantity: Quantity, metric: UsageMetric, pricedBy: CostGroup["pricedBy"]): UsageAmount {
	const parts = quantityParts(quantity);
	const partial = parts.unknown > 0;
	const estimated = parts.estimated > 0;
	const { free, ...priced } = pricedBy;
	const label =
		metric === "calls"
			? partial
				? "Known subtotal · unknown call coverage"
				: "Recorded calls"
			: metric === "tokens"
				? !parts.known
					? "Missing usage"
					: partial
						? "Known subtotal · missing usage"
						: "Recorded tokens"
				: !parts.known
					? partial
						? "Unpriced"
						: "Not recorded"
					: `${estimated ? "Estimated" : free > 0 && Object.values(priced).every((count) => count === 0) ? "Known free" : "Reported"}${partial ? " · unpriced calls" : ""}`;
	return { value: parts.amount, partial, estimated, label, display: quantity.display };
}

/** A model group's key is `<target>/<model>`; a target id holds no slash, while a model id may. */
function identity(key: string): { target: string; model: string } {
	const slash = key.indexOf("/");
	return slash < 0
		? { target: "Unknown target", model: key || "Unknown model" }
		: { target: key.slice(0, slash) || "Unknown target", model: key.slice(slash + 1) || "Unknown model" };
}

/**
 * One row per target and model, from the read model's model groups over the window: a model's session calls and its
 * workers' runs are one fold on the server, so nothing here adds two rows (#434).
 */
export function usageModelInsights(report: UsageReport): UsageModelInsight[] {
	const byModel = costReportOf(report, "model");
	return (byModel?.groups ?? []).map((group) => ({
		id: group.key,
		...identity(group.key),
		facts: [{ name: "telemetry-cost", values: group }],
		calls: amountOf(group.calls, "calls", group.pricedBy),
		tokens: amountOf(group.tokens, "tokens", group.pricedBy),
		cost: amountOf(group.usd, "cost", group.pricedBy),
	}));
}

export function usageAmountText(amount: UsageAmount): string {
	return amount.display;
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

/**
 * The model groups' own total: the denominator comes from the report the shares come from, so they partition it
 * (#434). Null unless the server measured that total exactly.
 */
export function attributedCalls(report: UsageReport): number | null {
	const byModel = costReportOf(report, "model");
	return byModel ? quantityParts(byModel.total.calls).exact : null;
}

/** Shares of the model total; null until every row's count is exact and the rows partition the total. */
export function usageCallShares(models: UsageModelInsight[], total: number | null) {
	if (total === null || total <= 0) return null;
	if (!models.length || models.some((row) => row.calls.value === null || row.calls.partial)) return null;
	let offset = 0;
	const segments = models
		.filter((row) => (row.calls.value ?? 0) > 0)
		.map((row) => {
			const share = (row.calls.value ?? 0) / total;
			const segment = { id: row.id, model: row.model, target: row.target, calls: row.calls.value, share, offset };
			offset += share;
			return segment;
		});
	// A call that failed over to another model is one call in each group; such groups overlap and make no pie.
	return offset > 1 + 1e-9 ? null : { total, segments };
}

export function filterUsageModels(
	models: readonly UsageModelInsight[],
	query: string,
	coverage: string,
): UsageModelInsight[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((row) => {
		const text = [row.model, row.target].join(" ").toLocaleLowerCase();
		const incomplete = [row.calls, row.tokens, row.cost].some((amount) => amount.value === null || amount.partial);
		return terms.every((term) => text.includes(term)) && (coverage !== "incomplete" || incomplete);
	});
}

/** Session prompt-cache telemetry is a separate observation, never another token or cost total. */
export function usageCacheEvidence(report: UsageReport) {
	const reports = cacheReportsOf(report);
	return {
		total: reports.length,
		omitted: Math.max(0, reports.length - 24),
		rows: reports.slice(0, 24).map((cache) => ({
			key: cache.sessionId,
			session: cache.sessionId,
			uncached: cache.uncachedPrefill.display,
			reprocessed: cache.rePrefilled.display,
			breaks: countText(cache.breaks.length),
			verdicts: (["hot", "partial", "cold", "small", "unknown"] as const)
				.map((verdict) => `${verdict}: ${countText(cache.verdicts[verdict])}`)
				.join(" · "),
		})),
	};
}
