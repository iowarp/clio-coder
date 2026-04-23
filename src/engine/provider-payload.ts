import type { ThinkingLevel } from "../domains/providers/index.js";
import type { Model } from "./types.js";

function reasoningSummaryForLevel(level: ThinkingLevel | undefined): "concise" | "detailed" | undefined {
	if (!level || level === "off") return undefined;
	if (level === "minimal" || level === "low") return "concise";
	return "detailed";
}

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
}

/**
 * Force visible reasoning summaries for OpenAI Responses-family providers when
 * Clio enables thinking. pi-ai defaults the summary mode to "auto", which can
 * legitimately yield no visible thinking blocks; the TUI then looks broken even
 * though reasoning is enabled.
 */
export function patchReasoningSummaryPayload(
	payload: unknown,
	model: Model<never>,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	if (!isOpenAIResponsesApi(model.api)) return undefined;
	const summary = reasoningSummaryForLevel(thinkingLevel);
	if (!summary || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	const reasoning = record.reasoning;
	if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return undefined;
	return {
		...record,
		reasoning: {
			...(reasoning as Record<string, unknown>),
			summary,
		},
	};
}
