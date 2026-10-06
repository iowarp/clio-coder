import type { Static } from "typebox";
import { Type } from "typebox";
import type { ProjectTrustSurface, WorkspaceTrustVerdict } from "../../core/workspace-trust.js";
import type { CostProvenance } from "../../domains/providers/types/cost-provenance.js";
import type { ViewArtifactCategory, ViewArtifactFormat } from "../../domains/session/view-artifacts.js";
import type { UserTask } from "../../domains/user-tasks/store.js";
import type { DispatchPlanView } from "../../tools/dispatch-plan.js";
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
 * Attended-surface opt-ins. A client that advertises one at initialize says a
 * person is there to answer, which is the only thing that makes the runtime
 * ask. A client that advertises neither keeps the unattended behavior: no
 * `ask_user` tool, no merge card, worker permission asks denied at once.
 * The interview names live in this leaf for the reason the commands names do.
 */
export const ACP_INTERVIEWS_META_KEY = "clio-coder/interviews";
export const ACP_INTERVIEW_REQUEST_METHOD = "_clio-coder/interview/request";
export const ACP_INTERVIEW_CANCEL_METHOD = "_clio-coder/interview/cancel";
/**
 * `clio-coder/workerPermissions` asks the host to forward a dispatched worker's
 * permission ask as `session/request_permission`. The client must also name the
 * notification it takes a withdrawn ask on, because the wire has no way to cancel
 * one request: an ask the worker already gave up on would otherwise sit on the
 * client and refuse the next real approval.
 */
export const ACP_WORKER_PERMISSIONS_META_KEY = "clio-coder/workerPermissions";
export const ACP_PERMISSION_WITHDRAW_METHOD = "_clio-coder/permission/withdraw";
/** Provenance a forwarded worker ask carries beside the decision facts. */
export const ACP_WORKER_ASK_META_KEY = "clio-coder/workerAsk";

/**
 * Every other `_clio-coder/*` method, notification and `_meta` key. The feature
 * modules re-export the names they own, so a client in another process (the GUI
 * server and its browser bundle) can import this leaf alone and never spell a
 * wire name of its own.
 */
export const ACP_ERROR_META_KEY = "clio-coder/error";
export const ACP_REPLAY_META_KEY = "clio-coder/replay";
export const ACP_NOTICE_META_KEY = "clio-coder/notice";
export const ACP_EGGS_META_KEY = "clio-coder/eggs";
/** `{ state }` of the always-on memory guardian, pushed on `session_info_update` when it changes. */
export const ACP_MEMORY_META_KEY = "clio-coder/memory";
export const ACP_TURN_META_KEY = "clio-coder/turn";
export const ACP_TRUNCATED_META_KEY = "clio-coder/truncated";
export const ACP_TOOLS_META_KEY = "clio-coder/tools";
export const ACP_RECEIPT_META_KEY = "clio-coder/receipt";
export const ACP_DISPATCH_PLAN_META_KEY = "clio-coder/dispatchPlan";
export const ACP_WORKSPACE_META_KEY = "clio-coder/workspace";
export const ACP_PLAN_META_KEY = "clio-coder/plan";
export const ACP_TRUST_META_KEY = "clio-coder/trust";
export const ACP_SESSION_TRUST_METHOD = "_clio-coder/session/trust";
export const ACP_SESSION_LABEL_METHOD = "_clio-coder/session/label";
export const ACP_SESSION_LIST_METHOD = "session/list";
export const ACP_SETTINGS_META_KEY = "clio-coder/settings";
export const ACP_SETTINGS_GET_SAFE_METHOD = "_clio-coder/settings/get_safe";
export const ACP_SETTINGS_PATCH_SAFE_METHOD = "_clio-coder/settings/patch_safe";
export const ACP_TARGETS_META_KEY = "clio-coder/targets";
export const ACP_TARGETS_LIST_METHOD = "_clio-coder/targets/list";
export const ACP_TARGETS_PROBE_METHOD = "_clio-coder/targets/probe";
export const ACP_STEERING_META_KEY = "clio-coder/steering";
export const ACP_SESSION_STEER_METHOD = "_clio-coder/session/steer";
export const ACP_SESSION_QUEUE_METHOD = "_clio-coder/session/queue";
export const ACP_SESSION_QUEUE_CLEAR_METHOD = "_clio-coder/session/queue_clear";
export const ACP_SESSION_INTERRUPT_METHOD = "_clio-coder/session/interrupt";
export const ACP_DISPATCH_STEER_METHOD = "_clio-coder/dispatch/steer";
export const ACP_QUEUE_META_KEY = "clio-coder/queue";
export const ACP_QUEUE_EDIT_METHOD = "_clio-coder/session/queue_edit";
export const ACP_QUEUE_CHANGED_NOTIFICATION = "_clio-coder/session/queue_changed";
export const ACP_SHELL_META_KEY = "clio-coder/shell";
export const ACP_SESSION_SHELL_METHOD = "_clio-coder/session/shell";
export const ACP_EVENTS_META_KEY = "clio-coder/events";
export const ACP_EVENT_NOTIFICATION = "_clio-coder/event";
export const ACP_BOARD_META_KEY = "clio-coder/board";
export const ACP_BOARD_METHOD = "_clio-coder/session/board";
export const ACP_DECISION_SUPERSEDE_METHOD = "_clio-coder/decisions/supersede";
export const ACP_MEMORY_PROPOSE_METHOD = "_clio-coder/memory/propose";
export const ACP_BRANCHES_META_KEY = "clio-coder/branches";
export const ACP_SESSION_TREE_METHOD = "_clio-coder/session/tree";
export const ACP_SESSION_SWITCH_TURN_METHOD = "_clio-coder/session/switch_turn";
export const ACP_SESSION_FORK_METHOD = "_clio-coder/session/fork";
export const ACP_HANDOFF_META_KEY = "clio-coder/handoff";
export const ACP_HANDOFF_PREPARE_METHOD = "_clio-coder/session/handoff/prepare";
export const ACP_HANDOFF_COMMIT_METHOD = "_clio-coder/session/handoff/commit";
export const ACP_HANDOFF_CANCEL_METHOD = "_clio-coder/session/handoff/cancel";
export const ACP_JOBS_META_KEY = "clio-coder/jobs";
export const ACP_JOBS_LIST_METHOD = "_clio-coder/jobs/list";
export const ACP_FLEET_META_KEY = "clio-coder/fleet";
export const ACP_FLEET_PREVIEW_METHOD = "_clio-coder/fleet/preview";
export const ACP_FLEET_RUN_METHOD = "_clio-coder/fleet/run";
export const ACP_CONTEXT_META_KEY = "clio-coder/context";
export const ACP_CONTEXT_LEDGER_METHOD = "_clio-coder/context/ledger";
export const ACP_ARTIFACTS_META_KEY = "clio-coder/artifacts";
export const ACP_ARTIFACTS_LIST_METHOD = "_clio-coder/artifacts/list";
export const ACP_ARTIFACTS_READ_METHOD = "_clio-coder/artifacts/read";
export const ACP_EXTENSIONS_META_KEY = "clio-coder/extensions";
export const ACP_EXTENSIONS_LIST_METHOD = "_clio-coder/extensions/list";
export const ACP_EXTENSIONS_RELOAD_METHOD = "_clio-coder/extensions/reload";
export const ACP_LIBRARY_META_KEY = "clio-coder/library";
export const ACP_LIBRARY_RELOAD_METHOD = "_clio-coder/library/reload";
export const ACP_ASIDE_META_KEY = "clio-coder/aside";
export const ACP_ASIDE_ASK_METHOD = "_clio-coder/aside/ask";
export const ACP_ASIDE_DRAFT_METHOD = "_clio-coder/aside/draft";
export const ACP_ASIDE_CANCEL_METHOD = "_clio-coder/aside/cancel";
export const ACP_ACCOUNTING_META_KEY = "clio-coder/accounting";
export const ACP_USAGE_READ_METHOD = "_clio-coder/usage/read";

/** Every thinking level a safe-settings patch or the `thinkingLevel` config option may name, weakest first. */
export const ACP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AcpThinkingLevel = (typeof ACP_THINKING_LEVELS)[number];

/** Wire bounds on `_clio-coder/targets/list`: targets per response and model ids per target. */
export const ACP_MAX_TARGETS = 64;
export const ACP_TARGET_MODEL_LIMIT = 64;
export const ACP_MAX_TARGET_ID_BYTES = 128;
export const ACP_MAX_MODEL_ID_BYTES = 256;

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

/* -------------------------------------------------------------------------- */
/* Extension wire shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Shapes a client in another process validates at runtime are TypeBox schemas,
 * declared here once with their static type. The server builds its payloads
 * against the static type and the client checks the same schema, so the two
 * sides cannot drift. Every schema is closed: a client that runs `Value.Clean`
 * first reads a newer engine's extra fields as absent instead of invalid.
 */
const closed = { additionalProperties: false };
const wireMethod = Type.String({ maxLength: 128 });

/** `agentCapabilities._meta["clio-coder/settings"]`. */
export const AcpSettingsCapability = Type.Object({ get_safe: Type.Boolean(), patch_safe: Type.Boolean() }, closed);
export type AcpSettingsCapability = Static<typeof AcpSettingsCapability>;
/** `agentCapabilities._meta["clio-coder/targets"]`. */
export const AcpTargetsCapability = Type.Object({ list: Type.Boolean(), probe: Type.Boolean() }, closed);
export type AcpTargetsCapability = Static<typeof AcpTargetsCapability>;
export const AcpSteeringCapability = Type.Object(
	{
		version: Type.Literal(1),
		main: Type.Boolean(),
		dispatch: Type.Boolean(),
		modes: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }),
		interrupt: Type.Boolean(),
		methods: Type.Object(
			{ steer: wireMethod, queue: wireMethod, clear: wireMethod, interrupt: wireMethod, dispatch: wireMethod },
			closed,
		),
	},
	closed,
);
export type AcpSteeringCapability = Static<typeof AcpSteeringCapability>;
export const AcpCommandsCapability = Type.Object(
	{
		version: Type.Literal(1),
		list: wireMethod,
		invoke: wireMethod,
		count: Type.Optional(Type.Integer({ minimum: 0 })),
		promptTurns: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type AcpCommandsCapability = Static<typeof AcpCommandsCapability>;
export const AcpToolProgressCapability = Type.Object(
	{
		version: Type.Literal(1),
		minIntervalMs: Type.Integer({ minimum: 0 }),
		maxFramesPerCall: Type.Integer({ minimum: 0 }),
		maxContentBytes: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type AcpToolProgressCapability = Static<typeof AcpToolProgressCapability>;
/** Per-entry queue operations and the notification that pushes the queue after every change. */
export const AcpQueueCapability = Type.Object(
	{
		version: Type.Literal(1),
		edit: wireMethod,
		ops: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 16 }),
		notification: wireMethod,
	},
	closed,
);
export type AcpQueueCapability = Static<typeof AcpQueueCapability>;
/** The operator's `!` line. `timeoutMs` is how long the engine lets one line run. */
export const AcpShellCapability = Type.Object(
	{ version: Type.Literal(1), run: wireMethod, timeoutMs: Type.Integer({ minimum: 1 }) },
	closed,
);
export type AcpShellCapability = Static<typeof AcpShellCapability>;
export const AcpDecisionCapability = Type.Object(
	{
		version: Type.Literal(1),
		meta: Type.String({ maxLength: 64 }),
		options: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 }),
	},
	closed,
);
export type AcpDecisionCapability = Static<typeof AcpDecisionCapability>;
export const AcpEventsCapability = Type.Object(
	{
		version: Type.Literal(1),
		notification: Type.String({ maxLength: 64 }),
		kinds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
		workspaceInstanceId: Type.String({ maxLength: 128 }),
	},
	closed,
);
export type AcpEventsCapability = Static<typeof AcpEventsCapability>;
export const AcpBoardCapability = Type.Object(
	{
		version: Type.Literal(1),
		method: wireMethod,
		/** Present when the agent accepts the board's two writes. */
		supersede: Type.Optional(wireMethod),
		proposeMemory: Type.Optional(wireMethod),
	},
	closed,
);
export type AcpBoardCapability = Static<typeof AcpBoardCapability>;
export const AcpBranchesCapability = Type.Object(
	{ version: Type.Literal(1), tree: wireMethod, switchTurn: wireMethod, fork: wireMethod },
	closed,
);
export type AcpBranchesCapability = Static<typeof AcpBranchesCapability>;
export const AcpHandoffCapability = Type.Object(
	{ version: Type.Literal(1), prepare: wireMethod, commit: wireMethod, cancel: wireMethod },
	closed,
);
export type AcpHandoffCapability = Static<typeof AcpHandoffCapability>;
export const AcpFleetCapability = Type.Object(
	{
		version: Type.Literal(1),
		preview: wireMethod,
		run: wireMethod,
		/** Terminal dispatch frames carry `_meta["clio-coder/receipt"]`. */
		receiptFacts: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type AcpFleetCapability = Static<typeof AcpFleetCapability>;
/**
 * The session's recurring jobs: `list` answers the current set, and `job.changed`
 * under `clio-coder/events` carries each later change. Neither replaces the other:
 * a client lists after it binds or resumes, then folds the events.
 */
export const AcpJobsCapability = Type.Object(
	{ version: Type.Literal(1), list: wireMethod, event: Type.Literal("job.changed") },
	closed,
);
export type AcpJobsCapability = Static<typeof AcpJobsCapability>;
const jobIdentifier = Type.String({ maxLength: 128 });
const jobCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const jobTime = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
/**
 * One job as `_clio-coder/jobs/list` and `job.changed` carry it. Every figure is
 * the canonical record's own, bounded for the wire: counts, `nextDueAt` and
 * `deadlineAt` are never derived by a client, `costUsd` is null when the record
 * says pricing is unknown, and `last` is absent until a run settled. The exact
 * prompt and argv never cross; `taskPreview` is a bounded prefix. `revision` is
 * the record's own and rises with every committed change, so a client replaces a
 * job only by an equal or newer one. `turn` is true while a scheduled main turn
 * of this job streams `session/update` frames, which is the only bracket those
 * frames have because no `session/prompt` owns them.
 */
export const AcpJob = Type.Object(
	{
		jobId: jobIdentifier,
		revision: jobCount,
		state: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("terminal")]),
		reason: Type.Union([
			Type.Literal("count"),
			Type.Literal("condition"),
			Type.Literal("stopped"),
			Type.Literal("canceled"),
			Type.Literal("deadline"),
			Type.Literal("failure"),
			Type.Null(),
		]),
		runner: Type.Union([Type.Literal("main"), Type.Literal("command")]),
		taskPreview: Type.String({ maxLength: 192 }),
		intervalMs: jobCount,
		count: jobCount,
		starts: jobCount,
		settled: jobCount,
		timeoutMs: jobCount,
		nextDueAt: jobTime,
		deadlineAt: jobTime,
		cancelRequested: Type.Boolean(),
		running: Type.Boolean(),
		turn: Type.Boolean(),
		pendingReason: Type.Union([Type.String({ maxLength: 320 }), Type.Null()]),
		consecutiveFailures: jobCount,
		last: Type.Union([
			Type.Object(
				{
					outcome: Type.Union([
						Type.Literal("succeeded"),
						Type.Literal("failed"),
						Type.Literal("noop"),
						Type.Literal("canceled"),
						Type.Literal("timed_out"),
						Type.Literal("interrupted"),
					]),
					summary: Type.String({ maxLength: 320 }),
					truncated: Type.Boolean(),
				},
				closed,
			),
			Type.Null(),
		]),
		delivery: Type.Union([
			Type.Object(
				{
					kind: Type.Union([Type.Literal("notice"), Type.Literal("main_turn")]),
					state: Type.Union([
						Type.Literal("pending"),
						Type.Literal("running"),
						Type.Literal("delivered"),
						Type.Literal("dropped"),
						Type.Literal("failed"),
					]),
				},
				closed,
			),
			Type.Null(),
		]),
		costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		saved: Type.Boolean(),
		/** False while polling may have ended but an analysis delivery, cancel or cleanup is unresolved. */
		complete: Type.Boolean(),
	},
	closed,
);
export type AcpJob = Static<typeof AcpJob>;
/** The most jobs one list or one client's view carries. */
export const ACP_MAX_JOBS = 32;
export const AcpJobList = Type.Object({ jobs: Type.Array(AcpJob, { maxItems: ACP_MAX_JOBS }) }, closed);
export type AcpJobList = Static<typeof AcpJobList>;
export const AcpContextCapability = Type.Object({ version: Type.Literal(1), ledger: wireMethod }, closed);
export type AcpContextCapability = Static<typeof AcpContextCapability>;
export const AcpArtifactsCapability = Type.Object(
	{
		version: Type.Literal(1),
		list: Type.String({ maxLength: 8192 }),
		read: Type.String({ maxLength: 8192 }),
		categories: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 32 }),
		perCategory: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type AcpArtifactsCapability = Static<typeof AcpArtifactsCapability>;
export const AcpExtensionsCapability = Type.Object(
	{ version: Type.Literal(1), list: wireMethod, reload: wireMethod },
	closed,
);
export type AcpExtensionsCapability = Static<typeof AcpExtensionsCapability>;
export const AcpLibraryCapability = Type.Object({ version: Type.Literal(1), reload: wireMethod }, closed);
export type AcpLibraryCapability = Static<typeof AcpLibraryCapability>;
const draftCount = Type.Integer({ minimum: 1, maximum: 4 });
export const AcpAsideCapability = Type.Object(
	{
		version: Type.Literal(1),
		ask: wireMethod,
		draft: wireMethod,
		cancel: wireMethod,
		draftCounts: Type.Object({ min: draftCount, max: draftCount, default: draftCount }, closed),
	},
	closed,
);
export type AcpAsideCapability = Static<typeof AcpAsideCapability>;
/** `agentCapabilities._meta["clio-coder/accounting"]`. */
export const AcpUsageCapability = Type.Object({ version: Type.Literal(1), read: wireMethod }, closed);
export type AcpUsageCapability = Static<typeof AcpUsageCapability>;
/** Additive bridge: the runtime announces it only to a client that opted in at initialize. */
export const AcpInterviewsCapability = Type.Object(
	{
		version: Type.Literal(1),
		request: Type.Literal(ACP_INTERVIEW_REQUEST_METHOD),
		cancel: Type.Optional(Type.Literal(ACP_INTERVIEW_CANCEL_METHOD)),
	},
	closed,
);
export type AcpInterviewsCapability = Static<typeof AcpInterviewsCapability>;

/** A wire value as the server holds it: its constant tables are readonly and serialize the same. */
export type AcpWire<T> =
	T extends ReadonlyArray<infer E>
		? ReadonlyArray<AcpWire<E>>
		: T extends object
			? { readonly [K in keyof T]: AcpWire<T[K]> }
			: T;

/** The trust report's capability entry. `surfaces` are `ProjectTrustSurface` names. */
export interface AcpTrustCapability {
	version: 1;
	meta: typeof ACP_TRUST_META_KEY;
	surfaces: ReadonlyArray<string>;
	refresh: typeof ACP_SESSION_TRUST_METHOD;
	results: ReadonlyArray<string>;
}

/**
 * `agentCapabilities._meta` as `initialize` answers it. The server's literal
 * `satisfies` this, so an extension it announces under a key or in a shape this
 * interface does not name fails the build instead of reaching a client.
 */
export interface AcpAgentCapabilitiesMeta {
	[ACP_SESSION_META_KEY]: { close: boolean; label: boolean };
	[ACP_SETTINGS_META_KEY]: AcpSettingsCapability;
	[ACP_TARGETS_META_KEY]: AcpTargetsCapability;
	[ACP_TRUST_META_KEY]: AcpTrustCapability;
	[ACP_COMMANDS_META_KEY]?: AcpCommandsCapability;
	[ACP_STEERING_META_KEY]: AcpWire<AcpSteeringCapability>;
	[ACP_AGENT_META_KEY]: { version: 1; meta: typeof ACP_AGENT_META_KEY };
	[ACP_TOOL_PROGRESS_META_KEY]: AcpToolProgressCapability;
	[ACP_DECISION_META_KEY]?: AcpWire<AcpDecisionCapability>;
	[ACP_EVENTS_META_KEY]?: AcpWire<AcpEventsCapability>;
	[ACP_TOOLS_META_KEY]?: "mediated";
	[ACP_BOARD_META_KEY]?: AcpBoardCapability;
	[ACP_BRANCHES_META_KEY]?: AcpBranchesCapability;
	[ACP_EXTENSIONS_META_KEY]?: AcpExtensionsCapability;
	[ACP_LIBRARY_META_KEY]?: AcpLibraryCapability;
	[ACP_ACCOUNTING_META_KEY]?: AcpUsageCapability;
	[ACP_WORKSPACE_META_KEY]?: { version: 1; update: "session_info_update" };
	[ACP_ASIDE_META_KEY]?: AcpAsideCapability;
	[ACP_INTERVIEWS_META_KEY]?: AcpInterviewsCapability;
	[ACP_CONTEXT_META_KEY]?: AcpContextCapability;
	[ACP_ARTIFACTS_META_KEY]?: AcpWire<AcpArtifactsCapability>;
	[ACP_FLEET_META_KEY]?: AcpFleetCapability;
	[ACP_JOBS_META_KEY]?: AcpJobsCapability;
	[ACP_HANDOFF_META_KEY]?: AcpHandoffCapability;
	[ACP_SHELL_META_KEY]?: AcpShellCapability;
	[ACP_QUEUE_META_KEY]?: AcpWire<AcpQueueCapability>;
}

/** What a client announces under `clientCapabilities._meta` to opt in to the attended extensions. */
export interface AcpClientCapabilitiesMeta {
	[ACP_EVENTS_META_KEY]?: { version: 1; kinds: ReadonlyArray<string> };
	[ACP_TOOL_PROGRESS_META_KEY]?: { version: 1 };
	[ACP_QUEUE_META_KEY]?: { version: 1 };
	[ACP_INTERVIEWS_META_KEY]?: {
		version: 1;
		request: typeof ACP_INTERVIEW_REQUEST_METHOD;
		cancel?: typeof ACP_INTERVIEW_CANCEL_METHOD;
	};
	[ACP_WORKER_PERMISSIONS_META_KEY]?: { version: 1; withdraw: typeof ACP_PERMISSION_WITHDRAW_METHOD };
}

const noControls = "^[^\\u0000-\\u001f\\u007f]+$";
const settingTarget = Type.Union([
	Type.String({ minLength: 1, maxLength: ACP_MAX_TARGET_ID_BYTES, pattern: noControls }),
	Type.Null(),
]);
const settingModel = Type.Union([
	Type.String({ minLength: 1, maxLength: ACP_MAX_MODEL_ID_BYTES, pattern: noControls }),
	Type.Null(),
]);
export const AcpThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export type AcpAutonomyLevel = "default" | "yolo";
export const AcpAutonomyLevelSchema = Type.Union([Type.Literal("default"), Type.Literal("yolo")]);
export const ACP_SAFE_SETTINGS_KEYS = ["chat.target", "chat.model", "chat.thinkingLevel", "safety.autonomy"] as const;
/** `params.patch` of `_clio-coder/settings/patch_safe`. */
export const AcpSafeSettingsPatchSchema = Type.Object(
	{
		"chat.target": Type.Optional(settingTarget),
		"chat.model": Type.Optional(settingModel),
		"chat.thinkingLevel": Type.Optional(AcpThinkingLevelSchema),
		"safety.autonomy": Type.Optional(AcpAutonomyLevelSchema),
	},
	closed,
);
export type AcpSafeSettingsPatch = Static<typeof AcpSafeSettingsPatchSchema>;
/** The result of `_clio-coder/settings/get_safe` and `_clio-coder/settings/patch_safe`. */
export const AcpSafeSettings = Type.Object(
	{
		settings: Type.Object(
			{
				chat: Type.Object({ target: settingTarget, model: settingModel, thinkingLevel: AcpThinkingLevelSchema }, closed),
				safety: Type.Object({ autonomy: AcpAutonomyLevelSchema }, closed),
			},
			closed,
		),
		editable: Type.Array(
			Type.Union([
				Type.Literal("chat.target"),
				Type.Literal("chat.model"),
				Type.Literal("chat.thinkingLevel"),
				Type.Literal("safety.autonomy"),
			]),
			{ maxItems: 4, minItems: 4, uniqueItems: true },
		),
	},
	closed,
);
export type AcpSafeSettings = Static<typeof AcpSafeSettings>;

/** One configured target in `_clio-coder/targets/list`. */
export const AcpTarget = Type.Object(
	{
		id: Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }),
		runtime: Type.String({ maxLength: 64 }),
		/** Default, declared and discovered model ids, deduplicated, at most {@link ACP_TARGET_MODEL_LIMIT}. */
		models: Type.Array(Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), { maxItems: ACP_TARGET_MODEL_LIMIT }),
		/** True when the target knows more model ids than `models` carries. */
		modelsTruncated: Type.Optional(Type.Boolean()),
		thinkingLevels: Type.Optional(
			Type.Record(
				Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }),
				Type.Array(Type.String({ maxLength: 16 }), { maxItems: ACP_THINKING_LEVELS.length }),
			),
		),
		isOrchestrator: Type.Boolean(),
		/** The endpoint with credentials, query and fragment removed; null when the target has none. */
		url: Type.Optional(Type.Union([Type.String({ maxLength: 2048 }), Type.Null()])),
		defaultModel: Type.Optional(Type.Union([Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), Type.Null()])),
		available: Type.Optional(Type.Boolean()),
		/** The provider domain's health status as this process last observed it. */
		health: Type.Optional(Type.String({ maxLength: 64 })),
		tier: Type.Optional(Type.String({ maxLength: 64 })),
		contextWindow: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])),
	},
	closed,
);
export type AcpTarget = Static<typeof AcpTarget>;
/** The result of `_clio-coder/targets/list`. `_meta["clio-coder/truncated"]` marks a list cut at the line budget. */
export const AcpTargetList = Type.Object(
	{
		targets: Type.Array(AcpTarget, { maxItems: ACP_MAX_TARGETS }),
		_meta: Type.Optional(Type.Object({ [ACP_TRUNCATED_META_KEY]: Type.Optional(Type.Boolean()) }, closed)),
	},
	closed,
);
export type AcpTargetList = Static<typeof AcpTargetList>;
/** The result of `_clio-coder/targets/probe`. */
export const AcpTargetProbe = Type.Object(
	{
		targetId: Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }),
		healthy: Type.Boolean(),
		latencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		reason: Type.Union([
			Type.Null(),
			Type.Literal("not-configured"),
			Type.Literal("unreachable"),
			Type.Literal("unsupported"),
			Type.Literal("probe-failed"),
		]),
	},
	closed,
);
export type AcpTargetProbe = Static<typeof AcpTargetProbe>;

/**
 * `_meta["clio-coder/session"]` on each `session/list` row: the ledger facts a
 * history view shows that the stable `SessionInfo` has no field for.
 */
export const AcpSessionListMeta = Type.Object(
	{
		createdAt: Type.String({ maxLength: 64 }),
		endedAt: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
		target: Type.Union([Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }), Type.Null()]),
		model: Type.Union([Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), Type.Null()]),
		firstMessagePreview: Type.Optional(Type.String({ maxLength: 1024 })),
		messageCount: Type.Optional(Type.Integer({ minimum: 0 })),
		hasModelTurn: Type.Optional(Type.Boolean()),
		lastActivityAt: Type.Optional(Type.String({ maxLength: 64 })),
	},
	closed,
);
export type AcpSessionListMeta = Static<typeof AcpSessionListMeta>;
/** One `session/list` row as a client reads it. */
export const AcpSessionListRow = Type.Object(
	{
		sessionId: Type.String({ minLength: 1, maxLength: 128 }),
		cwd: Type.String({ maxLength: 4096 }),
		title: Type.Optional(Type.String({ maxLength: 256 })),
		updatedAt: Type.String({ maxLength: 64 }),
		_meta: Type.Optional(Type.Object({ [ACP_SESSION_META_KEY]: AcpSessionListMeta }, closed)),
	},
	closed,
);
export type AcpSessionListRow = Static<typeof AcpSessionListRow>;
/** The result of `session/list`: one page of workspace history, newest first. */
export const AcpSessionList = Type.Object(
	{
		sessions: Type.Array(AcpSessionListRow, { maxItems: 50 }),
		nextCursor: Type.Optional(Type.String({ maxLength: 512 })),
	},
	closed,
);
export type AcpSessionList = Static<typeof AcpSessionList>;

/** `_meta["clio-coder/session"]` on a `session/new`, `session/load`, `session/resume`, fork or handoff result. */
export interface AcpSessionResultMeta {
	sessionId: string;
	target: string | null;
	model: string | null;
	autonomy: string;
	createdAt: string;
	resumed: boolean;
	replayed?: { turns: number; truncated: boolean };
}
/** `_meta["clio-coder/turn"]` on a `session/prompt` result. */
export interface AcpTurnMeta {
	model?: string;
	ttftMs?: number;
	outputTokensPerSecond?: number;
}
/** `_meta["clio-coder/replay"]` on a replayed `session/update` frame. */
export interface AcpReplayMeta {
	turn?: number;
	run?: boolean;
}
/** Params of the `_clio-coder/permission/withdraw` notification. */
export interface AcpPermissionWithdrawParams {
	sessionId: string;
	requestId: string;
}

export const MODEL_TARGET_PATHS: Readonly<Record<string, string>> = {
	"chat.model": "chat.target",
	"fleet.default.model": "fleet.default.target",
	"context.memory.model": "context.memory.target",
	"context.compaction.model": "chat.target",
};

/** Preserve the announcement's inferred shape while checking every extension against its wire contract. */
export function checkAcpAgentCapabilitiesMeta<T extends AcpAgentCapabilitiesMeta>(meta: T): T {
	return meta;
}

const sessionId = Type.String({ minLength: 1, maxLength: 128 });
const sessionParams = { sessionId };
const queuedKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);
export const AcpSessionParams = Type.Object(sessionParams, closed);
export type AcpSessionParams = Static<typeof AcpSessionParams>;
export const AcpSteerParams = Type.Object(
	{
		...sessionParams,
		text: Type.String(),
		mode: Type.Optional(Type.Union([Type.Literal("next-slot"), Type.Literal("end-of-turn")])),
	},
	closed,
);
export type AcpSteerParams = Static<typeof AcpSteerParams>;
export const AcpSteerResult = Type.Object(
	{ accepted: Type.Boolean(), queue: queuedKind, refusal: Type.Optional(Type.String()) },
	closed,
);
export type AcpSteerResult = Static<typeof AcpSteerResult>;
export const AcpQueueEntry = Type.Object(
	{ id: Type.String(), kind: queuedKind, text: Type.String(), enqueuedAt: Type.Number(), pinned: Type.Boolean() },
	closed,
);
export type AcpQueueEntry = Static<typeof AcpQueueEntry>;
export const AcpQueueResult = Type.Object(
	{
		steer: Type.Array(Type.String()),
		followUp: Type.Array(Type.String()),
		entries: Type.Optional(Type.Array(AcpQueueEntry)),
	},
	closed,
);
export type AcpQueueResult = Static<typeof AcpQueueResult>;
export const AcpQueueClearResult = Type.Object({ restored: Type.Array(Type.String()) }, closed);
export type AcpQueueClearResult = Static<typeof AcpQueueClearResult>;
export const AcpQueueEditParams = Type.Union([
	Type.Object(
		{
			...sessionParams,
			id: Type.String(),
			op: Type.Union([Type.Literal("remove"), Type.Literal("restore"), Type.Literal("send_now")]),
		},
		closed,
	),
	Type.Object(
		{
			...sessionParams,
			id: Type.String(),
			op: Type.Literal("move"),
			delta: Type.Union([Type.Literal(-1), Type.Literal(1)]),
		},
		closed,
	),
	Type.Object({ ...sessionParams, id: Type.String(), op: Type.Literal("set_kind"), kind: queuedKind }, closed),
]);
export type AcpQueueEditParams = Static<typeof AcpQueueEditParams>;
export const AcpQueueEditResult = Type.Object(
	{
		applied: Type.Boolean(),
		entries: Type.Array(AcpQueueEntry),
		reason: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		delivery: Type.Optional(Type.Union([Type.Literal("interrupt"), Type.Literal("next-slot")])),
		refusal: Type.Optional(Type.String()),
	},
	closed,
);
export type AcpQueueEditResult = Static<typeof AcpQueueEditResult>;
export const AcpQueueChangedParams = Type.Object({ ...sessionParams, entries: Type.Array(AcpQueueEntry) }, closed);
export type AcpQueueChangedParams = Static<typeof AcpQueueChangedParams>;
export const AcpShellParams = Type.Object(
	{ ...sessionParams, command: Type.String(), excludeFromContext: Type.Optional(Type.Boolean()) },
	closed,
);
export type AcpShellParams = Static<typeof AcpShellParams>;
export const AcpShellResult = Type.Object(
	{
		turnId: Type.String(),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		cancelled: Type.Boolean(),
		timedOut: Type.Boolean(),
		truncated: Type.Boolean(),
		excludedFromContext: Type.Boolean(),
		unlabeled: Type.Optional(Type.Boolean()),
		output: Type.String(),
		outputBytes: Type.Number(),
	},
	closed,
);
export type AcpShellResult = Static<typeof AcpShellResult>;
export const AcpInterruptParams = Type.Object({ ...sessionParams, reason: Type.Optional(Type.String()) }, closed);
export type AcpInterruptParams = Static<typeof AcpInterruptParams>;
export const AcpInterruptResult = Type.Object(
	{ cancelled: Type.Boolean(), refusal: Type.Optional(Type.String()) },
	closed,
);
export type AcpInterruptResult = Static<typeof AcpInterruptResult>;
export const AcpLabelParams = Type.Object({ ...sessionParams, label: Type.String() }, closed);
export type AcpLabelParams = Static<typeof AcpLabelParams>;
export const AcpEmptyResult = Type.Object({}, closed);
export type AcpEmptyResult = Static<typeof AcpEmptyResult>;
export const AcpHandoffPrepareParams = Type.Object({ ...sessionParams, goal: Type.String() }, closed);
export type AcpHandoffPrepareParams = Static<typeof AcpHandoffPrepareParams>;
export const AcpHandoffCommitParams = Type.Object(
	{ ...sessionParams, handoffId: Type.String(), document: Type.String() },
	closed,
);
export type AcpHandoffCommitParams = Static<typeof AcpHandoffCommitParams>;
export const AcpHandoffCancelParams = Type.Object({ ...sessionParams, handoffId: Type.String() }, closed);
export type AcpHandoffCancelParams = Static<typeof AcpHandoffCancelParams>;
export interface AcpHandoffRefusal {
	status: "refused";
	level: "warn" | "error";
	code: string;
	reason: string;
}
export interface AcpHandoffPrepared {
	status: "ready";
	handoffId: string;
	goal: string;
	fromSessionId: string;
	document: string;
}
export type AcpHandoffPrepareResult = AcpHandoffPrepared | AcpHandoffRefusal;
export interface AcpHandoffCancelResult {
	cancelled: boolean;
}
export const AcpDecisionSupersedeParams = Type.Object(
	{ ...sessionParams, interviewId: Type.String(), key: Type.String(), correction: Type.Optional(Type.String()) },
	closed,
);
export type AcpDecisionSupersedeParams = Static<typeof AcpDecisionSupersedeParams>;
export interface AcpDecisionSupersedeResult {
	status: string;
	correctionTurn?: string;
	reason?: string;
}
export const AcpMemoryProposeParams = Type.Object(
	{
		...sessionParams,
		entryId: Type.String(),
		scope: Type.Union([Type.Literal("repo"), Type.Literal("global")]),
		acknowledgeGlobal: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type AcpMemoryProposeParams = Static<typeof AcpMemoryProposeParams>;
export interface AcpMemoryProposeResult {
	status: "needs_acknowledgement" | "proposed" | "existing" | "refused";
	reason?: string;
	recordId?: string;
}

export interface AcpArtifactRow {
	/** `<category>/<provider id>`; provider ids are unique only inside a category. */
	id: string;
	category: ViewArtifactCategory;
	title: string;
	subtitle?: string;
	/** ISO time the artifact was produced, absent when unknown. */
	at?: string;
	sizeBytes?: number;
	/** The format a read is expected to return; the read's own `format` is authoritative. */
	format: ViewArtifactFormat;
	/** Set when a read returns the protection record and a refusal instead of content. */
	protected?: true;
}

export interface AcpArtifactPage {
	id: string;
	category: ViewArtifactCategory;
	title: string;
	format: ViewArtifactFormat;
	lines: string[];
	offset: number;
	totalLines: number;
	nextOffset: number | null;
	/** Lines cut to fit one page; reassembly is exact only when this is absent. */
	clippedLines?: number;
	/** The overlay's `i` view, read with `details: true`. */
	details?: { format: ViewArtifactFormat; lineCount: number };
	refused?: { reason: string };
}

export interface AcpArtifactReadRequest {
	id: string;
	offset?: number;
	limit?: number;
	details?: boolean;
}

export type AcpAsideAnswer =
	| { status: "answered"; text: string }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export interface AcpDraftVerdict {
	picked: string | null;
	probabilities: Partial<Record<string, number>>;
	sound: Partial<Record<string, boolean | null>>;
	source: string;
	elapsedMs: number;
}

export type AcpDraftOutcome =
	| {
			status: "drafted";
			aborted: boolean;
			candidates: ReadonlyArray<{ status: "drafted"; text: string } | { status: "failed"; reason: string }>;
			/** Absent when the rounds were aborted before a judgment was asked for. */
			judgment?: { verdict: AcpDraftVerdict } | { reason: string };
	  }
	| { status: "refused"; reason: string };

export interface AcpSessionBoard {
	version: 1;
	operatorTasks: Array<{
		id: string;
		title: string;
		status: UserTask["status"];
		expectedOutputs: string[];
		verificationChecks: number;
	}>;
	plan: {
		title: string;
		tasks: Array<{ id: string; title: string; status: string; origin: "agent" | "user"; reason: string | null }>;
	} | null;
	decisions: Array<{
		ref: string;
		/** With {@link key}, what `_clio-coder/decisions/supersede` names. */
		interviewId: string;
		key: string;
		label: string | null;
		value: string;
		status: "active" | "superseded";
		source: "operator" | "agent" | null;
		decidedAt: string;
		rationale: string | null;
		correction: string | null;
	}>;
	memory: {
		enabled: boolean;
		tier: "llm" | "rules";
		entries: number;
		stepInFlight: boolean;
		/** Knowledge and procedural entries a person may propose as durable memory; status stays private. */
		bank: Array<{ id: string; kind: "knowledge" | "procedural"; content: string }>;
	} | null;
	/** True when any list was cut at {@link ACP_BOARD_MAX_ITEMS}. */
	truncated: boolean;
}

export interface AcpContextLedger {
	version: 1;
	provider: string | null;
	model: string | null;
	/** Tokens; 0 when unknown. */
	contextWindow: number;
	contextWindowSource: string | null;
	contextWindowSlots: { slots: number; totalTokens: number } | null;
	usedTokens: number;
	reserveTokens: number;
	freeTokens: number;
	/** used/window; null when the window is unknown. */
	percent: number | null;
	/** True when the total is anchored to provider-measured usage, false when estimated. */
	measured: boolean;
	compactionThreshold: number | null;
	compactionAuto: boolean;
	projectPreload: string | null;
	projectHandbookFiles: string[] | null;
	toolCount: number;
	groups: Array<{ category: string; label: string; tokens: number; percent: number | null }>;
	lastCompaction: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null;
	promptCache: {
		shellReused: boolean;
		cacheReadTokens: number | null;
		cacheWriteTokens: number | null;
		uncachedInputTokens: number | null;
		backendVerdict: "hot" | "partial" | "cold" | "small" | "unknown" | null;
	} | null;
}

export interface AcpDispatchPlanMeta {
	version: 1;
	topology: DispatchPlanView["topology"];
	taskCount: number;
	/** True when one approval covers several runs, a remote placement, or a gate. */
	planScale: boolean;
	/** sha256 of the rendered plan; a plan-scale run seals exactly this. */
	hash: string;
	costCeilingUsd?: number;
	deadlineMs?: number;
	tasks: Array<{
		agent: string;
		task: string;
		role?: string;
		position?: number;
		target?: string;
		model?: string;
		node?: string;
		nodeKind?: "local" | "ssh";
		worktree?: true;
		apply?: "merge" | "preserve";
		stepId?: string;
		dependencies: string[];
		wave?: number;
	}>;
	/** True when tasks were cut at {@link ACP_DISPATCH_PLAN_MAX_TASKS}. */
	truncated: boolean;
}

export interface AcpErrorDetail {
	code: string;
	reason?: string;
	supported?: number[];
}

export interface AcpInstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: string;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	loadable: boolean;
	overriddenBy?: string;
	runtime?: unknown;
	diagnostics: ReadonlyArray<{ message: string }>;
}

export type AcpExtensionReloadOutcome =
	| {
			status: "committed";
			generation: number;
			changed: boolean;
			added: ReadonlyArray<unknown>;
			removed: ReadonlyArray<unknown>;
			modified: ReadonlyArray<unknown>;
			hooks: { registered: number; dropped: number; fileIssues: number; issues: number; overridden: number };
			lines: ReadonlyArray<string>;
	  }
	| { status: "rejected"; reason: string; generation: number; lines: ReadonlyArray<string> };

export type AcpFleetStep = {
	stepId: string;
	kind: "agent" | "code";
	scope: "readonly" | "workspace";
	agentId?: string;
	commandId?: string;
	argv?: string[];
	/** Declared write boundary; null is no claim, an empty list is the claim "changes nothing". */
	writes: string[] | null;
	route?: { targetId: string; model: string; nodeId: string; endpoint?: { label: string; limit: number } };
	loop?: { loopId: string; role: "check" | "repair"; attempt: number };
	gate?: { path: string };
	target?: string;
	profile?: string;
};

export type AcpFleetPreview =
	| {
			status: "ready";
			name: string;
			planHash: string;
			stepCount: number;
			waves: Array<{ index: number; steps: AcpFleetStep[] }>;
			budget: { ceilingUsd: number; currentUsd: number; playbookUsd: number | null };
			/** True when steps, lists or displayed text were cut at the wire bounds. */
			truncated: boolean;
	  }
	| { status: "refused"; name: string; diagnostics: string[] };

export interface AcpTurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
	costProvenanceObserved: boolean;
}

export interface AcpWorkspaceView {
	version: 1;
	cwd: string;
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	remoteUrl: string | null;
	projectType: string;
	capturedAt: string;
}

export type AcpTreeNodeKind =
	| "user"
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "system"
	| "checkpoint"
	| "compaction"
	| "branch";

export interface AcpSessionTree {
	version: 1;
	sessionId: string;
	/** The turn the next request appends under; null for an empty session. */
	leafId: string | null;
	/** Where this session was forked from, when it was. */
	parentSessionId: string | null;
	parentTurnId: string | null;
	/** Oldest first, so a parent always precedes its children. */
	nodes: Array<{
		id: string;
		parentId: string | null;
		kind: AcpTreeNodeKind;
		at: string;
		label: string | null;
		preview: string | null;
		/** On the path from the root to {@link AcpSessionTree.leafId}. */
		active: boolean;
		/** Structural rows (a compaction, a returned-from branch) are not a place to continue from. */
		selectable: boolean;
	}>;
	/** True when nodes were cut at {@link ACP_SESSION_TREE_MAX_NODES}. */
	truncated: boolean;
}

export interface AcpIgnoredProjectSurface {
	surface: ProjectTrustSurface;
	file: string;
	verdict: Exclude<WorkspaceTrustVerdict, "trusted">;
	fix: string;
}

export interface AcpCostAggregate {
	knownUsd: number;
	hasEstimated: boolean;
	hasUnknown: boolean;
	allKnownFree: boolean;
	calls: number;
}

export interface AcpUsageRow {
	providerId: string;
	attributedModelId: string;
	runs: number;
	apiCalls: number;
	tokens: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	sideQuestions: number;
	handoffs: number;
	prewarms: number;
	backgroundMemory: number;
	systemOne?: number;
	cost: AcpCostAggregate;
}

export interface AcpQuotaSnapshot {
	providerId: string;
	displayName: string;
	status: string;
	windows: ReadonlyArray<{
		label: string;
		usedPct: number;
		resetsAt: string | null;
		scope?: string;
		active?: boolean;
	}>;
	credits?: { display: string; usedPct: number | null } | null;
	plan?: string | null;
	message?: string | null;
	retryAfterSeconds?: number | null;
	stale?: boolean;
	fetchedAt: string | null;
}

export interface AcpCommandFlagSpec {
	name: string;
	takesValue?: boolean;
	repeatable?: boolean;
	values?: string[];
	valueName?: string;
	completionSlot?: string;
}

export interface AcpCommandPositionalSpec {
	name: string;
	required: boolean;
	values?: string[];
	rest?: boolean;
	completionSlot?: string;
}

export interface AcpCommandArgsSpec {
	flags?: AcpCommandFlagSpec[];
	positionals?: AcpCommandPositionalSpec[];
	subcommands?: Record<string, AcpCommandArgsSpec>;
}

export interface AcpCommandDescriptor {
	name: string;
	summary: string;
	/** The registry's own usage line, already rendered from the grammar below. */
	usage: string;
	group: string;
	args: AcpCommandArgsSpec;
	subcommandSummaries?: Record<string, string>;
	/** The bare command is refused; only the projected subcommands are admitted. */
	requiresSubcommand?: true;
	streams?: "dispatch";
	injectsUserTurn?: true;
	promptTurn?: true;
	promptTurnSubcommands?: string[];
}

export interface AcpCommandCatalog {
	version: 1;
	commands: AcpCommandDescriptor[];
	prompts?: string[];
}

export interface AcpCommandResult {
	level: "info" | "success" | "warn" | "error";
	lines: string[];
}

export const AcpUsageMetaSchema = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cacheRead: Type.Integer({ minimum: 0 }),
		cacheWrite: Type.Integer({ minimum: 0 }),
		reasoning: Type.Integer({ minimum: 0 }),
		totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
		costUsd: Type.Optional(Type.Number({ minimum: 0 })),
		costProvenance: Type.Optional(
			Type.Union([Type.Literal("known"), Type.Literal("known_free"), Type.Literal("estimated"), Type.Literal("unknown")]),
		),
	},
	closed,
);
export type AcpUsageMeta = Static<typeof AcpUsageMetaSchema>;
export const AcpTurnMetaSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES })),
		ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
		outputTokensPerSecond: Type.Optional(Type.Number({ minimum: 0 })),
	},
	closed,
);
export const AcpInitializeResultSchema = Type.Object(
	{ protocolVersion: Type.Literal(1) },
	{ additionalProperties: true },
);
export type AcpInitializeResult = Static<typeof AcpInitializeResultSchema>;
export const AcpSessionIdentitySchema = Type.Object({ sessionId }, { additionalProperties: true });
export type AcpSessionIdentity = Static<typeof AcpSessionIdentitySchema>;
export const AcpPromptResultSchema = Type.Object(
	{
		stopReason: Type.Union([
			Type.Literal("end_turn"),
			Type.Literal("cancelled"),
			Type.Literal("max_tokens"),
			Type.Literal("max_turn_requests"),
			Type.Literal("refusal"),
		]),
		_meta: Type.Object(
			{ [ACP_USAGE_META_KEY]: AcpUsageMetaSchema, [ACP_TURN_META_KEY]: Type.Optional(AcpTurnMetaSchema) },
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);
export type AcpPromptResult = Static<typeof AcpPromptResultSchema>;

const wireArtifactsText = Type.String({ maxLength: 8192 });

const wireArtifactsCount = Type.Integer({ minimum: 0 });

const wireArtifactsFormat = Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("json")]);

export const AcpArtifactListSchema = Type.Object(
	{
		artifacts: Type.Array(
			Type.Object(
				{
					id: wireArtifactsText,
					category: wireArtifactsText,
					title: wireArtifactsText,
					format: wireArtifactsFormat,
					subtitle: Type.Optional(wireArtifactsText),
					at: Type.Optional(wireArtifactsText),
					sizeBytes: Type.Optional(wireArtifactsCount),
					protected: Type.Optional(Type.Literal(true)),
				},
				closed,
			),
			{ maxItems: 6400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpArtifactPageSchema = Type.Object(
	{
		id: wireArtifactsText,
		category: wireArtifactsText,
		title: wireArtifactsText,
		format: wireArtifactsFormat,
		lines: Type.Array(Type.String(), { maxItems: 2000 }),
		offset: wireArtifactsCount,
		totalLines: wireArtifactsCount,
		nextOffset: Type.Union([wireArtifactsCount, Type.Null()]),
		clippedLines: Type.Optional(wireArtifactsCount),
		details: Type.Optional(Type.Object({ format: wireArtifactsFormat, lineCount: wireArtifactsCount }, closed)),
		refused: Type.Optional(Type.Object({ reason: wireArtifactsText }, closed)),
	},
	closed,
);

const wireAsideAnswer = Type.String({ maxLength: 66000 });

const wireAsideReason = Type.String({ maxLength: 1100 });

const wireAsideLabel = Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C"), Type.Literal("D")]);

const wireAsideRefusedOrFailed = Type.Object(
	{ status: Type.Union([Type.Literal("refused"), Type.Literal("failed")]), reason: wireAsideReason },
	closed,
);

export const AcpAsideAnswerSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("answered"), Type.Literal("aborted")]),
			text: wireAsideAnswer,
			truncated: Type.Boolean(),
		},
		closed,
	),
	wireAsideRefusedOrFailed,
]);

const wireAsideShare = Type.Number({ minimum: 0 });

export const AcpAsideDraftsSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("drafted"),
			aborted: Type.Boolean(),
			candidates: Type.Array(
				Type.Union([
					Type.Object(
						{ label: wireAsideLabel, status: Type.Literal("drafted"), text: wireAsideAnswer, truncated: Type.Boolean() },
						closed,
					),
					Type.Object({ label: wireAsideLabel, status: Type.Literal("failed"), reason: wireAsideReason }, closed),
				]),
				{ maxItems: 4 },
			),
			judgment: Type.Optional(
				Type.Union([
					Type.Object(
						{
							status: Type.Literal("judged"),
							picked: Type.Union([wireAsideLabel, Type.Null()]),
							probabilities: Type.Record(Type.String({ maxLength: 1 }), wireAsideShare),
							sound: Type.Record(Type.String({ maxLength: 1 }), Type.Union([Type.Boolean(), Type.Null()])),
							source: wireAsideReason,
							elapsedMs: Type.Integer({ minimum: 0 }),
						},
						closed,
					),
					Type.Object({ status: Type.Literal("unjudged"), reason: wireAsideReason }, closed),
				]),
			),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason: wireAsideReason }, closed),
]);

export const AcpAsideCancelledSchema = Type.Object({ cancelled: Type.Boolean() }, closed);

const wireBoardText = Type.String({ maxLength: 1100 });

const wireBoardNullableText = Type.Union([wireBoardText, Type.Null()]);

const wireBoardItems = 100;

export const AcpSessionBoardSchema = Type.Object(
	{
		version: Type.Literal(1),
		operatorTasks: Type.Array(
			Type.Object(
				{
					id: Type.String({ maxLength: 32 }),
					title: wireBoardText,
					status: Type.Union([
						Type.Literal("open"),
						Type.Literal("handed"),
						Type.Literal("picked"),
						Type.Literal("done"),
						Type.Literal("dropped"),
					]),
					expectedOutputs: Type.Array(wireBoardText, { maxItems: 8 }),
					verificationChecks: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
			{ maxItems: wireBoardItems },
		),
		plan: Type.Union([
			Type.Object(
				{
					title: wireBoardText,
					tasks: Type.Array(
						Type.Object(
							{
								id: Type.String({ maxLength: 64 }),
								title: wireBoardText,
								status: Type.String({ maxLength: 32 }),
								origin: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
								reason: wireBoardNullableText,
							},
							closed,
						),
						{ maxItems: wireBoardItems },
					),
				},
				closed,
			),
			Type.Null(),
		]),
		decisions: Type.Array(
			Type.Object(
				{
					ref: Type.String({ maxLength: 2300 }),
					/** With key, what a supersede names; absent from older agents. */
					interviewId: Type.Optional(Type.String({ maxLength: 256 })),
					key: wireBoardText,
					label: wireBoardNullableText,
					value: wireBoardText,
					status: Type.Union([Type.Literal("active"), Type.Literal("superseded")]),
					source: Type.Union([Type.Literal("operator"), Type.Literal("agent"), Type.Null()]),
					decidedAt: Type.String({ maxLength: 64 }),
					rationale: wireBoardNullableText,
					correction: wireBoardNullableText,
				},
				closed,
			),
			{ maxItems: wireBoardItems },
		),
		memory: Type.Union([
			Type.Object(
				{
					enabled: Type.Boolean(),
					tier: Type.Union([Type.Literal("llm"), Type.Literal("rules")]),
					entries: Type.Integer({ minimum: 0 }),
					stepInFlight: Type.Boolean(),
					/** Entries a person may propose as durable memory; absent from older agents. */
					bank: Type.Optional(
						Type.Array(
							Type.Object(
								{
									id: Type.String({ maxLength: 256 }),
									kind: Type.Union([Type.Literal("knowledge"), Type.Literal("procedural")]),
									content: wireBoardText,
								},
								closed,
							),
							{ maxItems: wireBoardItems },
						),
					),
				},
				closed,
			),
			Type.Null(),
		]),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpDecisionSupersededSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("superseded"), Type.Literal("already_superseded")]),
			/** The operator turn the terminal sends with a correction, for the client to send as a request. */
			correctionTurn: Type.Optional(Type.String({ maxLength: 4200 })),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason: Type.String({ maxLength: 1100 }) }, closed),
]);

export const AcpMemoryProposedSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("proposed"), Type.Literal("existing")]),
			recordId: Type.String({ maxLength: 256 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Union([Type.Literal("needs_acknowledgement"), Type.Literal("refused")]),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
]);

const wireContextLedgerText = Type.String({ maxLength: 300 });

const wireContextLedgerTokens = Type.Integer({ minimum: 0 });

const wireContextLedgerNullableCount = Type.Union([wireContextLedgerTokens, Type.Null()]);

export const AcpContextLedgerSchema = Type.Object(
	{
		version: Type.Literal(1),
		provider: Type.Union([wireContextLedgerText, Type.Null()]),
		model: Type.Union([wireContextLedgerText, Type.Null()]),
		contextWindow: wireContextLedgerTokens,
		contextWindowSource: Type.Union([wireContextLedgerText, Type.Null()]),
		contextWindowSlots: Type.Union([
			Type.Object({ slots: wireContextLedgerTokens, totalTokens: wireContextLedgerTokens }, closed),
			Type.Null(),
		]),
		usedTokens: wireContextLedgerTokens,
		reserveTokens: wireContextLedgerTokens,
		freeTokens: wireContextLedgerTokens,
		percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		measured: Type.Boolean(),
		compactionThreshold: Type.Union([Type.Number(), Type.Null()]),
		compactionAuto: Type.Boolean(),
		projectPreload: Type.Union([wireContextLedgerText, Type.Null()]),
		projectHandbookFiles: Type.Union([Type.Array(wireContextLedgerText, { maxItems: 16 }), Type.Null()]),
		toolCount: wireContextLedgerTokens,
		groups: Type.Array(
			Type.Object(
				{
					category: Type.String({ maxLength: 32 }),
					label: wireContextLedgerText,
					tokens: wireContextLedgerTokens,
					percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		lastCompaction: Type.Union([
			Type.Object(
				{
					stage: wireContextLedgerText,
					tokensBefore: wireContextLedgerTokens,
					tokensAfter: wireContextLedgerTokens,
					trigger: wireContextLedgerText,
				},
				closed,
			),
			Type.Null(),
		]),
		promptCache: Type.Union([
			Type.Object(
				{
					shellReused: Type.Boolean(),
					cacheReadTokens: wireContextLedgerNullableCount,
					cacheWriteTokens: wireContextLedgerNullableCount,
					uncachedInputTokens: wireContextLedgerNullableCount,
					backendVerdict: Type.Union([
						Type.Literal("hot"),
						Type.Literal("partial"),
						Type.Literal("cold"),
						Type.Literal("small"),
						Type.Literal("unknown"),
						Type.Null(),
					]),
				},
				closed,
			),
			Type.Null(),
		]),
	},
	closed,
);

const wireBranchesTurnId = Type.String({ minLength: 1, maxLength: 128 });

const wireBranchesTreeNodeKind = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("tool_call"),
	Type.Literal("tool_result"),
	Type.Literal("system"),
	Type.Literal("checkpoint"),
	Type.Literal("compaction"),
	Type.Literal("branch"),
]);

export const AcpSessionTreeSchema = Type.Object(
	{
		version: Type.Literal(1),
		sessionId: sessionId,
		leafId: Type.Union([wireBranchesTurnId, Type.Null()]),
		parentSessionId: Type.Union([sessionId, Type.Null()]),
		parentTurnId: Type.Union([wireBranchesTurnId, Type.Null()]),
		nodes: Type.Array(
			Type.Object(
				{
					id: wireBranchesTurnId,
					parentId: Type.Union([wireBranchesTurnId, Type.Null()]),
					kind: wireBranchesTreeNodeKind,
					at: Type.String({ maxLength: 64 }),
					label: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					preview: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					active: Type.Boolean(),
					selectable: Type.Boolean(),
				},
				closed,
			),
			{ maxItems: 400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpBranchSwitchedSchema = Type.Object(
	{ leafId: wireBranchesTurnId, replayedTurns: Type.Integer({ minimum: 0 }) },
	closed,
);

export const AcpForkedSchema = Type.Object(
	{
		sessionId: sessionId,
		parentSessionId: sessionId,
		parentTurnId: wireBranchesTurnId,
		/** False when the fork exists but its transcript could not be replayed; it starts empty. */
		replayed: Type.Boolean(),
	},
	closed,
);

const wireSteeringName = Type.String({ maxLength: 64 });

const wireSteeringCopy = Type.String({ maxLength: 512 });

const wireSteeringFlagSpec = Type.Object(
	{
		name: wireSteeringName,
		takesValue: Type.Optional(Type.Boolean()),
		repeatable: Type.Optional(Type.Boolean()),
		values: Type.Optional(Type.Array(wireSteeringName, { maxItems: 64 })),
		valueName: Type.Optional(wireSteeringName),
		completionSlot: Type.Optional(wireSteeringName),
	},
	closed,
);

const wireSteeringPositionalSpec = Type.Object(
	{
		name: wireSteeringName,
		required: Type.Boolean(),
		values: Type.Optional(Type.Array(wireSteeringName, { maxItems: 64 })),
		rest: Type.Optional(Type.Boolean()),
		completionSlot: Type.Optional(wireSteeringName),
	},
	closed,
);

const wireSteeringLeafArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(wireSteeringFlagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(wireSteeringPositionalSpec, { maxItems: 8 })),
	},
	closed,
);

const wireSteeringCommandArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(wireSteeringFlagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(wireSteeringPositionalSpec, { maxItems: 8 })),
		subcommands: Type.Optional(Type.Record(Type.String(), wireSteeringLeafArgs)),
	},
	closed,
);

const wireSteeringCommandDescriptor = Type.Object(
	{
		name: wireSteeringName,
		summary: wireSteeringCopy,
		usage: wireSteeringCopy,
		group: wireSteeringName,
		args: wireSteeringCommandArgs,
		subcommandSummaries: Type.Optional(Type.Record(Type.String(), wireSteeringCopy)),
		/** The bare command is refused; only the projected subcommands are admitted. */
		requiresSubcommand: Type.Optional(Type.Literal(true)),
		/** The result is "started"; real output arrives as fleet events. */
		streams: Type.Optional(Type.Literal("dispatch")),
		/** The command puts a user turn into the session outside any prompt. */
		injectsUserTurn: Type.Optional(Type.Literal(true)),
		/** The command's calls and approvals belong to a conversation turn, so it is sent as one. */
		promptTurn: Type.Optional(Type.Literal(true)),
		/** Subcommands sent as a conversation turn, as promptTurn does for a whole command. */
		promptTurnSubcommands: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
	},
	closed,
);

export const AcpCommandCatalogSchema = Type.Object(
	{
		version: Type.Literal(1),
		commands: Type.Array(wireSteeringCommandDescriptor, { maxItems: 64 }),
		/** Loaded prompt templates a `/name` line expands to; absent from a build that does not say. */
		prompts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })),
	},
	closed,
);

export const AcpCommandResultSchema = Type.Object(
	{
		level: Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warn"), Type.Literal("error")]),
		lines: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 201 }),
	},
	closed,
);

const wireExtensionsText = Type.String({ maxLength: 520 });

const wireExtensionsCount = Type.Integer({ minimum: 0 });

export const AcpSessionExtensionsSchema = Type.Object(
	{
		version: Type.Literal(1),
		extensions: Type.Array(
			Type.Object(
				{
					id: wireExtensionsText,
					name: wireExtensionsText,
					version: wireExtensionsText,
					description: wireExtensionsText,
					scope: wireExtensionsText,
					state: Type.Union([
						Type.Literal("eligible"),
						Type.Literal("disabled"),
						Type.Literal("invalid"),
						Type.Literal("incompatible"),
						Type.Literal("shadowed"),
					]),
					overriddenBy: Type.Optional(wireExtensionsText),
					runtime: Type.Boolean(),
					problems: wireExtensionsCount,
					diagnostics: Type.Array(wireExtensionsText, { maxItems: 3 }),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpExtensionReloadSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			generation: wireExtensionsCount,
			changed: Type.Boolean(),
			added: wireExtensionsCount,
			removed: wireExtensionsCount,
			modified: wireExtensionsCount,
			hooks: Type.Object(
				{
					registered: wireExtensionsCount,
					dropped: wireExtensionsCount,
					issues: wireExtensionsCount,
					overridden: wireExtensionsCount,
				},
				closed,
			),
			lines: Type.Array(wireExtensionsText, { maxItems: 40 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("rejected"),
			reason: wireExtensionsText,
			generation: wireExtensionsCount,
			lines: Type.Array(wireExtensionsText, { maxItems: 40 }),
		},
		closed,
	),
]);

export const AcpLibraryReloadSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("refreshed"),
			generation: wireExtensionsCount,
			previousGeneration: wireExtensionsCount,
			changed: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("failed"), error: Type.String({ maxLength: 1100 }) }, closed),
]);

const wireUsageText = Type.String({ maxLength: 260 });

const wireUsageCount = Type.Integer({ minimum: 0 });

const wireUsageNullableText = Type.Union([wireUsageText, Type.Null()]);

const wireUsagePct = Type.Number({ minimum: 0, maximum: 100 });

const wireUsageCost = Type.Object(
	{
		knownUsd: Type.Number({ minimum: 0 }),
		calls: wireUsageCount,
		estimated: Type.Boolean(),
		unknown: Type.Boolean(),
		free: Type.Boolean(),
	},
	closed,
);

export const AcpSessionUsageSchema = Type.Object(
	{
		version: Type.Literal(1),
		session: Type.Object(
			{
				cost: wireUsageCost,
				tokens: wireUsageCount,
				rows: Type.Array(
					Type.Object(
						{
							provider: wireUsageText,
							model: wireUsageText,
							runs: wireUsageCount,
							calls: wireUsageCount,
							tokens: Type.Object(
								{
									input: wireUsageCount,
									output: wireUsageCount,
									cacheRead: wireUsageCount,
									cacheWrite: wireUsageCount,
									reasoning: wireUsageCount,
									total: wireUsageCount,
								},
								closed,
							),
							beside: Type.Object(
								{
									sideQuestions: wireUsageCount,
									handoffs: wireUsageCount,
									prewarms: wireUsageCount,
									backgroundMemory: wireUsageCount,
								},
								closed,
							),
							cost: wireUsageCost,
						},
						closed,
					),
					{ maxItems: 32 },
				),
				truncated: Type.Boolean(),
			},
			closed,
		),
		quota: Type.Union([
			Type.Object(
				{
					status: Type.Literal("read"),
					providers: Type.Array(
						Type.Object(
							{
								provider: wireUsageText,
								name: wireUsageText,
								status: wireUsageText,
								plan: wireUsageNullableText,
								message: wireUsageNullableText,
								credits: Type.Union([
									Type.Object({ display: wireUsageText, usedPct: Type.Union([wireUsagePct, Type.Null()]) }, closed),
									Type.Null(),
								]),
								stale: Type.Boolean(),
								fetchedAt: wireUsageNullableText,
								retryAfterSeconds: Type.Union([wireUsageCount, Type.Null()]),
								windows: Type.Array(
									Type.Object(
										{
											label: wireUsageText,
											usedPct: wireUsagePct,
											resetsAt: wireUsageNullableText,
											scope: wireUsageNullableText,
											active: Type.Boolean(),
										},
										closed,
									),
									{ maxItems: 8 },
								),
							},
							closed,
						),
						{ maxItems: 16 },
					),
				},
				closed,
			),
			Type.Object({ status: Type.Literal("failed"), reason: wireUsageText }, closed),
		]),
	},
	closed,
);

const wireFleetRunText = Type.String({ maxLength: 520 });

const wireFleetRunHash = Type.String({ pattern: "^[0-9a-f]{64}$" });

const wireFleetRunStep = Type.Object(
	{
		stepId: wireFleetRunText,
		kind: Type.Union([Type.Literal("agent"), Type.Literal("code")]),
		scope: Type.Union([Type.Literal("readonly"), Type.Literal("workspace")]),
		agentId: Type.Optional(wireFleetRunText),
		commandId: Type.Optional(wireFleetRunText),
		argv: Type.Optional(Type.Array(wireFleetRunText, { maxItems: 16 })),
		writes: Type.Union([Type.Array(wireFleetRunText, { maxItems: 16 }), Type.Null()]),
		route: Type.Optional(
			Type.Object(
				{
					targetId: wireFleetRunText,
					model: wireFleetRunText,
					nodeId: wireFleetRunText,
					endpoint: Type.Optional(Type.Object({ label: wireFleetRunText, limit: Type.Integer({ minimum: 0 }) }, closed)),
				},
				closed,
			),
		),
		loop: Type.Optional(
			Type.Object(
				{
					loopId: wireFleetRunText,
					role: Type.Union([Type.Literal("check"), Type.Literal("repair")]),
					attempt: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
		),
		gate: Type.Optional(Type.Object({ path: wireFleetRunText }, closed)),
		target: Type.Optional(wireFleetRunText),
		profile: Type.Optional(wireFleetRunText),
	},
	closed,
);

const wireFleetRunRefused = Type.Object(
	{
		status: Type.Literal("refused"),
		name: wireFleetRunText,
		diagnostics: Type.Array(Type.String({ maxLength: 1100 }), { maxItems: 32 }),
	},
	closed,
);

export const AcpFleetPreviewSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			stepCount: Type.Integer({ minimum: 0 }),
			waves: Type.Array(
				Type.Object({ index: Type.Integer({ minimum: 0 }), steps: Type.Array(wireFleetRunStep, { maxItems: 64 }) }, closed),
				{
					maxItems: 64,
				},
			),
			budget: Type.Object(
				{
					ceilingUsd: Type.Number({ minimum: 0 }),
					currentUsd: Type.Number({ minimum: 0 }),
					playbookUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			truncated: Type.Boolean(),
		},
		closed,
	),
	wireFleetRunRefused,
]);

export const AcpFleetRunResultSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("started"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			fleetRootId: Type.String({ maxLength: 128 }),
			stepCount: Type.Integer({ minimum: 0 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("changed"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			reason: Type.String({ maxLength: 512 }),
		},
		closed,
	),
	/** The run ended before its first step: dispatch admission refused what the compiler accepted. */
	Type.Object(
		{
			status: Type.Literal("failed"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			fleetRootId: Type.String({ maxLength: 128 }),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
	wireFleetRunRefused,
]);

const wireHandoffHandoffId = Type.String({ minLength: 1, maxLength: 128 });

const wireHandoffDocument = Type.String({ maxLength: 131072 });

const wireHandoffHandoffRefused = Type.Object(
	{
		status: Type.Literal("refused"),
		level: Type.Union([Type.Literal("warn"), Type.Literal("error")]),
		code: Type.String({ maxLength: 64 }),
		reason: Type.String({ maxLength: 2100 }),
	},
	closed,
);

export const AcpHandoffDraftSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			handoffId: wireHandoffHandoffId,
			goal: Type.String({ maxLength: 2048 }),
			fromSessionId: sessionId,
			document: wireHandoffDocument,
		},
		closed,
	),
	wireHandoffHandoffRefused,
]);

export const AcpHandoffCommittedSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			sessionId: sessionId,
			fromSessionId: sessionId,
			warnings: Type.Array(Type.String({ maxLength: 2100 }), { maxItems: 8 }),
		},
		closed,
	),
	wireHandoffHandoffRefused,
]);

export const AcpHandoffCancelledSchema = Type.Object({ cancelled: Type.Boolean() }, closed);

const wireSteeringSTEER_TEXT_MAX_BYTES = 16384;

const wireSteeringQUEUE_MAX_ENTRIES = 64;

export const AcpSteerResultSchema = Type.Object(
	{
		accepted: Type.Boolean(),
		queue: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]),
		refusal: Type.Optional(wireSteeringCopy),
	},
	closed,
);

const wireSteeringQueueKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);

export const AcpQueueEntrySchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: wireSteeringQueueKind,
		text: Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }),
		enqueuedAt: Type.Number(),
		pinned: Type.Boolean(),
	},
	closed,
);

const wireSteeringQueueEntries = Type.Array(AcpQueueEntrySchema, { maxItems: wireSteeringQUEUE_MAX_ENTRIES });

export const AcpQueueSnapshotSchema = Type.Object(
	{
		steer: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: wireSteeringQUEUE_MAX_ENTRIES,
		}),
		followUp: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: wireSteeringQUEUE_MAX_ENTRIES,
		}),
		entries: Type.Optional(wireSteeringQueueEntries),
	},
	closed,
);

export const AcpQueueChangedSchema = Type.Object(
	{ sessionId: Type.String({ maxLength: 128 }), entries: wireSteeringQueueEntries },
	closed,
);

export const AcpQueueEditResultSchema = Type.Object(
	{
		applied: Type.Boolean(),
		reason: Type.Optional(wireSteeringName),
		text: Type.Optional(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES })),
		delivery: Type.Optional(Type.Union([Type.Literal("interrupt"), Type.Literal("next-slot")])),
		refusal: Type.Optional(wireSteeringCopy),
		entries: wireSteeringQueueEntries,
	},
	closed,
);

export const AcpShellOutcomeSchema = Type.Object(
	{
		cancelled: Type.Boolean(),
		timedOut: Type.Boolean(),
		excludedFromContext: Type.Boolean(),
		unlabeled: Type.Optional(Type.Boolean()),
	},
	closed,
);

export const AcpQueueClearedSchema = Type.Object(
	{
		restored: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: 2 * wireSteeringQUEUE_MAX_ENTRIES,
		}),
	},
	closed,
);

export const AcpInterruptResultSchema = Type.Object(
	{ cancelled: Type.Boolean(), refusal: Type.Optional(wireSteeringCopy) },
	closed,
);

export const AcpDispatchSteerResultSchema = Type.Object(
	{ accepted: Type.Boolean(), reason: Type.Optional(wireSteeringName) },
	closed,
);

export const AcpCommandDescriptorSchema = wireSteeringCommandDescriptor;

export interface AcpSessionModes {
	currentModeId: string;
	availableModes: Array<{ id: string; name: string; description?: string }>;
}
export interface AcpHandoffCommitted {
	status: "committed";
	sessionId: string;
	fromSessionId: string;
	warnings: string[];
	modes: AcpSessionModes;
	configOptions: Array<Record<string, unknown>>;
	_meta: { [ACP_SESSION_META_KEY]: AcpSessionResultMeta };
}
export type AcpHandoffCommitResult = AcpHandoffCommitted | AcpHandoffRefusal;

const wirePermissionCopy = Type.String({ maxLength: 512 });

export const AcpPermissionDecisionFactsSchema = Type.Object(
	{
		tier: Type.String({ maxLength: 32 }),
		tierLabel: Type.String({ maxLength: 128 }),
		title: Type.String({ maxLength: 512 }),
		semanticToken: Type.Union([Type.Literal("accent"), Type.Literal("action"), Type.Literal("warning")]),
		authorizationCopy: wirePermissionCopy,
		consequenceCopy: wirePermissionCopy,
		reversibilityCopy: wirePermissionCopy,
		requestedByCopy: wirePermissionCopy,
		actionClass: Type.String({ maxLength: 32 }),
		affectedScope: Type.String({ maxLength: 32 }),
		reversibility: Type.String({ maxLength: 32 }),
		target: Type.Optional(Type.String({ maxLength: 512 })),
		/** What a bash command would do, one sentence per step, written by the agent from the full command. */
		consequenceLines: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 9 })),
	},
	closed,
);

export const AcpWorkerAskFactsSchema = Type.Object(
	{
		requestId: Type.String({ maxLength: 128 }),
		requestedBy: Type.String({ maxLength: 128 }),
		agentId: Type.String({ maxLength: 128 }),
		approvalAuthority: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("operator")])),
		forwardedByMain: Type.Boolean(),
		fallback: Type.Union([Type.Literal("deny"), Type.Literal("fail")]),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	closed,
);

const wirePermissionPlanField = Type.String({ maxLength: 300 });

export const AcpDispatchPlanFactsSchema = Type.Object(
	{
		topology: Type.String({ maxLength: 32 }),
		taskCount: Type.Integer({ minimum: 0 }),
		planScale: Type.Boolean(),
		hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		costCeilingUsd: Type.Optional(Type.Number({ minimum: 0 })),
		deadlineMs: Type.Optional(Type.Integer({ minimum: 0 })),
		tasks: Type.Array(
			Type.Object(
				{
					agent: wirePermissionPlanField,
					task: Type.String({ maxLength: 1100 }),
					role: Type.Optional(Type.String({ maxLength: 32 })),
					position: Type.Optional(Type.Integer({ minimum: 0 })),
					target: Type.Optional(wirePermissionPlanField),
					model: Type.Optional(wirePermissionPlanField),
					node: Type.Optional(wirePermissionPlanField),
					nodeKind: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("ssh")])),
					worktree: Type.Optional(Type.Literal(true)),
					apply: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("preserve")])),
					stepId: Type.Optional(wirePermissionPlanField),
					dependencies: Type.Array(wirePermissionPlanField, { maxItems: 8 }),
					wave: Type.Optional(Type.Integer({ minimum: 0 })),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export type AcpPermissionDecisionFacts = Static<typeof AcpPermissionDecisionFactsSchema>;

export type AcpWorkerAskFacts = Static<typeof AcpWorkerAskFactsSchema>;

export type AcpDispatchPlanFacts = Static<typeof AcpDispatchPlanFactsSchema>;
