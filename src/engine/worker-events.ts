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

export interface ToolApprovalRequestPayload {
	requestId: string;
	claudeToolName: string;
	clioToolName: string | null;
	args: Record<string, unknown>;
	classification: { actionClass: string; reasons: ReadonlyArray<string> };
	rejection?: { short: string; detail: string; hints: ReadonlyArray<string> };
	mode: string;
}

export interface ClioToolApprovalRequest {
	type: "clio_tool_approval_request";
	payload: ToolApprovalRequestPayload;
}

export interface ToolApprovalResponsePayload {
	requestId: string;
	decision: "allow" | "deny";
	reason?: string;
}

export interface ClioToolApprovalResponse {
	type: "clio_tool_approval_response";
	payload: ToolApprovalResponsePayload;
}

export type ClioWorkerEvent =
	| ClioToolStartEvent
	| ClioToolFinishEvent
	| ClioToolApprovalRequest
	| ClioToolApprovalResponse;

export function isClioWorkerEvent(value: unknown): value is ClioWorkerEvent {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "clio_tool_start" ||
		type === "clio_tool_finish" ||
		type === "clio_tool_approval_request" ||
		type === "clio_tool_approval_response"
	);
}

export function isToolApprovalRequest(value: unknown): value is ClioToolApprovalRequest {
	if (!value || typeof value !== "object") return false;
	const v = value as { type?: unknown; payload?: unknown };
	if (v.type !== "clio_tool_approval_request") return false;
	if (!v.payload || typeof v.payload !== "object") return false;
	const p = v.payload as Partial<ToolApprovalRequestPayload>;
	return (
		typeof p.requestId === "string" &&
		typeof p.claudeToolName === "string" &&
		(p.clioToolName === null || typeof p.clioToolName === "string") &&
		typeof p.args === "object" &&
		p.args !== null &&
		typeof p.classification === "object" &&
		p.classification !== null &&
		typeof p.mode === "string"
	);
}

export function isToolApprovalResponse(value: unknown): value is ClioToolApprovalResponse {
	if (!value || typeof value !== "object") return false;
	const v = value as { type?: unknown; payload?: unknown };
	if (v.type !== "clio_tool_approval_response") return false;
	if (!v.payload || typeof v.payload !== "object") return false;
	const p = v.payload as Partial<ToolApprovalResponsePayload>;
	return typeof p.requestId === "string" && (p.decision === "allow" || p.decision === "deny");
}
