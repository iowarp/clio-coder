import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ResponsesCacheDiagnostic } from "../types.js";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Diagnostics exist on the public Responses API for GPT-5.6 and later only; compatible servers need not accept them. */
function diagnosable(model: Model<Api>): boolean {
	if (model.api !== "openai-responses") return false;
	if (
		(model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined)?.supportsExplicitPromptCacheMode !== true
	)
		return false;
	try {
		return new URL(model.baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

/** The id of the last response this route gave in the submitted context, resumed turns included. */
function previousResponseId(model: Model<Api>, context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "assistant") continue;
		return message.api === model.api && message.provider === model.provider ? message.responseId : undefined;
	}
	return undefined;
}

function diagnosticOf(value: unknown): ResponsesCacheDiagnostic | undefined {
	if (!record(value) || typeof value.type !== "string") return undefined;
	const count = (field: unknown) =>
		typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
	const missed = count(value.cache_missed_tokens);
	const reusable = count(value.comparison_reusable_tokens);
	return {
		provider: "openai",
		type: value.type,
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(missed === undefined ? {} : { missedInputTokens: missed }),
		...(reusable === undefined ? {} : { comparisonReusableTokens: reusable }),
	};
}

/**
 * Ask the public Responses API why a request reused less of its prompt cache than the previous response of the same
 * conversation (PV-2, OI-3). The comparison id joins the cache options Pi built, and the verdict from
 * `response.completed` rides on the terminal message as `responsesCacheDiagnostic`. Asking costs nothing and never
 * changes caching or generation; a first request has no comparison and sends none.
 */
export function observeResponsesCacheDiagnostics<T extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (!diagnosable(model)) return invoke(options);
	const comparison = previousResponseId(model, context);
	if (comparison === undefined) return invoke(options);
	let diagnostic: ResponsesCacheDiagnostic | undefined;
	const onPayload = options?.onPayload;
	const onProviderStreamEvent = options?.onProviderStreamEvent;
	const source = invoke({
		...options,
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			const base = (await onPayload?.(payload, currentModel)) ?? payload;
			if (!record(base)) return base;
			const cacheOptions = record(base.prompt_cache_options) ? base.prompt_cache_options : {};
			return { ...base, prompt_cache_options: { ...cacheOptions, comparison_response_id: comparison } };
		},
		onProviderStreamEvent: async (event: unknown, eventModel: Model<Api>) => {
			if (record(event) && event.type === "response.completed" && record(event.response))
				diagnostic = diagnosticOf(event.response.prompt_cache_diagnostics);
			await onProviderStreamEvent?.(event, eventModel);
		},
	} as T);
	const output = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if ((event.type === "done" || event.type === "error") && diagnostic !== undefined) {
				const terminal = event.type === "done" ? event.message : event.error;
				(terminal as AssistantMessage & { responsesCacheDiagnostic?: ResponsesCacheDiagnostic }).responsesCacheDiagnostic =
					diagnostic;
			}
			output.push(event);
		}
		output.end();
	})();
	return output;
}
