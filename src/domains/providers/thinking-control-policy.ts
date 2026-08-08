import type { ThinkingLevel } from "./types/capability-flags.js";

export type ThinkingBudgetByLevel = Partial<Record<ThinkingLevel, number>>;
export type ThinkingEffortByLevel = Partial<Record<ThinkingLevel, string | null>>;

const ANTHROPIC_MIN_THINKING_BUDGET = 1024;
const ANTHROPIC_VISIBLE_OUTPUT_RESERVE = 1024;

export const ANTHROPIC_DEFAULT_THINKING_BUDGETS: Readonly<ThinkingBudgetByLevel> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
};

export function thinkingBudgetFromMap(
	budgets: ThinkingBudgetByLevel | undefined,
	level: ThinkingLevel,
): number | undefined {
	if (!budgets) return undefined;
	if (level === "off") return undefined;
	if (level === "minimal") return budgets.minimal ?? budgets.low;
	if (level === "xhigh") return budgets.xhigh ?? budgets.high;
	return budgets[level];
}

export function thinkingEffortFromMap(
	efforts: ThinkingEffortByLevel | undefined,
	level: ThinkingLevel,
): string | undefined {
	if (!efforts) return undefined;
	// `off` is only wireable when a family maps it explicitly. Models that
	// reason unconditionally unless told otherwise need an off-effort to send;
	// sending nothing leaves them reasoning at full rate. Families that reason
	// only on request still omit the key and keep the send-nothing behaviour.
	const exact = efforts[level];
	if (exact === null) return undefined;
	if (typeof exact === "string") return exact;
	if (level === "minimal") {
		const low = efforts.low;
		return typeof low === "string" ? low : undefined;
	}
	if (level === "xhigh") {
		const high = efforts.high;
		return typeof high === "string" ? high : undefined;
	}
	return undefined;
}

export function defaultAnthropicBudgetForLevel(
	level: ThinkingLevel,
	maxTokens: number | undefined,
): number | undefined {
	const desired = thinkingBudgetFromMap(ANTHROPIC_DEFAULT_THINKING_BUDGETS, level);
	if (desired === undefined) return undefined;
	if (!Number.isFinite(maxTokens) || maxTokens === undefined || maxTokens <= 0) return desired;
	if (maxTokens <= ANTHROPIC_MIN_THINKING_BUDGET) return undefined;

	const preferredCap = maxTokens - ANTHROPIC_VISIBLE_OUTPUT_RESERVE;
	const absoluteCap = maxTokens - 1;
	const cap = preferredCap >= ANTHROPIC_MIN_THINKING_BUDGET ? preferredCap : absoluteCap;
	return Math.max(ANTHROPIC_MIN_THINKING_BUDGET, Math.min(desired, cap));
}

export function defaultAnthropicEffortForLevel(
	level: ThinkingLevel,
	effortMap?: ThinkingEffortByLevel,
): string | undefined {
	const mapped = thinkingEffortFromMap(effortMap, level);
	if (mapped) return mapped;
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return thinkingEffortFromMap(effortMap, "xhigh");
		default:
			return undefined;
	}
}
