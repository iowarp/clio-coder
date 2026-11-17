import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import type { CacheReadField } from "../../core/token-split.js";
import type { CodexQuotaObservation } from "../types.js";
import { codexAccountScope, parseCodexQuotaEvent } from "./codex-quota.js";
import { withProxyConnectionNote } from "./proxy-connection-error.js";

/** APIs whose lifecycle events carry the provider's response object. */
const RESPONSES_APIS: ReadonlySet<Api> = new Set(["openai-codex-responses", "openai-responses"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Terminal events whose `response.usage` Pi's finalizeResponse normalizes; Codex sends `response.done`. */
const USAGE_EVENTS: ReadonlySet<unknown> = new Set(["response.completed", "response.incomplete", "response.done"]);

/**
 * Whether a terminal event's usage sent a cache-read count. Pi (pi-ai 1.5.2)
 * reads only `input_tokens_details.cached_tokens` and turns its absence into
 * 0, so presence is judged on that field alone and moves with a Pi upgrade.
 * Null when the event carries no usage, which Pi also leaves untouched.
 */
function responsesCacheReadField(data: Record<string, unknown>): CacheReadField | null {
	if (!USAGE_EVENTS.has(data.type) || !isRecord(data.response) || !isRecord(data.response.usage)) return null;
	const details = data.response.usage.input_tokens_details;
	const cached = isRecord(details) ? details.cached_tokens : undefined;
	return typeof cached === "number" && Number.isFinite(cached) && cached >= 0 ? "sent" : "omitted";
}

/**
 * Record the model a Responses-family provider reports for its response.
 * Codex and OpenAI Responses name it as `response.model` on the lifecycle
 * events (`response.created`, `response.completed`), but the stock streams
 * drop it, so every Codex call was stored as `not-observed` although the
 * provider had reported the model (DF-15). The completions path has its own
 * capture in `openai-completions.ts`; this is the Responses counterpart, and
 * it only annotates the terminal message, never the stream's content. It
 * also marks whether the terminal usage sent a cache-read count, as the
 * completions capture does, so an omitted count is never classified cold.
 * OAI-1 / #423 shares this callback and terminal annotation for sanitized Codex
 * quota events, preserving the existing transport and caller-owned callback.
 */
export function observeResponsesModelId<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (!RESPONSES_APIS.has(model.api)) return invoke(options);
	let sawResponse = false;
	let quota: CodexQuotaObservation | null = null;
	const accountScope = model.api === "openai-codex-responses" ? codexAccountScope(options?.apiKey) : null;
	let reportedModelId: string | null = null;
	let cacheReadField: CacheReadField = "omitted";
	const onProviderStreamEvent = options?.onProviderStreamEvent;
	const source = invoke({
		...options,
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (model.api === "openai-codex-responses") quota = parseCodexQuotaEvent(data, accountScope) ?? quota;
			if (isRecord(data) && isRecord(data.response)) {
				sawResponse = true;
				const reported = data.response.model;
				if (typeof reported === "string" && reported.trim().length > 0) reportedModelId = reported.trim();
				cacheReadField = responsesCacheReadField(data) ?? cacheReadField;
			}
			await onProviderStreamEvent?.(data, eventModel);
		},
	} as T);
	const observation = (): ResponseModelIdObservation =>
		!sawResponse
			? { state: "not-observed" }
			: reportedModelId === null
				? { state: "not-reported" }
				: { state: "reported", reportedModelId };
	// A count Pi normalized above zero was sent, whatever event shape carried it past the capture above.
	const fieldFor = (usage: { cacheRead: number }): CacheReadField => (usage.cacheRead > 0 ? "sent" : cacheReadField);
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") {
					event.message.responseModelIdObservation = observation();
					event.message.usage.cacheReadField = fieldFor(event.message.usage);
				} else if (event.type === "error") {
					event.error.responseModelIdObservation = observation();
					event.error.usage.cacheReadField = fieldFor(event.error.usage);
					if (event.error.errorMessage !== undefined)
						event.error.errorMessage = withProxyConnectionNote(event.error.errorMessage, model.baseUrl);
				}
				if (quota !== null && (event.type === "done" || event.type === "error")) {
					const terminal = event.type === "done" ? event.message : event.error;
					(terminal as AssistantMessage & { codexQuota?: CodexQuotaObservation }).codexQuota = quota;
				}
				output.push(event);
			}
			// The terminal event already settled the result; ending without one
			// leaves it pending exactly as the source would have.
			output.end();
		} catch (cause) {
			const reason = cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error";
			const error: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cacheReadField,
				},
				stopReason: reason,
				errorMessage: withProxyConnectionNote(cause instanceof Error ? cause.message : String(cause), model.baseUrl),
				timestamp: Date.now(),
				responseModelIdObservation: observation(),
			};
			output.push({ type: "error", reason, error });
			output.end(error);
		}
	})();
	return output;
}
