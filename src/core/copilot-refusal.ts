/**
 * Copilot's own refusals (policy, quota, rate limit, authorization) are surfaced as they are: Clio never
 * retries one on the same seat, another account or another target. The copilot-sdk adapter writes this
 * prefix; the chat and dispatch retry policies read it as terminal before any wording-based classification.
 */
export const COPILOT_REFUSAL_PREFIX = "GitHub Copilot refused the request";

export function isCopilotRefusal(text: string | null | undefined): boolean {
	return typeof text === "string" && text.toLowerCase().includes(COPILOT_REFUSAL_PREFIX.toLowerCase());
}
