import type { AgentMessage } from "../engine/types.js";

/** Only host-authored, typed posture updates retain system authority on rebuild (#423). */
export function isHostPolicyMessage(message: AgentMessage): boolean {
	const marker = (message as AgentMessage & { clio_coder_policy?: { version?: unknown; id?: unknown } })
		.clio_coder_policy;
	return message.role === "system" && marker?.version === 1 && typeof marker.id === "string";
}

export function createHostPolicyMessage(id: string, content: string, timestamp: number): AgentMessage {
	return { role: "system", content, timestamp, clio_coder_policy: { version: 1, id } } as AgentMessage;
}
