import type { AgentMessage } from "../types.js";

/**
 * ACP extensibility reserves `_meta` for non-spec data. Clio namespaces its
 * extensions so a strict client (Zed/serde) never sees an unknown top-level
 * field on a standard response.
 */
export const ACP_USAGE_META_KEY = "clio.coder/usage";
export const ACP_SESSION_META_KEY = "clio.coder/session";

/** ACP v1 `ToolKind` closed enum (schema 0.4.5). */
export type AcpToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";

/** ACP v1 `ToolCallStatus` closed enum (schema 0.4.5). */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpJsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcSuccess {
	jsonrpc: "2.0";
	id: string | number;
	result: unknown;
}

export interface AcpJsonRpcFailure {
	jsonrpc: "2.0";
	id: string | number | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type AcpJsonRpcMessage = AcpJsonRpcRequest | AcpJsonRpcNotification | AcpJsonRpcSuccess | AcpJsonRpcFailure;

export interface AcpImplementationInfo {
	name?: string;
	title?: string;
	version?: string;
}

export interface AcpInitializeResponse {
	protocolVersion?: number;
	agentCapabilities?: Record<string, unknown>;
	agentInfo?: AcpImplementationInfo;
	authMethods?: unknown[];
}

export interface AcpSessionInfo {
	sessionId: string;
	title?: string;
	cwd?: string;
	updatedAt?: string;
	messageCount?: number;
}

export interface AcpContentText {
	type: "text";
	text: string;
}

export interface AcpContentResourceLink {
	type: "resource_link";
	uri: string;
	name?: string;
	mimeType?: string;
}

export type AcpContentBlock = AcpContentText | AcpContentResourceLink | Record<string, unknown>;

export interface AcpToolCallUpdate {
	sessionUpdate?: "tool_call" | "tool_call_update";
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | string;
	content?: unknown;
	locations?: unknown;
	rawInput?: Record<string, unknown>;
	rawOutput?: Record<string, unknown>;
}

export interface AcpSessionUpdateParams {
	sessionId?: string;
	update?: Record<string, unknown>;
}

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;

export interface AcpPermissionOption {
	optionId: string;
	name?: string;
	kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
	sessionId?: string;
	toolCall?: AcpToolCallUpdate;
	options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpRequestPermissionResponse {
	outcome: AcpPermissionOutcome;
}

export interface AcpPromptResponse {
	stopReason?: string;
	usage?: unknown;
	tokenUsage?: unknown;
	_meta?: unknown;
}

export interface AcpDelegationUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

export interface AcpDelegationResult {
	messages: AgentMessage[];
	exitCode: number;
	stopReason: string;
	/** True when the turn request hit its configured timeout. */
	timedOut?: boolean;
	failureMessage?: string;
	usage: AcpDelegationUsage;
	delegation: {
		acpSessionId: string | null;
		initialize: AcpInitializeResponse | null;
		toolCallsRequested: number;
		toolCallsApproved: number;
		toolCallsDenied: number;
	};
}
