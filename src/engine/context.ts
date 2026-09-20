/** Pi owns transcript replay. Clio's local transports consume its resolved snapshot. */
import { type Context, getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";

export { normalizeContext };

export function resolvedRequestContext(context: Context): Context {
	const { messages } = normalizeContext(context);
	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		messages: messages.filter((message) => message.role !== "system"),
	};
}
