import type { AgentMessage } from "../types.js";

/**
 * ACP extensibility reserves `_meta` for non-spec data. Clio namespaces its
 * extensions so a strict client (Zed/serde) never sees an unknown top-level
 * field on a standard response.
 */
export const ACP_USAGE_META_KEY = "clio-coder/usage";
export const ACP_SESSION_META_KEY = "clio-coder/session";
/**
 * Per-frame agent attribution on `session/update`. It names which agent
 * produced the frame so a client can label a message, reasoning item, or tool
 * call instead of attributing every frame to the product. Purely additive: a
 * client that does not read it sees exactly the frames it saw before.
 */
export const ACP_AGENT_META_KEY = "clio-coder/agent";

/**
 * Wire bounds for one prompt turn (CONTRACT C001 §3). A client renders every
 * frame it receives, so an unbounded one is a denial-of-service on the client
 * and a disclosure surface on the server: `rawInput` for a `write` carries the
 * whole file body and for `bash` the whole command line.
 *
 * Every cap is UTF-8 bytes, which is what the peer's read buffer and any
 * intermediary actually spend. `String.length` counts UTF-16 code units, so
 * measuring with it let a chunk of CJK text reach three times its stated bound
 * and a chunk of emoji twice.
 */
export const ACP_MAX_STRING_BYTES = 4096;
export const ACP_MAX_RAW_RECORD_BYTES = 32768;
export const ACP_MAX_CHUNK_BYTES = 16384;

/**
 * Upper bound on a `toolCallId` this server puts on the wire, in UTF-8 bytes
 * (CONTRACT C001 §3). Identity is one call per id in both directions: an engine
 * id over this bound, missing, or already claimed by another call this turn
 * travels under a `clio-tool-<n>` alias, and an engine id starting a second call
 * mints a fresh alias rather than reusing the first call's wire id. A permission
 * request binds only to an id the client already received a `tool_call` for and
 * has not yet seen finish; nothing is minted on that path.
 */
export const ACP_MAX_TOOL_CALL_ID_BYTES = 128;

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

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string;
	type: "agent" | "terminal";
	args?: string[];
	env?: Record<string, string>;
}

export interface AcpInitializeResponse {
	protocolVersion?: number;
	agentCapabilities?: Record<string, unknown>;
	agentInfo?: AcpImplementationInfo;
	authMethods?: AcpAuthMethod[];
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

/** ACP v1 `ToolCallLocation` (schema 0.4.5). */
export interface AcpToolCallLocation {
	/** The file path being accessed or modified. */
	path: string;
	/** Optional zero-based line number within the file. */
	line?: number | null;
	/** ACP extension point. */
	_meta?: unknown;
}

export interface AcpToolCallUpdate {
	sessionUpdate?: "tool_call" | "tool_call_update";
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | string;
	content?: unknown;
	locations?: AcpToolCallLocation[] | null;
	rawInput?: Record<string, unknown>;
	rawOutput?: Record<string, unknown>;
}

export interface AcpSessionUpdateParams {
	sessionId?: string;
	update?: Record<string, unknown>;
	/** Namespaced extension slot; carries replay and agent-attribution metadata. */
	_meta?: Record<string, unknown>;
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
