import type { EngineModel } from "../../../engine/types.js";
import { extractReasoningTokens } from "../context-accounting.js";

/**
 * How much of a route's summary output goes to reasoning, from the summary calls this process has made on it. A
 * route that reasons spends its output cap on reasoning before it writes the summary, so the next summary's cap has
 * to leave room for that share, or the summary stops at the cap and is never saved.
 */

/** Recent summary calls remembered per route, so one outlier does not set the cap. */
const ROUTE_WINDOW = 8;
/** However much a route reasons, at least a tenth of the cap stays for the summary itself. */
const MAX_REASONING_SHARE = 0.9;

const routes = new Map<string, Array<{ output: number; reasoning: number }>>();

function routeKey(model: Pick<EngineModel, "provider" | "baseUrl" | "id">): string {
	return JSON.stringify([model.provider, model.baseUrl, model.id]);
}

/** Remember one summary call's reasoning split, when the provider reported one. */
export function noteSummaryUsage(model: Pick<EngineModel, "provider" | "baseUrl" | "id">, usage: unknown): void {
	if (usage === null || typeof usage !== "object") return;
	const output = (usage as { output?: unknown }).output;
	// Only the provider's own breakdown counts; an adapter's estimate is not an observation.
	const reasoning = extractReasoningTokens({ ...(usage as Record<string, unknown>), reasoningTokens: undefined });
	if (typeof output !== "number" || !Number.isFinite(output) || output <= 0 || reasoning === null) return;
	const key = routeKey(model);
	const calls = routes.get(key) ?? [];
	calls.push({ output, reasoning: Math.min(reasoning, output) });
	if (calls.length > ROUTE_WINDOW) calls.shift();
	routes.set(key, calls);
}

/** The share of a route's recent summary output spent on reasoning, or undefined before the route reported one. */
export function summaryReasoningShare(model: Pick<EngineModel, "provider" | "baseUrl" | "id">): number | undefined {
	const calls = routes.get(routeKey(model));
	if (calls === undefined || calls.length === 0) return undefined;
	let output = 0;
	let reasoning = 0;
	for (const call of calls) {
		output += call.output;
		reasoning += call.reasoning;
	}
	return Math.min(MAX_REASONING_SHARE, reasoning / output);
}
