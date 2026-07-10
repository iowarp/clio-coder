import type { ThinkingLevel } from "../domains/providers/index.js";
import {
	defaultAnthropicBudgetForLevel,
	defaultAnthropicEffortForLevel,
	type ThinkingEffortByLevel,
} from "../domains/providers/thinking-control-policy.js";
import type { Model } from "./types.js";

function reasoningSummaryForLevel(level: ThinkingLevel | undefined): "concise" | "detailed" | undefined {
	if (!level || level === "off") return undefined;
	if (level === "minimal" || level === "low") return "concise";
	return "detailed";
}

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function patchOpenAIReasoningSummaryPayload(
	payload: unknown,
	model: Model<never>,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	if (!isOpenAIResponsesApi(model.api)) return undefined;
	const summary = reasoningSummaryForLevel(thinkingLevel);
	if (!summary || !isRecord(payload)) return undefined;
	const record = payload;
	const reasoning = record.reasoning;
	if (!isRecord(reasoning)) return undefined;
	return {
		...record,
		reasoning: {
			...reasoning,
			summary,
		},
	};
}

function isAnthropicMessagesApi(api: string): boolean {
	return api === "anthropic-messages";
}

function anthropicThinkingLevelMap(model: Model<never>): ThinkingEffortByLevel | undefined {
	return model.thinkingLevelMap as ThinkingEffortByLevel | undefined;
}

function anthropicUsesAdaptiveThinking(model: Model<never>): boolean {
	const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
	return compat?.forceAdaptiveThinking === true;
}

function patchAnthropicThinkingPayload(
	payload: unknown,
	model: Model<never>,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	if (!isAnthropicMessagesApi(model.api) || model.reasoning !== true) return undefined;
	if (!thinkingLevel || thinkingLevel === "off" || !isRecord(payload)) return undefined;
	const record = payload;
	const existingThinking = isRecord(record.thinking) ? record.thinking : {};
	const display = typeof existingThinking.display === "string" ? existingThinking.display : "summarized";

	if (anthropicUsesAdaptiveThinking(model)) {
		const effort = defaultAnthropicEffortForLevel(thinkingLevel, anthropicThinkingLevelMap(model));
		const existingOutputConfig = isRecord(record.output_config) ? record.output_config : {};
		return {
			...record,
			thinking: { ...existingThinking, type: "adaptive", display },
			...(effort ? { output_config: { ...existingOutputConfig, effort } } : {}),
		};
	}

	const maxTokens = numberValue(record.max_tokens) ?? model.maxTokens;
	const budgetTokens = defaultAnthropicBudgetForLevel(thinkingLevel, maxTokens);
	if (budgetTokens === undefined) return undefined;
	return {
		...record,
		thinking: { ...existingThinking, type: "enabled", budget_tokens: budgetTokens, display },
	};
}

/**
 * Align provider payloads with Clio's effective thinking level.
 *
 * OpenAI Responses defaults reasoning summaries to "auto", which can yield no
 * visible thinking blocks. Anthropic's generic stream path can also under-map
 * Clio levels when xhigh/adaptive metadata is available only on the model.
 */
export function patchProviderThinkingPayload(
	payload: unknown,
	model: Model<never>,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	return (
		patchOpenAIReasoningSummaryPayload(payload, model, thinkingLevel) ??
		patchAnthropicThinkingPayload(payload, model, thinkingLevel)
	);
}

/**
 * Force a text-only round by setting the request-level tool-choice knob to
 * "none". Used while a loop-guard synthesis lockout is active: the lockout
 * directive alone relies on model compliance, and measured local models kept
 * calling tools until the backstop stopped the turn, throwing away everything
 * the turn had gathered. The tool schema bytes are untouched (the prompt
 * prefix and tool surface stay byte-stable); only this request's routing
 * changes, so prompt-prefix caches are unaffected.
 *
 * Returns undefined when the payload carries no tool surface (nothing to
 * lock) or is not a record (unknown provider shape; leave it alone).
 */
export function patchToolChoiceNonePayload(payload: unknown, model: Model<never>): unknown | undefined {
	if (!isRecord(payload)) return undefined;
	if (!("tools" in payload) || payload.tools === undefined || payload.tools === null) return undefined;
	if (isAnthropicMessagesApi(model.api)) return { ...payload, tool_choice: { type: "none" } };
	return { ...payload, tool_choice: "none" };
}

/** Attach llama-server's native JSON-schema response constraint without changing its tool surface. */
export function patchLlamaCppResponseSchemaPayload(
	payload: unknown,
	runtimeId: string,
	responseSchema: Record<string, unknown> | undefined,
): unknown | undefined {
	if (responseSchema === undefined) return undefined;
	if (runtimeId !== "llamacpp") {
		throw new Error(`responseSchema requires the native llamacpp runtime; received '${runtimeId}'`);
	}
	if (!isRecord(payload)) throw new Error("cannot apply responseSchema to a non-object provider payload");
	return {
		...payload,
		response_format: {
			// llama-server accepts schema-constrained JSON through the widely
			// compatible json_object form; some deployed gateways silently ignore
			// the newer json_schema discriminator while still returning HTTP 200.
			type: "json_object",
			schema: responseSchema,
		},
	};
}

export interface WorkerPayloadPatchOptions {
	runtimeId: string;
	thinkingLevel?: ThinkingLevel;
	responseSchema?: Record<string, unknown>;
	toolChoiceNone?: boolean;
}

/** Compose all worker-owned request mutations over one payload in a stable order. */
export function patchWorkerRequestPayload(
	payload: unknown,
	model: Model<never>,
	options: WorkerPayloadPatchOptions,
): unknown | undefined {
	let patched = payload;
	let changed = false;

	const thinkingPatched = patchProviderThinkingPayload(patched, model, options.thinkingLevel);
	if (thinkingPatched !== undefined) {
		patched = thinkingPatched;
		changed = true;
	}

	const schemaPatched = patchLlamaCppResponseSchemaPayload(patched, options.runtimeId, options.responseSchema);
	if (schemaPatched !== undefined) {
		patched = schemaPatched;
		changed = true;
	}

	if (options.toolChoiceNone === true) {
		const toolChoicePatched = patchToolChoiceNonePayload(patched, model);
		if (toolChoicePatched !== undefined) {
			patched = toolChoicePatched;
			changed = true;
		}
	}

	return changed ? patched : undefined;
}

export function patchReasoningSummaryPayload(
	payload: unknown,
	model: Model<never>,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	return patchProviderThinkingPayload(payload, model, thinkingLevel);
}
