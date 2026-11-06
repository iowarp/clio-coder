import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	createInitialSystemMessage,
	getCurrentTools,
	getToolStateChanges,
	toToolDeclaration,
} from "@earendil-works/pi-ai";

/**
 * `messages` as the agent's next request would carry them: the initial system message when the list has none, and
 * the declaration diff Pi appends before a request when the live tool set moved. Executable tools are never cloned.
 */
export function withLiveToolDeclarations(
	messages: AgentMessage[],
	systemPrompt: string,
	tools: ReadonlyArray<AgentTool>,
): AgentMessage[] {
	if (messages[0]?.role !== "system") {
		const initial = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
		if (initial) messages.unshift(initial);
	}
	const changes = getToolStateChanges(getCurrentTools(messages), tools.map(toToolDeclaration));
	if (changes.toolsAdded.length || changes.toolsRemoved.length) {
		messages.push({
			role: "system",
			content: "",
			timestamp: Date.now(),
			...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
			...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}),
		});
	}
	return messages;
}
