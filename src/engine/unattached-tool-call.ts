import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { ToolNames } from "../core/tool-names.js";
import { explainToolArgumentsError } from "./tool-argument-refusal.js";

/**
 * Turn a call to a tool that carries no attached schema into the gateway call
 * that reaches it. Models call `grep` or `find` by name although they live behind
 * the gateway; Pi answered `Tool grep not found` and the model repeated the call
 * through the gateway one round later. The rewrite happens before the agent loop
 * sees the message, so the call is a gateway call in history, in the ledger and
 * in every admission step, and it grants nothing: the model could have sent this
 * gateway call itself, and an unknown or unadmitted name gets the gateway's own
 * refusal, which names the capabilities it can use. Malformed arguments stay on
 * the original call, since the gateway would run on the empty object Pi left,
 * and their parse error is rewritten here so Pi's refusal says what to resend.
 */
export function routeUnattachedToolCalls(
	source: AssistantMessageEventStream,
	tools: ReadonlyArray<Tool> | undefined,
	model: Model<Api>,
): AssistantMessageEventStream {
	if (!tools?.length) return source;
	const attached = new Set(tools.map((tool) => tool.name));
	const gateway = attached.has(ToolNames.Gateway);
	const routeCall = (call: ToolCall): ToolCall => {
		if (call.argumentsError !== undefined)
			return { ...call, argumentsError: explainToolArgumentsError(call.argumentsError) };
		if (attached.has(call.name) || !gateway) return call;
		return { ...call, name: ToolNames.Gateway, arguments: { op: "call", capability: call.name, args: call.arguments } };
	};
	const route = (message: AssistantMessage): AssistantMessage => ({
		...message,
		content: message.content.map((block) => (block.type === "toolCall" ? routeCall(block) : block)),
	});
	const output = createAssistantMessageEventStream();
	let lastPartial: AssistantMessage | undefined;
	void (async () => {
		try {
			for await (const event of source) {
				if ("partial" in event) lastPartial = event.partial;
				if (event.type === "toolcall_end")
					output.push({ ...event, toolCall: routeCall(event.toolCall), partial: route(event.partial) });
				else if (event.type === "done") output.push({ ...event, message: route(event.message) });
				else output.push(event);
			}
			output.end(route(await source.result()));
		} catch (cause) {
			const reason = cause instanceof Error && cause.name === "AbortError" ? "aborted" : "error";
			const message: AssistantMessage = {
				...(lastPartial ?? {
					role: "assistant" as const,
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
					timestamp: Date.now(),
				}),
				stopReason: reason,
				errorMessage: cause instanceof Error ? cause.message : String(cause),
			};
			output.push({ type: "error", reason, error: message });
			output.end(message);
		}
	})();
	return output;
}
