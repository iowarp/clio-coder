import { Value } from "typebox/value";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { AcpUsageMetaSchema } from "../../contracts/wire.js";
import type { CostAggregate } from "../clio/http-shims.js";
import { aggregateCostAmounts, renderCostAggregate } from "../clio/http-shims.js";

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

/** Report facts contain nested aggregate rows, so each monetary record carries its own display. */
export function reportCostDisplays(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reportCostDisplays);
	if (!value || typeof value !== "object") return value;
	const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reportCostDisplays(item)]));
	return "costUsd" in row || "knownUsd" in row || "cost" in row ? withCostDisplay(row) : row;
}

/** Historic snapshots can lack live accounting; fold their recorded turns with the same cost algebra. */
export function snapshotCostDisplay(snapshot: SessionSnapshot): SessionSnapshot {
	const cost = aggregateCostAmounts(
		snapshot.turns.flatMap(({ usage }) =>
			usage
				? [
						{
							usd: usage.costUsd ?? 0,
							provenance: provenance(usage.costProvenance),
							...(usage.costSummary ? { costSummary: usage.costSummary } : {}),
							...(usage.apiCalls !== undefined ? { apiCalls: usage.apiCalls } : {}),
							...(usage.missingTokenCalls !== undefined ? { missingTokenCalls: usage.missingTokenCalls } : {}),
						},
					]
				: [],
		),
	);
	return {
		...snapshot,
		costDisplay: renderCostAggregate(cost),
		turns: snapshot.turns.map((turn) => ({ ...turn, usage: turn.usage ? withCostDisplay(turn.usage) : null })),
	};
}
