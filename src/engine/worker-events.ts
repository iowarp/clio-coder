/**
 * Clio-specific events that ride the same NDJSON IPC channel as
 * pi-agent-core's `AgentEvent`. The worker subprocess emits these alongside
 * AgentEvents; the dispatch parent decodes the union and aggregates Clio
 * events without disturbing pi-agent-core consumers.
 */

import type { ToolFinishEvent, ToolStartEvent } from "./worker-tools.js";

export interface ClioToolStartEvent {
	type: "clio_tool_start";
	payload: ToolStartEvent;
}

export interface ClioToolFinishEvent {
	type: "clio_tool_finish";
	payload: ToolFinishEvent;
}

export type ClioWorkerEvent = ClioToolStartEvent | ClioToolFinishEvent;

export function isClioWorkerEvent(value: unknown): value is ClioWorkerEvent {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return type === "clio_tool_start" || type === "clio_tool_finish";
}
