import type { Api, AssistantMessage, AssistantMessageEventStream, Model, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Under transport option B Pi serializes and sends the request, so the payload it hands its provider is the request
 * Clio can see. Its size is taken once the call settles, off the send path, and rides the terminal message the way
 * the Codex transport observation does, so stream wrappers that copy the message keep it (#434).
 */
export function observePayloadBytes<T extends StreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	invoke: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	let payload: unknown;
	const onPayload = options?.onPayload;
	const source = invoke({
		...options,
		onPayload: async (body: unknown, payloadModel: Model<Api>) => {
			const replacement = await onPayload?.(body, payloadModel);
			payload = replacement === undefined ? body : replacement;
			return replacement;
		},
	} as T);
	const remember = (message: AssistantMessage): void => {
		if (payload === undefined) return;
		try {
			(message as AssistantMessage & { clioCoderRequestBytes?: number }).clioCoderRequestBytes = Buffer.byteLength(
				JSON.stringify(payload),
			);
		} catch {
			// A payload that cannot be serialized leaves the request size unobserved.
		}
		payload = undefined;
	};
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") remember(event.message);
				else if (event.type === "error") remember(event.error);
				output.push(event);
			}
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
			};
			output.push({ type: "error", reason, error });
			output.end(error);
		}
	})();
	return output;
}
