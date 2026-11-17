import { isToolLimitName } from "../../../core/tool-limit-flags.js";
import { ToolNames } from "../../../core/tool-names.js";

/**
 * Frontmatter `budget` and `turnPolicy`: what bounds one turn a template
 * starts. A budget lowers the operator's per-turn limits and raises them only
 * up to the operator's template ceilings (`safety.limits.template*Max`); the
 * turn policy only narrows. A value that does not parse is an error, never a
 * dropped key, because a dropped bound would let the turn run unbounded while
 * its author believed it was capped; the loader turns the error into an
 * unavailable template, which library validation reports as `ERR_PROMPT`.
 */
export interface TemplateTurnBounds {
	budget?: { toolCalls?: number; observationBytes?: number };
	turnPolicy?: { mode: "step"; stepTool: string };
}

const TOOL_NAMES_BY_LOWERCASE = new Map(Object.values(ToolNames).map((name) => [name.toLowerCase(), name]));

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

function parseTurnPolicy(
	value: unknown,
	allowedTools: readonly string[] | undefined,
): TemplateTurnBounds["turnPolicy"] | string {
	const policy = record(value);
	if (policy === null)
		return "turnPolicy must be a mapping that names its step tool, such as {mode: step, stepTool: extension_desk__next_step}";
	const extra = unknownKeys(policy, ["mode", "stepTool"]);
	if (extra.length > 0) return `turnPolicy has unknown keys ${extra.join(", ")}; it takes mode and stepTool`;
	if (policy.mode !== "step") return "turnPolicy.mode must be step";
	const declared = typeof policy.stepTool === "string" ? policy.stepTool.trim() : "";
	const stepTool = TOOL_NAMES_BY_LOWERCASE.get(declared.toLowerCase()) ?? declared;
	if (!isToolLimitName(stepTool)) return "turnPolicy.stepTool must name one tool";
	if (allowedTools !== undefined && !allowedTools.includes(stepTool))
		return `turnPolicy.stepTool ${stepTool} is not in this template's allowed-tools`;
	return { mode: "step", stepTool };
}

/** The template's turn bounds, or the one sentence saying why they are invalid. */
export function templateTurnBounds(
	frontmatter: Record<string, unknown>,
	allowedTools: readonly string[] | undefined,
): TemplateTurnBounds | { error: string } {
	const bounds: TemplateTurnBounds = {};
	if (frontmatter.budget !== undefined) {
		const budget = parseBudget(frontmatter.budget);
		if (typeof budget === "string") return { error: `prompt template ${budget}` };
		if (budget !== undefined) bounds.budget = budget;
	}
	if (frontmatter.turnPolicy !== undefined) {
		const policy = parseTurnPolicy(frontmatter.turnPolicy, allowedTools);
		if (typeof policy === "string") return { error: `prompt template ${policy}` };
		if (policy !== undefined) bounds.turnPolicy = policy;
	}
	return bounds;
}
