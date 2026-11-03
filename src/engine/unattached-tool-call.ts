import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { ToolNames } from "../core/tool-names.js";

/**
 * Turn a call to a tool that carries no attached schema into the gateway call
 * that reaches it. Models call `grep` or `find` by name although they live behind
 * the gateway; Pi answered `Tool grep not found` and the model repeated the call
 * through the gateway one round later. The rewrite happens before the agent loop
 * sees the message, so the call is a gateway call in history, in the ledger and
 * in every admission step, and it grants nothing: the model could have sent this
 * gateway call itself, and an unknown or unadmitted name gets the gateway's own
 * refusal, which names the capabilities it can use. Malformed arguments stay on
 * the original call, since the gateway would run on the empty object Pi left.
 */
export function routeUnattachedToolCalls(
	source: AssistantMessageEventStream,
	tools: ReadonlyArray<Tool> | undefined,
): AssistantMessageEventStream {
	if (!tools?.some((tool) => tool.name === ToolNames.Gateway)) return source;
	const attached = new Set(tools.map((tool) => tool.name));
	const routeCall = (call: ToolCall): ToolCall =>
		attached.has(call.name) || call.argumentsError !== undefined
			? call
			: { ...call, name: ToolNames.Gateway, arguments: { op: "call", capability: call.name, args: call.arguments } };
	const route = (message: AssistantMessage): AssistantMessage => ({
		...message,
		content: message.content.map((block) => (block.type === "toolCall" ? routeCall(block) : block)),
	});
	const output = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (event.type === "toolcall_end")
				output.push({ ...event, toolCall: routeCall(event.toolCall), partial: route(event.partial) });
			else if (event.type === "done") output.push({ ...event, message: route(event.message) });
			else output.push(event);
		}
		output.end(route(await source.result()));
	})();
	return output;
}
