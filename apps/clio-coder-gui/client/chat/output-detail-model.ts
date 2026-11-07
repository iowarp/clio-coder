/**
 * How much of each turn the transcript shows. The values and their names are the terminal's
 * `interface.outputDetail` tiers, so one word means the same thing on both surfaces. In every tier an
 * approval, a failure and a stopped turn stay visible; a tier only decides how much routine detail
 * sits around them. Opening a disclosure shows more for that turn without changing the tier.
 */
export type OutputDetail = "compact" | "standard" | "detailed";

export const OUTPUT_DETAILS: readonly { value: OutputDetail; label: string; summary: string }[] = [
	{
		value: "compact",
		label: "Minimal",
		summary: "Requests, answers, approvals and failures. Reasoning and per-turn figures stay hidden.",
	},
	{ value: "standard", label: "Default", summary: "One line under each answer: time, tokens, cost and tool calls." },
	{
		value: "detailed",
		label: "Detailed",
		summary: "Adds model, first-token time, speed and cache use under each answer.",
	},
];

export const DEFAULT_OUTPUT_DETAIL: OutputDetail = "standard";

export function parseOutputDetail(value: unknown): OutputDetail {
	return value === "compact" || value === "standard" || value === "detailed" ? value : DEFAULT_OUTPUT_DETAIL;
}

export function outputDetailLabel(value: OutputDetail): string {
	return OUTPUT_DETAILS.find((tier) => tier.value === value)?.label ?? "Default";
}
