import type { CostProvenance } from "../../domains/providers/types/cost-provenance.js";
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
 * Opt-in key for non-terminal `tool_call_update` frames carrying a running
 * tool's cumulative output. It is an opt-in and not a default because a client
 * that renders every frame it receives without collapsing repeated updates for
 * one call would redraw the whole tool segment several times a second.
 */
export const ACP_TOOL_PROGRESS_META_KEY = "clio-coder/toolProgress";
/**
 * Decision facts attached to `session/request_permission`. The server already
 * classifies the ask to pick the option labels; without this the tier, the
 * consequence, and the reversibility it computed are discarded and a client is
 * left re-deriving them from a tool name.
 */
export const ACP_DECISION_META_KEY = "clio-coder/decision";
/**
 * Operator-command catalog and invocation. The names live here, in the leaf
 * that holds every other wire constant, rather than beside the projection in
 * `./commands.js`: that module value-imports the whole slash registry, and the
 * ACP server may not drag the registry's closure into the Stage 0 chunk budget
 * just to know what a method is called (rule6, tests/boundaries).
 */
export const ACP_COMMANDS_META_KEY = "clio-coder/commands";
export const ACP_COMMANDS_LIST_METHOD = "_clio-coder/commands/list";
export const ACP_COMMANDS_INVOKE_METHOD = "_clio-coder/commands/invoke";

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
 * The one raw-record string the generic 4 KiB cap actively harmed. `edit` and
 * `write` put a rendered unified diff on `details.diff`, already capped by the
 * engine's own `MAX_DIFF_BYTES` (32 KiB, `src/tools/edit-diff.ts`). At four
 * context lines and roughly 60 bytes a line, 4 KiB is about 65 diff lines, so a
 * multi-hunk refactor arrived cut mid-hunk and a client could not tell a
 * truncated hunk from a hunk that ended there.
 *
 * It sits below {@link ACP_MAX_RAW_RECORD_BYTES} rather than at it because the
 * record cap elides the WHOLE record when it trips: a diff sized at exactly the
 * record bound would serialize past it once JSON escaping and the rest of the
 * result are counted, and the client would have received `{truncated:true}`
 * instead of the 4 KiB it used to get. The reserve is one
 * {@link ACP_MAX_STRING_BYTES} budget for everything else in the record.
 */
export const ACP_MAX_RAW_DIFF_BYTES = ACP_MAX_RAW_RECORD_BYTES - ACP_MAX_STRING_BYTES;

/**
 * Per-call ceiling on non-terminal tool-progress frames. The tool's own
 * throttle bounds the rate, not the total: a build that prints for ten minutes
 * is a bounded stream of unbounded length, and a client holding per-call state
 * has to be told where the stream stops.
 */
export const ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL = 64;

/**
 * Floor between two progress frames for one call, on top of the 100 ms throttle
 * `src/core/bash-exec.ts` already applies upstream. The upstream throttle is a
 * rendering budget for a terminal that redraws in place; a JSON-RPC peer pays
 * serialization and a full segment re-render per frame, so the wire gets its
 * own, slower floor.
 */
export const ACP_MIN_TOOL_PROGRESS_INTERVAL_MS = 250;

/**
 * Upper bound on a `toolCallId` this server puts on the wire, in UTF-8 bytes
 * (CONTRACT C001 §3). Identity is one call per id in both directions: an engine
 * id over this bound, missing, or already claimed by another call this turn
 * travels under a `clio-coder-tool-<n>` alias, and an engine id starting a second call
 * mints a fresh alias rather than reusing the first call's wire id. A permission
 * request binds only to an id the client already received a `tool_call` for and
 * has not yet seen finish; nothing is minted on that path.
 */
export const ACP_MAX_TOOL_CALL_ID_BYTES = 128;

/** ACP v1 `ToolKind` closed enum (schema v1.23.0). */
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

/** ACP v1 `ToolCallStatus` closed enum (schema v1.23.0). */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

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
	protocolVersion: number;
	agentCapabilities?: Record<string, unknown>;
	agentInfo?: AcpImplementationInfo;
	authMethods?: AcpAuthMethod[];
}

export interface AcpSessionInfo {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
	_meta?: Record<string, unknown>;
}

export interface AcpContentText {
	type: "text";
	text: string;
}

export interface AcpContentResourceLink {
	type: "resource_link";
	uri: string;
	name: string;
	mimeType?: string;
}

export type AcpContentBlock = AcpContentText | AcpContentResourceLink | Record<string, unknown>;

/** ACP v1 `ToolCallLocation` (schema v1.23.0). */
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
	/** A valid peer token field was present, including an explicit zero. */
	tokensReported: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	/** Peer-reported total when present, otherwise input+output+cacheRead+cacheWrite, matching the ACP server side. */
	totalTokens: number;
	/** Sum of peer cost.total (legacy) or costUsd (Clio metadata); never re-priced. */
	costUsd: number;
	/** Absent until usage is reported; missing or unsupported pricing provenance stays unknown. */
	costProvenance?: CostProvenance;
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
		selectedModelId?: string;
		initialize: AcpInitializeResponse | null;
		toolCallsRequested: number;
		toolCallsApproved: number;
		toolCallsDenied: number;
	};
}
