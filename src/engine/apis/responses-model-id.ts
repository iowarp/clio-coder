import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";

/** APIs whose lifecycle events carry the provider's response object. */
const RESPONSES_APIS: ReadonlySet<Api> = new Set([
	"openai-codex-responses",
	"openai-responses",
	"azure-openai-responses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Record the model a Responses-family provider reports for its response.
 * Codex and OpenAI Responses name it as `response.model` on the lifecycle
 * events (`response.created`, `response.completed`), but the stock streams
 * drop it, so every Codex call was stored as `not-observed` although the
 * provider had reported the model (DF-15). The completions path has its own
 * capture in `openai-completions.ts`; this is the Responses counterpart, and
 * it only annotates the terminal message, never the stream's content.
 */
export function observeResponsesModelId<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (!RESPONSES_APIS.has(model.api)) return invoke(options);
	let sawResponse = false;
	let reportedModelId: string | null = null;
	const onProviderStreamEvent = options?.onProviderStreamEvent;
	const source = invoke({
		...options,
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (isRecord(data) && isRecord(data.response)) {
				sawResponse = true;
				const reported = data.response.model;
				if (typeof reported === "string" && reported.trim().length > 0) reportedModelId = reported.trim();
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
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") event.message.responseModelIdObservation = observation();
				else if (event.type === "error") event.error.responseModelIdObservation = observation();
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
				},
				stopReason: reason,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
				timestamp: Date.now(),
				responseModelIdObservation: observation(),
			};
			output.push({ type: "error", reason, error });
			output.end(error);
		}
	})();
	return output;
}
