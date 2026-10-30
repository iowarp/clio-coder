import { Value } from "typebox/value";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { AcpUsageMetaSchema } from "../../contracts/wire.js";
import type { CostAggregate } from "../clio/http-shims.js";
import { aggregateCostAmounts, renderCostAggregate, renderUsdLimit } from "../clio/http-shims.js";

/** Limits and bounds, as opposed to spend: ceilings, caps, budgets and route cost bounds (#434). */
const USD_LIMIT_KEY =
	/^(?:max|runMax|maxCost|budget|ceiling|newCeiling|initialCeiling|costCeiling|raiseTo|configured|additional)Usd$|UpperBoundUsd$/u;

function summary(value: unknown): CostAggregate | undefined {
	const schema = AcpUsageMetaSchema.properties.costSummary;
	const clean = Value.Clean(schema, structuredClone(value));
	return clean && Value.Check(schema, clean) ? (clean as CostAggregate) : undefined;
}

function provenance(value: unknown) {
	return value === "known" || value === "known_free" || value === "estimated" ? value : "unknown";
}

/** Raw receipts and report facts keep their numbers; only the server interprets their pricing (#434). */
export function withCostDisplay<T extends Record<string, unknown>>(row: T): T & { costDisplay: string } {
	const costSummary = summary(row.costSummary) ?? summary(row.cost) ?? summary(row);
	return {
		...row,
		costDisplay: renderCostAggregate(
			aggregateCostAmounts([
				{
					usd: typeof row.costUsd === "number" ? row.costUsd : 0,
					provenance: provenance(row.costProvenance),
					...(costSummary ? { costSummary } : {}),
					...(typeof row.apiCalls === "number" ? { apiCalls: row.apiCalls } : {}),
					...(typeof row.missingTokenCalls === "number" ? { missingTokenCalls: row.missingTokenCalls } : {}),
				},
			]),
		),
	};
}

/**
 * Report facts and receipts contain nested aggregate rows, so each monetary record carries its own display, and
 * each limit carries a `<key>Display` sibling: a bound is not spend and must never read as unmeasured (#434).
 */
export function reportCostDisplays(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reportCostDisplays);
	if (!value || typeof value !== "object") return value;
	const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reportCostDisplays(item)]));
	for (const [key, item] of Object.entries(row))
		if (USD_LIMIT_KEY.test(key) && (typeof item === "number" || item === null))
			row[`${key}Display`] = renderUsdLimit(item);
	return "costUsd" in row || "knownUsd" in row || "cost" in row ? withCostDisplay(row) : row;
}

/**
 * Each recorded turn's own cost, worded on the server. A session's spend is never folded from these: the read
 * model's session DTO is its one source (#434 §11.3), so a snapshot carries no session total.
 */
export function turnCostDisplays(snapshot: SessionSnapshot): SessionSnapshot {
	return {
		...snapshot,
		turns: snapshot.turns.map((turn) => ({ ...turn, usage: turn.usage ? withCostDisplay(turn.usage) : null })),
	};
}
