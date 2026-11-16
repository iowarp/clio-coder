/**
 * Frontmatter `budget`: what bounds one turn a template starts. It only
 * narrows. A value that does not parse is an error, never a
 * dropped key, because a dropped bound would let the turn run unbounded while
 * its author believed it was capped; the loader turns the error into an
 * unavailable template, which library validation reports as `ERR_PROMPT`.
 */
export interface TemplateTurnBounds {
	budget?: { toolCalls?: number; observationBytes?: number };
}

/** Below one observation slice no observation tool could return anything. */
const MIN_OBSERVATION_BYTES = 1024;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !known.includes(key));
}

function parseBudget(value: unknown): TemplateTurnBounds["budget"] | string {
	const budget = record(value);
	if (budget === null) return "budget must be a mapping such as {toolCalls: 40, observationBytes: 65536}";
	const extra = unknownKeys(budget, ["toolCalls", "observationBytes"]);
	if (extra.length > 0) return `budget has unknown keys ${extra.join(", ")}; it takes toolCalls and observationBytes`;
	const parsed: NonNullable<TemplateTurnBounds["budget"]> = {};
	for (const [key, floor] of [
		["toolCalls", 1],
		["observationBytes", MIN_OBSERVATION_BYTES],
	] as const) {
		const entry = budget[key];
		if (entry === undefined) continue;
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < floor)
			return `budget.${key} must be a whole number of at least ${floor}`;
		parsed[key] = entry;
	}
	if (parsed.toolCalls === undefined && parsed.observationBytes === undefined)
		return "budget names neither toolCalls nor observationBytes";
	return parsed;
}

/** The template's turn bounds, or the one sentence saying why they are invalid. */
export function templateTurnBounds(frontmatter: Record<string, unknown>): TemplateTurnBounds | { error: string } {
	const bounds: TemplateTurnBounds = {};
	if (frontmatter.budget !== undefined) {
		const budget = parseBudget(frontmatter.budget);
		if (typeof budget === "string") return { error: `prompt template ${budget}` };
		if (budget !== undefined) bounds.budget = budget;
	}
	return bounds;
}
