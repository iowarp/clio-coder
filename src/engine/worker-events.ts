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

/** Emitted when the worker's non-stall policy resolves a permission-requiring tool call. */
export interface ClioPermissionResolvedEvent {
	type: "clio_permission_resolved";
	payload: {
		tool: string;
		actionClass: string;
		mode: "deny" | "fail";
		reason: string;
	};
}

export type ClioWorkerEvent = ClioToolStartEvent | ClioToolFinishEvent | ClioPermissionResolvedEvent;
