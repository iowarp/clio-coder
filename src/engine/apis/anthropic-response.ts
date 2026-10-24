import { createHash } from "node:crypto";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ResponseModelIdObservation } from "../../core/response-model-id.js";
import type { AnthropicResponseObservation } from "../types.js";

const RATE_LIMIT_PREFIX = "anthropic-ratelimit-unified-";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(value: string | null): number | null {
	if (value === null || value.trim().length === 0) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : null;
}

/** Capture failures at fetch because Pi's onResponse only sees successful responses (#423). */
export function observeAnthropicResponse<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (model.api !== "anthropic-messages") return invoke(options);
	const observation: AnthropicResponseObservation = {
		observedAt: new Date().toISOString(),
		status: null,
		attempts: 0,
		requestId: null,
		accountScope: null,
		retryAfterSeconds: null,
		rateLimit: {},
		messageStart: null,
	};
	const fetchImpl = options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const onProviderStreamEvent = options?.onProviderStreamEvent;
	const source = invoke({
		...options,
		fetch: async (url, init) => {
			const response = await fetchImpl(url, init);
			observation.observedAt = new Date().toISOString();
			observation.status = response.status;
			observation.attempts++;
			observation.requestId = response.headers.get("request-id");
			const organization = response.headers.get("anthropic-organization-id");
			observation.accountScope = organization
				? createHash("sha256").update(organization).digest("hex").slice(0, 12)
				: null;
			observation.retryAfterSeconds = retryAfterSeconds(response.headers.get("retry-after"));
			observation.rateLimit = {};
			for (const [key, value] of response.headers) {
				if (key.startsWith(RATE_LIMIT_PREFIX)) observation.rateLimit[key.slice(RATE_LIMIT_PREFIX.length)] = value;
			}
			return response;
		},
		onProviderStreamEvent: async (data: unknown, eventModel: Model<Api>) => {
			if (isRecord(data) && data.type === "message_start" && isRecord(data.message)) {
				const { content: _content, ...message } = data.message;
				observation.messageStart = structuredClone(message);
			}
			await onProviderStreamEvent?.(data, eventModel);
		},
	} as T);
	const annotate = (terminal: AssistantMessage): void => {
		(terminal as AssistantMessage & { anthropicResponse?: AnthropicResponseObservation }).anthropicResponse = observation;
		if (observation.messageStart === null) return;
		const reported = observation.messageStart.model;
		const reportedModelId = typeof reported === "string" ? reported.trim() : "";
		const modelIdObservation: ResponseModelIdObservation = reportedModelId
			? { state: "reported", reportedModelId }
			: { state: "not-reported" };
		terminal.responseModelIdObservation = modelIdObservation;
		if (reportedModelId && reportedModelId !== model.id) terminal.responseModel = reportedModelId;
	};
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done" || event.type === "error") {
					const terminal = event.type === "done" ? event.message : event.error;
					annotate(terminal);
				}
				output.push(event);
			}
			output.end();
		} catch (cause) {
			const reason = cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error";
			const error: AssistantMessage & { anthropicResponse: AnthropicResponseObservation } = {
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
				anthropicResponse: observation,
			};
			annotate(error);
			output.push({ type: "error", reason, error });
			output.end(error);
		}
	})();
	return output;
}
