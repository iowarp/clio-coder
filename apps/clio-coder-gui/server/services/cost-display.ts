import { renderUsdLimit } from "../clio/http-shims.js";

/** Limits and bounds, as opposed to spend: ceilings, caps, budgets and route cost bounds (#434). */
const USD_LIMIT_KEY =
	/^(?:max|runMax|maxCost|budget|ceiling|newCeiling|initialCeiling|costCeiling|raiseTo|configured|additional)Usd$|UpperBoundUsd$/u;

/**
 * Report facts and records carry spend as read-model quantities that already hold their display; each limit gets a
 * `<key>Display` sibling here, because a bound is not spend and must never read as unmeasured (#434).
 */
export function reportCostDisplays(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reportCostDisplays);
	if (!value || typeof value !== "object") return value;
	const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reportCostDisplays(item)]));
	for (const [key, item] of Object.entries(row))
		if (USD_LIMIT_KEY.test(key) && (typeof item === "number" || item === null))
			row[`${key}Display`] = renderUsdLimit(item);
	return row;
}
