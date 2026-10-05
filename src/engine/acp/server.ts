import type { ContextActivityPayload } from "../../core/bus-events.js";
import type { ContextOperationStatus } from "../../core/context-operation.js";
import {
	ACP_CONTEXT_STATUS_METHOD,
	CONTEXT_OPERATION_CUSTOM_TYPE,
	readContextOperation,
} from "../../core/context-operation.js";
import {
	ACP_DISPATCH_STEER_METHOD,
	ACP_EGGS_META_KEY,
	ACP_EVENT_NOTIFICATION,
	ACP_EVENTS_META_KEY,
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_MAX_TARGETS,
	ACP_MEMORY_META_KEY,
	ACP_NOTICE_META_KEY,
	ACP_SAFE_SETTINGS_KEYS,
	ACP_SESSION_INTERRUPT_METHOD,
	ACP_SESSION_LABEL_METHOD,
	ACP_SESSION_LIST_METHOD,
	ACP_SESSION_QUEUE_CLEAR_METHOD,
	ACP_SESSION_QUEUE_METHOD,
	ACP_SESSION_STEER_METHOD,
	ACP_SESSION_TRUST_METHOD,
	ACP_SETTINGS_GET_SAFE_METHOD,
	ACP_SETTINGS_META_KEY,
	ACP_SETTINGS_PATCH_SAFE_METHOD,
	ACP_STEERING_META_KEY,
	ACP_TARGET_MODEL_LIMIT,
	ACP_TARGETS_LIST_METHOD,
	ACP_TARGETS_META_KEY,
	ACP_TARGETS_PROBE_METHOD,
	ACP_THINKING_LEVELS,
	ACP_TOOLS_META_KEY,
	ACP_TRUNCATED_META_KEY,
	ACP_TURN_META_KEY,
} from "./types.js";

export type { AcpSafeSettingsPatch, AcpThinkingLevel } from "./types.js";

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { type BashCommandProgress, combineBashOutput } from "../../core/bash-exec.js";
import {
	type AccountabilityEvidenceReadyPayload,
	BusChannels,
	type CompactionPayload,
	type ContextWarningPayload,
	type DispatchCompletedPayload,
	type DispatchEnqueuedPayload,
	type DispatchFailedPayload,
	type DispatchProgressPayload,
	type DispatchStartedPayload,
	type LoopBlockedPayload,
	type PermissionRequestedPayload,
	type ProviderHealthPayload,
	type ToolBudgetExceededPayload,
} from "../../core/bus-events.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../../core/defaults.js";
import { readDispatchScopeNotice } from "../../core/dispatch-scope-notice.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import { ToolNames } from "../../core/tool-names.js";
import type { RunReceiptFacts } from "../../domains/dispatch/receipt-facts.js";
import {
	readRunReceiptFacts,
	readRunReceiptFactsForReplay,
	receiptWireFacts,
} from "../../domains/dispatch/receipt-facts.js";
import type { ProvidersContract } from "../../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime } from "../../domains/providers/eligibility.js";
import { resolveRuntimeTarget } from "../../domains/providers/runtime-resolution.js";
import { type CostProvenance, resolveCostProvenance } from "../../domains/providers/types/cost-provenance.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL, isAutonomyLevel } from "../../domains/safety/autonomy.js";
import { describeMainCallConsequences } from "../../domains/safety/call-consequence.js";
import { describeCallTarget, sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { COMMAND_CONSEQUENCE_MAX_SEVERE } from "../../domains/safety/command-consequence.js";
import type { DecisionPresentation, TrustedDecisionFacts } from "../../domains/safety/decision-presentation.js";
import {
	classifyDecisionPresentation,
	decisionActionClass,
	decisionFactsForPermission,
} from "../../domains/safety/decision-presentation.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import type { BashExecutionEntry, MessageEntry, SessionEntry } from "../../domains/session/entries.js";
import { OPERATOR_SHELL_TIMEOUT_MS, runOperatorShellLine } from "../../domains/session/operator-shell.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import { filterEntriesToActivePath } from "../../domains/session/tree/active-path.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import {
	clampThinkingLevel,
	replayCurrentSession,
	resolvePermission,
	restoreSession as restoreControlledSession,
	selectModel,
} from "../../session-control/index.js";
import { type AskUserHandler, askUserExposure } from "../../tools/ask-user.js";
import type { McpCapabilitySource, McpClientServerSpec } from "../../tools/gateway/mcp-capabilities.js";
import { gatewayChainPlan } from "../../tools/gateway-display.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { toolResultPresentationText } from "../../tools/result-disposition.js";
import { effectiveToolCall } from "../../tools/surface.js";
import type { AgentMessage, ImageContent } from "../types.js";
import {
	ACP_ARTIFACT_CATEGORIES,
	ACP_ARTIFACTS_LIST_METHOD,
	ACP_ARTIFACTS_META_KEY,
	ACP_ARTIFACTS_PER_CATEGORY,
	ACP_ARTIFACTS_READ_METHOD,
	type AcpArtifactsSource,
	listAcpArtifacts,
	parseArtifactCategories,
	parseArtifactReadRequest,
	readAcpArtifact,
} from "./artifacts.js";
import {
	ACP_ASIDE_ASK_METHOD,
	ACP_ASIDE_CANCEL_METHOD,
	ACP_ASIDE_DRAFT_COUNTS,
	ACP_ASIDE_DRAFT_METHOD,
	ACP_ASIDE_META_KEY,
	ACP_ASIDE_QUESTION_MAX_CHARS,
	type AcpAsideControl,
	projectAsideAnswer,
	projectDraftOutcome,
} from "./aside.js";
import { ACP_BOARD_META_KEY, ACP_BOARD_METHOD, type AcpBoardSource, projectSessionBoard } from "./board.js";
import type { AcpCommandCatalog, AcpCommandControl } from "./commands.js";
import { ACP_CONTEXT_LEDGER_METHOD, ACP_CONTEXT_META_KEY, projectContextLedger } from "./context-ledger.js";
import { ACP_DISPATCH_PLAN_META_KEY, projectDispatchPlanMeta } from "./dispatch-plan-meta.js";
import { ACP_TURN_FAILED_MESSAGE, AcpRequestError, AcpTimeoutError, acpErrorMessage } from "./errors.js";
import {
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_META_KEY,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_LIBRARY_META_KEY,
	ACP_LIBRARY_RELOAD_METHOD,
	type AcpExtensionsControl,
	type AcpLibraryReload,
	projectExtensionReload,
	projectExtensions,
} from "./extensions.js";
import {
	ACP_FLEET_MAX_REASON_BYTES,
	ACP_FLEET_META_KEY,
	ACP_FLEET_PREVIEW_METHOD,
	ACP_FLEET_RUN_METHOD,
	type AcpFleetControl,
	bounded as boundedFleetText,
	projectFleetPreview,
} from "./fleet-run.js";
import type { AcpLiveTelemetry } from "./live-telemetry.js";
import { ACP_WORKSPACE_META_KEY, createAcpLiveTelemetry, turnUsageMeta } from "./live-telemetry.js";
import {
	ACP_SESSION_FORK_METHOD,
	ACP_SESSION_SWITCH_TURN_METHOD,
	ACP_SESSION_TREE_METHOD,
	isSelectableTreeNode,
	projectSessionTree,
} from "./session-tree.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import { ACP_TRUST_CAPABILITY, ACP_TRUST_META_KEY, trustResultMeta } from "./trust-notice.js";
import type {
	AcpCommandsCapability,
	AcpContentBlock,
	AcpDecisionSupersedeResult,
	AcpEmptyResult,
	AcpHandoffCancelResult,
	AcpHandoffCommitResult,
	AcpHandoffPrepareResult,
	AcpInitializeResponse,
	AcpInterruptResult,
	AcpMemoryProposeResult,
	AcpPromptResponse,
	AcpQueueClearResult,
	AcpQueueEditResult,
	AcpQueueEntry,
	AcpQueueResult,
	AcpRequestPermissionResponse,
	AcpSafeSettings,
	AcpSafeSettingsPatch,
	AcpSessionList,
	AcpSessionListRow,
	AcpSessionResultMeta,
	AcpSessionUpdateParams,
	AcpShellResult,
	AcpSteerResult,
	AcpTarget,
	AcpTargetList,
	AcpTargetProbe,
	AcpThinkingLevel,
	AcpToolCallLocation,
	AcpToolCallStatus,
	AcpToolKind,
} from "./types.js";
import {
	ACP_AGENT_META_KEY,
	ACP_BRANCHES_META_KEY,
	ACP_COMMANDS_INVOKE_METHOD,
	ACP_COMMANDS_LIST_METHOD,
	ACP_COMMANDS_META_KEY,
	ACP_DECISION_META_KEY,
	ACP_DECISION_SUPERSEDE_METHOD,
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_META_KEY,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_INTERVIEW_CANCEL_METHOD,
	ACP_INTERVIEW_REQUEST_METHOD,
	ACP_INTERVIEWS_META_KEY,
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_RAW_DIFF_BYTES,
	ACP_MAX_RAW_RECORD_BYTES,
	ACP_MAX_STRING_BYTES,
	ACP_MAX_TOOL_CALL_ID_BYTES,
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MEMORY_PROPOSE_METHOD,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_QUEUE_CHANGED_NOTIFICATION,
	ACP_QUEUE_EDIT_METHOD,
	ACP_QUEUE_META_KEY,
	ACP_RECEIPT_META_KEY,
	ACP_REPLAY_META_KEY,
	ACP_SESSION_META_KEY,
	ACP_SESSION_SHELL_METHOD,
	ACP_SHELL_META_KEY,
	ACP_TOOL_PROGRESS_META_KEY,
	ACP_USAGE_META_KEY,
	ACP_WORKER_ASK_META_KEY,
	ACP_WORKER_PERMISSIONS_META_KEY,
	checkAcpAgentCapabilitiesMeta,
} from "./types.js";
import {
	ACP_ACCOUNTING_META_KEY,
	ACP_USAGE_READ_METHOD,
	type AcpUsageSource,
	projectQuota,
	projectSessionUsage,
} from "./usage.js";

type AcpServerEvent = unknown;
type AcpEventRecord = Record<string, unknown> & { type?: unknown };

/** What the host's prompt expander hands back; the same fields the terminal submits with. */
export interface AcpPromptExpansion {
	text: string;
	images: ReadonlyArray<ImageContent>;
	workingContextPaths: ReadonlyArray<string>;
	pendingSkillRequests: ReadonlyArray<unknown>;
	display?: { text: string; note?: string };
}

/** A handoff document awaiting review; nothing has been written while a client holds one. */
export interface AcpHandoffDraft {
	goal: string;
	fromSessionId: string;
	/** Host-only snapshot identity, never projected into the review response. */
	sourceIdentity: string;
	document: string;
}
export interface AcpHandoffRefusal {
	ok: false;
	level: "warn" | "error";
	code: string;
	reason: string;
}
/**
 * `src/domains/session/handoff-service.ts`, bound by the composition root. The
 * server takes it by structure so the domain service stays out of the Stage 0
 * chunk this module is measured in.
 */
export interface AcpHandoffControl {
	prepare(goal: string): Promise<{ ok: true; draft: AcpHandoffDraft } | AcpHandoffRefusal>;
	commit(
		draft: AcpHandoffDraft,
		document: string,
	): { ok: true; toSessionId: string; warnings: ReadonlyArray<string> } | AcpHandoffRefusal;
}

export interface AcpInterviewTransport {
	request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
	notify(method: string, params?: unknown): void;
}

export interface AcpInterviewBinding {
	transport: AcpInterviewTransport;
	/** The session a round is asked on, or null when none is bound. */
	sessionId: () => string | null;
	/** True once the client advertised the capability at initialize. */
	enabled: () => boolean;
	timeoutMs?: number;
	diagnostics?: (line: string) => void;
}

export interface AcpInterviewChannel {
	/** The handler the orchestrator installs as its ask_user handler. */
	ask: AskUserHandler;
	cancel(): void;
	/** Returns the detach function; a later attach replaces an earlier one. */
	attach(binding: AcpInterviewBinding): () => void;
}

/** The board's writes, bound by the composition root. */
export interface AcpBoardActions {
	/** Throws when the decision is not on the board. */
	supersedeDecision(
		interviewId: string,
		key: string,
		correction?: string,
	): { status: "superseded" | "already_superseded"; correctionTurn?: string };
	/** Throws when the entry is not in the task bank or the scope cannot be resolved. */
	proposeMemory(entryId: string, scope: "repo" | "global"): Promise<{ created: boolean; recordId: string }>;
}

export interface AcpServerChat {
	discoverOperatorEgg?(text: string): Promise<boolean>;
	submit(text: string, options?: unknown): Promise<void>;
	/** Wait for a command's host-injected turn while the ACP prompt owns its subscription. */
	whenSettled?(): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: AcpServerEvent) => void): () => void;
	isStreaming(): boolean;
	getSessionId(): string | null;
	/** Replace provider context and the next persisted parent for a new or loaded session. */
	resetForSession?(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
	/**
	 * Mid-run guidance: queue `text` on the engine's steering queue, where the
	 * inner loop drains it between tool batches. False means nothing was
	 * streaming to steer, which the wire reports as a refusal rather than as a
	 * silent success.
	 */
	steer?(text: string): boolean;
	/** Queue `text` on the follow-up queue, drained when the whole run settles. */
	queueFollowUp?(text: string): boolean;
	queuedMessages?(): { steer: ReadonlyArray<string>; followUp: ReadonlyArray<string> };
	/** Drain both queues and hand back the texts so a client can restore them. */
	clearQueuedFollowUps?(): string[];
	/** The queued entries still in Clio's hands, in delivery order. */
	queueEntries?(): ReadonlyArray<AcpQueuedEntry>;
	/** Takes one entry out of the queue; null when it already left. `reason` is recorded, never acted on. */
	removeQueuedEntry?(id: string, reason?: "removed" | "to-editor" | "sent-now"): AcpQueuedEntry | null;
	/** Moves one entry up (-1) or down (+1) in delivery order; false when it cannot move. */
	moveQueuedEntry?(id: string, delta: -1 | 1): boolean;
	/** The operator's own choice of slot, which pins the entry against steering producers. */
	setQueuedEntryKind?(id: string, kind: AcpQueuedEntryKind): boolean;
	/** Why an interrupt would be refused right now, or null when it would cancel the run. */
	interruptRefusal?(): string | null;
	dispose?(): void;
}

export type AcpQueuedEntryKind = "steer" | "follow-up";

/** One message waiting in the chat loop's steering queue, as the loop holds it. */
export interface AcpQueuedEntry {
	id: string;
	kind: AcpQueuedEntryKind;
	text: string;
	/** Epoch milliseconds the message was queued. */
	enqueuedAt: number;
	pinned?: boolean;
	display?: { text: string; note?: string };
	referencedPaths?: ReadonlyArray<string>;
}

/**
 * The fleet controls the ACP steering surface reaches. Narrowed to the two
 * operations an external client may perform on a worker it did not start, so a
 * client cannot enqueue, route, or re-plan dispatch work through this server.
 */
export interface AcpDispatchControl {
	/**
	 * Queue operator guidance on a running worker's open stdin. Throws with an
	 * operator-facing message for every refusal; delivery itself is confirmed
	 * later and out of band, so a return here means queued, never delivered.
	 */
	steer(runId: string, text: string): void;
	abort(runId: string): void;
	snapshot(): {
		running: ReadonlyArray<{ runId: string; runtimeKind: string }>;
		retrying: ReadonlyArray<{ runId: string }>;
	};
}

export interface AcpRoutingSnapshot {
	target: string | null;
	model: string | null;
}

export interface AcpSafeSettingsSnapshot extends AcpRoutingSnapshot {
	thinkingLevel: AcpThinkingLevel;
	autonomy: AutonomyLevel;
}

export interface AcpSettingsControl {
	read(): AcpSafeSettingsSnapshot;
	commit(patch: AcpSafeSettingsPatch): AcpSafeSettingsSnapshot;
}

export interface ClioAcpServerOptions {
	transport: AcpJsonRpcPeerTransport;
	chat: AcpServerChat;
	session?: SessionContract;
	providers?: ProvidersContract;
	settings?: AcpSettingsControl;
	/** Wired only by the composition root; absent means `_clio-coder/dispatch/steer` refuses. */
	dispatch?: AcpDispatchControl;
	/**
	 * The 13 wire-shaped operator commands. Absent means the catalog is not
	 * announced and both command methods refuse, which is what an embedder that
	 * wired no fleet, bus, or provider contract must observe.
	 */
	commands?: AcpCommandControl;
	/**
	 * The operator's tasks, the session's plan, its decisions and the memory
	 * tier, read for `_clio-coder/session/board`. Absent means the method is not
	 * announced and refuses.
	 */
	board?: () => AcpBoardSource;
	/**
	 * The shared /handoff lifecycle, bound by the composition root. Absent means
	 * the three handoff methods are not announced and refuse.
	 */
	handoff?: AcpHandoffControl;
	/**
	 * The terminal's `/fleet run` approval: compile a named fleet contract for
	 * review and start it only against the hash that was approved. Absent means
	 * the two fleet methods are not announced and refuse.
	 */
	fleet?: AcpFleetControl;
	/**
	 * The board panel's two writes, with the terminal overlays' semantics:
	 * superseding a decision (a correction also yields the turn the terminal
	 * submits) and proposing a task-bank entry as durable memory. Absent means
	 * both methods refuse.
	 */
	boardActions?: AcpBoardActions;
	/**
	 * The session's extensions and their reload coordinator, for
	 * `_clio-coder/extensions/list` and `/reload`. Absent means both refuse.
	 */
	extensions?: AcpExtensionsControl;
	/**
	 * The chat loop's out-of-turn rounds, for `_clio-coder/aside/*` (`/btw` and
	 * `/draft`). Absent means the three methods refuse.
	 */
	aside?: AcpAsideControl;
	/**
	 * The session's cost ledger, folded as /usage folds it, and the quota
	 * service, for `_clio-coder/usage/read`. Absent means the method refuses.
	 */
	usage?: AcpUsageSource;
	/**
	 * The plugin-resource reload /library reload runs, so a library change made
	 * elsewhere reaches this open session. Absent means the method refuses.
	 */
	libraryReload?: AcpLibraryReload;
	/**
	 * The chat's context accounting, read for `_clio-coder/context/ledger`.
	 * Absent means the method is not announced and refuses.
	 */
	contextLedger?: () => ContextLedger;
	/** Ownership-checked cancellation of project context work, distinct from chat reduction. */
	cancelContextOperation?: (sessionId: string, cwd: string, operationId?: string) => boolean;
	/**
	 * The session's task-board plan, re-read after every settled tool call so a
	 * change reaches the client as the standard `plan` update. Absent means no
	 * `plan` update is sent; `_clio-coder/session/board` still carries the plan.
	 */
	plan?: () => TaskBoardSnapshot | null;
	/**
	 * Probes the workspace's Git facts for `_meta[ACP_WORKSPACE_META_KEY]` on the
	 * session responses and on `session_info_update` when they change. Absent
	 * means the capability is not announced and no workspace view is sent.
	 */
	workspace?: (cwd: string) => Promise<WorkspaceSnapshot>;
	/**
	 * The `/view` overlay's provider inputs for the bound session, read for
	 * `_clio-coder/artifacts/*`. Absent means both methods are not announced
	 * and refuse.
	 */
	artifacts?: AcpArtifactsSource;
	/**
	 * Expands operator syntax in a prompt as the terminal does before it submits:
	 * `@path` file and image references, prompt templates and `/skill` requests,
	 * plus the prompt's own image blocks. Absent means the text is submitted as
	 * typed and image blocks are not accepted.
	 */
	expandPrompt?: (
		text: string,
		images: ReadonlyArray<{ type: "image"; mimeType: string; data: string }>,
	) => Promise<AcpPromptExpansion>;
	toolRegistry?: ToolRegistry;
	/**
	 * The terminal's `!` line gate: labels the information-flow sources an
	 * operator shell line names and returns why they could not be labeled, which
	 * keeps that line's output out of context. Absent means
	 * `_clio-coder/session/shell` is not announced and refuses, as it does when
	 * the session readers it records and replays through are not wired.
	 */
	labelOperatorCommand?: (command: string, cwd: string) => string | null;
	/**
	 * Tool calls the host makes on the operator's behalf inside a prompt turn,
	 * such as the dispatch a `/council` command starts. They arrive as the same
	 * engine-shaped `tool_execution_*` events the chat emits and are announced
	 * as the turn's own calls, so an approval one parks binds to a call the
	 * client can see.
	 */
	hostToolEvents?: { onEvent(handler: (event: AcpServerEvent) => void): () => void };
	mcpCapabilities?: Pick<McpCapabilitySource, "attachClientServers" | "detachClientServers">;
	bus?: SafeEventBus;
	autonomy?: () => AutonomyLevel;
	/** Shared with the deferred front when the workspace binds after initialize. */
	handshake?: AcpHandshake;
	/**
	 * Carries `ask_user` rounds and harness cards to a client that advertised
	 * `clio-coder/interviews`. Absent means the host asks nobody.
	 */
	interviews?: AcpInterviewChannel;
	/**
	 * Answers a dispatched worker's permission ask on the operator's behalf. Absent
	 * means worker asks are never forwarded, whatever the client advertises.
	 */
	workerPermissions?: { resolve(runId: string, requestId: string, decision: "approve" | "deny"): void };
	/** Resolves the first queued workspace request after every handler is installed. */
	onReady?: () => void;
	/** Initial effective next-turn route captured when a session is bound. */
	routing?: () => AcpRoutingSnapshot;
	/** Durable rich-entry reader used by standard session/load. */
	readSessionEntries?: (sessionId: string) => ReadonlyArray<SessionEntry>;
	/**
	 * Builds the provider context; this is deliberately separate from client
	 * replay. `upto` is the historical cut a /tree switch makes: sidecars written
	 * after the selected turn stay out, where a live leaf keeps them.
	 */
	buildReplayMessages?: (
		entries: ReadonlyArray<SessionEntry>,
		leafTurnId: string | null,
		scope?: "leaf" | "upto",
	) => ReadonlyArray<AgentMessage>;
	/** Apply a route change only to this hosted session, leaving saved defaults alone. */
	setSessionRouting?: (patch: { target?: string; model?: string; thinkingLevel?: AcpThinkingLevel }) => void;
	onActiveSessionAutonomyChange?: (level: AutonomyLevel | null) => void;
	cwd?: string;
	version?: string;
	permissionTimeoutMs?: number;
	/**
	 * Where text this process did not author goes instead of the wire. Stdout is
	 * JSON-RPC only, so the operator-facing detail behind a failure lands on the
	 * unstructured stderr tail (CONTRACT C001 §6). Defaults to dropping it.
	 */
	diagnostics?: (line: string) => void;
	/**
	 * Clock the tool-progress interval floor measures against. Injectable
	 * because the floor and the per-call frame ceiling are otherwise only
	 * observable by spending {@link ACP_MIN_TOOL_PROGRESS_INTERVAL_MS} of real
	 * time per frame, which puts a 64-frame ceiling sixteen seconds away.
	 */
	now?: () => number;
}

interface AcpServerSession {
	id: string;
	cwd: string;
	autonomy: AutonomyLevel;
	autonomySource: "settings" | "session";
	target: string | null;
	model: string | null;
	thinkingLevel: AcpThinkingLevel;
	createdAt: string;
	activePrompt: ActivePrompt | null;
}

interface ActivePrompt {
	cancelled: boolean;
	/** The server approval ceiling won; distinct from operator cancellation/denial. */
	permissionExpired: boolean;
	/** The ACP presentation ceiling won before a 129th tool call reached the wire. */
	toolCallLimitReached: boolean;
	errored: boolean;
	errorMessage?: string;
	/** Machine-readable reason from the first admission notice of this turn. */
	admissionReason?: string;
	sentAssistantChars: number;
	sentThinkingChars: number;
	/** `session/update` notifications emitted for this turn. */
	updatesSent: number;
	/** True once the engine reported a turn end (`message_end` or `agent_end`). */
	sawTurnEnd: boolean;
	stopReason: string;
	usage: AcpServerUsage;
	usageMessages: WeakSet<object>;
	model?: string;
	generationMs?: number;
	timedOutputTokens?: number;
	ttftMs?: number;
	/**
	 * Engine tool-call id -> every wire id it has been given this turn, oldest
	 * first. An engine that reuses one id for two calls gets a second wire id
	 * rather than a second call folded onto the first.
	 */
	toolCallWireIds: Map<string, string[]>;
	/** Every wire id this turn has handed out, literal engine ids and aliases alike. */
	usedWireIds: Set<string>;
	/** Wire ids that received `tool_call` and no terminal `tool_call_update`. */
	openToolCalls: Set<string>;
	/**
	 * Wire ids that have already received a terminal `tool_call_update`, the
	 * cancel/fail sweep included. A client renders the first terminal update it
	 * sees and a second one for the same id either resurrects a finished call or
	 * overwrites its result, so a terminal id is never updated again.
	 */
	terminalToolCalls: Set<string>;
	/**
	 * Wire id -> the exact frame material that id's `tool_call` carried. A
	 * permission request reuses this instead of deriving anything from the
	 * registry's copy of the call: a tool's `prepareAdmissionArguments` may
	 * normalize or wholly replace the arguments before the safety net sees them,
	 * so the two frames legitimately disagreed and a client diffing the call it
	 * rendered against the call it is asked to approve failed closed. One entry
	 * per emitted call, each bounded by the raw-record cap, so the map is bounded
	 * by the turn's tool calls and dies with the turn.
	 */
	toolCallSnapshots: Map<string, AcpToolCallSnapshot>;
	/** Most recent wire id a `tool_call` was actually emitted for, open or not. */
	lastEmittedToolCallId: string | null;
	toolCallSequence: number;
	/** Opt-in state and per-call counters for the non-terminal progress stream. */
	toolProgress: AcpToolProgressState;
	/**
	 * The run a queue send-now started by interrupting this one. The request
	 * that opened the turn waits for it, so its events stream on the same
	 * subscription and its stop reason is the one this prompt returns.
	 */
	continuation: Promise<void> | null;
	/** False once the request stopped waiting on runs; a send-now then has nothing to ride. */
	acceptsContinuation: boolean;
}

/**
 * What one turn has already streamed for each running tool call. The payload a
 * tool reports is cumulative, so the last text sent is kept as well as the
 * counters: an unchanged snapshot is a re-send of a frame the client already
 * rendered and carries nothing it does not have. Bounded by the turn's tool
 * calls and dies with the turn.
 */
interface AcpToolProgressState {
	enabled: boolean;
	now: () => number;
	calls: Map<string, { frames: number; lastSentAt: number; lastText: string }>;
}

/** What one emitted `tool_call` put on the wire that its permission request must repeat. */
interface AcpToolCallSnapshot {
	rawInput: Record<string, unknown>;
	locations?: AcpToolCallLocation[];
	/** Exact title and kind this call was announced under, replayed by later updates. */
	title: string;
	kind: AcpToolKind;
	/**
	 * Delegated agents this call spawned, oldest first, bounded by
	 * {@link ACP_MAX_TOOL_CALL_AGENTS}. A dispatch tool that fans out reports one
	 * entry per run, which is what lets a client label the segment with the
	 * agents that actually ran under it rather than with the product name.
	 */
	agents?: AcpAgentAttribution[];
}

/** One `clio-coder/agent` attribution entry. `role` names where the identity came from. */
interface AcpAgentAttribution {
	version: 1;
	role: "orchestrator" | "worker";
	agentId: string;
	runId?: string;
	node?: string;
}

interface AcpServerUsage {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventRecord(value: unknown): AcpEventRecord {
	return isRecord(value) ? value : {};
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Maps Clio canonical tool names onto the ACP v1 `ToolKind` closed enum. The
 * kind is a UI hint; the human-readable tool name travels in `title`. Anything
 * unrecognised (dynamic/MCP tools) falls back to `other` so the discriminated
 * union always deserialises on strict clients.
 */
const TOOL_KIND_BY_NAME: Record<string, AcpToolKind> = {
	read: "read",
	ls: "read",
	context: "read",
	write: "edit",
	edit: "edit",
	artifact: "edit",
	grep: "search",
	find: "search",
	code_nav: "search",
	bash: "execute",
	verify: "execute",
	web_fetch: "fetch",
	git: "other",
	dispatch: "other",
	monitor: "read",
	steer: "other",
};

/**
 * The admission reasons this server puts on the wire (CONTRACT C001 §4). The
 * engine's runtime-resolution diagnostics are a larger and faster-moving set
 * (`runtime-target-unsupported`, `runtime-use-unsupported`,
 * `required-capability-missing`, …), and a client cannot branch on codes the
 * profile never promised, so anything outside this set is reported as the
 * catch-all rather than leaking an engine-internal identifier.
 */
const ACP_ADMISSION_REASONS = new Set([
	"orchestrator-not-configured",
	"target-unknown",
	"target-not-configured",
	"target-not-found",
	"runtime-not-registered",
	"model-not-configured",
	"chat-unsupported",
	"streaming-unsupported",
	"context-window-exceeded",
	"admission-failed",
]);

const ACP_ADMISSION_FALLBACK_REASON = "admission-failed";

function admissionReason(raw: string): string {
	return ACP_ADMISSION_REASONS.has(raw) ? raw : ACP_ADMISSION_FALLBACK_REASON;
}

function toolKind(name: string | undefined): AcpToolKind {
	if (!name) return "other";
	return TOOL_KIND_BY_NAME[name] ?? "other";
}

/** ACP `ToolCallContent[]`. The `content` variant wraps a regular ContentBlock. */
function toolCallContent(text: string): Array<{ type: "content"; content: { type: "text"; text: string } }> {
	return [{ type: "content", content: textContent(text) }];
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.content === "string") return value.content;
	return "";
}

/**
 * The prompt text of one `session/prompt`. ACP v1 carries it as `params.prompt`,
 * an array of content blocks. Text and resource links are the baseline prompt
 * types in ACP v1; a link becomes a reference the model can see. Image blocks
 * are read by {@link promptImages} when the host expands prompts, and embedded
 * resources by {@link promptResources}; audio requires a capability this
 * server does not advertise.
 * Nothing else is accepted: tolerating
 * `params.content`, `params.message`, or a bare string meant this server
 * answered request shapes no ACP client sends and no schema describes, so a
 * client's own framing bug looked like a working prompt here and failed
 * against every other agent.
 */
function promptText(params: unknown, resourceLinks = true): string {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return "";
	const parts: string[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		if (
			resourceLinks &&
			block.type === "resource_link" &&
			typeof block.name === "string" &&
			typeof block.uri === "string"
		) {
			parts.push(`Resource: ${block.name} (${block.uri})`);
		}
	}
	return parts.join("\n").trim();
}

/** At most this many embedded resources ride one prompt, each at most this many UTF-8 bytes. */
export const ACP_MAX_PROMPT_RESOURCES = 8;
export const ACP_MAX_PROMPT_RESOURCE_BYTES = 256 * 1024;
const ACP_MAX_RESOURCE_NAME_BYTES = 512;

/**
 * The name a resource is shown to the model under. A `file:` URI names its
 * path, and a GUI attachment (`attachment:<name>`) names the file the operator
 * picked; anything else is shown as its URI. Quotes and control characters are
 * dropped so the name cannot close the `<file name="…">` attribute early.
 */
function resourceName(uri: string): string {
	let name = uri;
	try {
		if (uri.startsWith("file://")) name = decodeURIComponent(new URL(uri).pathname);
		else if (uri.startsWith("attachment:")) name = decodeURIComponent(uri.slice("attachment:".length));
	} catch {
		// A malformed escape leaves the URI as it was sent, which still names the resource.
	}
	let safe = "";
	for (const character of name) {
		const code = character.codePointAt(0) ?? 0;
		if (code > 0x1f && code !== 0x7f && character !== '"') safe += character;
	}
	return boundString(safe, ACP_MAX_RESOURCE_NAME_BYTES) || "resource";
}

/**
 * The embedded text resources of one `session/prompt`, rendered in the
 * `<file name>` shape an `@path` reference expands to. They are appended after
 * the host's expansion, never passed through it: a `@path` or `/name` inside a
 * file the client attached is that file's content, not operator syntax, and
 * expanding it would let an attached file make the host read other files.
 * Binary (`blob`) resources are refused rather than dropped, so a client never
 * believes the model saw a file it did not.
 */
function promptResources(params: unknown): { rendered: string; names: string[] } {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return { rendered: "", names: [] };
	const files: string[] = [];
	const names: string[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block) || block.type !== "resource") continue;
		const resource = isRecord(block.resource) ? block.resource : {};
		if (typeof resource.blob === "string")
			throw new AcpRequestError(-32602, "binary resources are not accepted; embed text", { code: "invalid_params" });
		if (typeof resource.uri !== "string" || resource.uri.length === 0 || typeof resource.text !== "string")
			throw new AcpRequestError(-32602, "an embedded resource needs a uri and text", { code: "invalid_params" });
		if (Buffer.byteLength(resource.text, "utf8") > ACP_MAX_PROMPT_RESOURCE_BYTES)
			throw new AcpRequestError(
				-32602,
				`an embedded resource is larger than ${ACP_MAX_PROMPT_RESOURCE_BYTES / 1024} KiB`,
				{ code: "invalid_params" },
			);
		const name = resourceName(resource.uri);
		names.push(name);
		files.push(`<file name="${name}">\n${resource.text}\n</file>`);
	}
	if (files.length > ACP_MAX_PROMPT_RESOURCES)
		throw new AcpRequestError(-32602, `a prompt carries at most ${ACP_MAX_PROMPT_RESOURCES} embedded resources`, {
			code: "invalid_params",
		});
	return { rendered: files.join("\n"), names };
}

/** Typed text, then the embedded files after a blank line. */
function withResources(text: string, resources: { rendered: string }): string {
	if (resources.rendered === "") return text;
	return text === "" ? resources.rendered : `${text}\n\n${resources.rendered}`;
}

/** At most this many image blocks ride one prompt; the stdio line bounds their bytes. */
export const ACP_MAX_PROMPT_IMAGES = 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * The image blocks of one `session/prompt`, checked for shape only. The host's
 * prompt expander decides from the bytes whether each is an image it accepts,
 * so a client's `mimeType` is carried but never trusted.
 */
function promptImages(params: unknown): Array<{ type: "image"; mimeType: string; data: string }> {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return [];
	const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
	for (const block of params.prompt) {
		if (!isRecord(block) || block.type !== "image") continue;
		if (typeof block.mimeType !== "string" || typeof block.data !== "string" || !BASE64.test(block.data))
			throw new AcpRequestError(-32602, "an image block needs a mimeType and base64 data", { code: "invalid_params" });
		images.push({ type: "image", mimeType: block.mimeType.slice(0, 64), data: block.data });
	}
	if (images.length > ACP_MAX_PROMPT_IMAGES)
		throw new AcpRequestError(-32602, `a prompt carries at most ${ACP_MAX_PROMPT_IMAGES} images`, {
			code: "invalid_params",
		});
	return images;
}

/** Marker appended to any value this server shortened before sending it. */
const ACP_TRUNCATION_SUFFIX = "…[truncated]";

const ACP_TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(ACP_TRUNCATION_SUFFIX, "utf8");

/** Frozen bounds for standard ACP tool-call presentation fields. */
const ACP_MAX_LOCATION_PATH_BYTES = 4 * 1024;
const ACP_MAX_TOOL_TITLE_BYTES = 512;

/** W001-A1 cardinality bounds for one live prompt and one load replay. */
const ACP_MAX_LIVE_TOOL_CALLS = 128;

/**
 * Bus channels this server is willing to forward over the opt-in
 * `_clio-coder/event` notification. Nothing outside this list is forwardable:
 * the list is the allowlist, and a client's requested kinds are intersected
 * with it rather than trusted. `safety.loopBlocked` was the first member; the
 * dispatch lifecycle joined it so a client can draw a live fleet board from
 * reported facts instead of inferring one from tool titles or timing;
 * `accountability.evidenceReady` follows a run's terminal event once its
 * evidence bundle has landed, so the board can show first-pass success and a
 * finding count without reading Clio's state tree. The last four are the
 * session's own health: without them a client can only infer that context was
 * compacted, that the window is close to full, that the loop guard stopped a
 * turn on volume rather than repetition, or that a target went down, by
 * watching timing and tool titles.
 *
 * Every kind here is the literal `BusChannels` value of the channel it
 * forwards. That is the invariant: a kind is never renamed on the way out, so
 * `grep` finds the producer from the wire frame and a client's kind list and
 * Clio's own channel table cannot drift into two vocabularies.
 */
const ACP_FORWARDABLE_EVENT_KINDS = [
	"safety.loopBlocked",
	"dispatch.enqueued",
	"dispatch.started",
	"dispatch.progress",
	"dispatch.completed",
	"dispatch.failed",
	"accountability.evidenceReady",
	"compaction.end",
	"context.activity",
	"context.warning",
	"safety.toolBudgetExceeded",
	"provider.health",
	"dispatch.scopeNotice",
] as const;

type AcpForwardableEventKind = (typeof ACP_FORWARDABLE_EVENT_KINDS)[number];

/** A client may name at most this many kinds; an over-long list refuses the whole opt-in. */
const ACP_MAX_REQUESTED_EVENT_KINDS = 16;

/**
 * Sanitized, bounded preview of a dispatched task. The exact task is the
 * operator's own prose and can be arbitrarily long, so what crosses is a
 * control-character-stripped prefix carrying the standard truncation marker;
 * the exact text never leaves the process.
 */
const ACP_MAX_DISPATCH_TASK_PREVIEW_BYTES = 160;

/** Wire bound for the short identifiers a dispatch event carries. */
const ACP_MAX_DISPATCH_ID_BYTES = 128;
/** Evidence tags are a closed vocabulary of short identifiers; anything wider is not a tag. */
const ACP_MAX_EVIDENCE_TAGS = 32;
const ACP_MAX_EVIDENCE_TAG_BYTES = 64;

/**
 * The one forwarded payload field that is a sentence rather than an
 * identifier: the context-window warning is Clio's own operator copy, so it is
 * bounded to a banner's worth and stripped rather than refused.
 */
const ACP_MAX_EVENT_TEXT_BYTES = 256;
/** A scope notice is two sentences of host prose, longer than a banner line. */
const ACP_MAX_SCOPE_NOTICE_BYTES = 1024;

/**
 * Progress events forwarded per run before the stream is capped. One run
 * publishes one progress fact per worker event, which is unbounded; a client
 * only needs enough to know the run is alive, so the cap is announced with a
 * final `truncated` frame rather than by silently going quiet.
 */
const ACP_MAX_DISPATCH_PROGRESS_EVENTS = 256;

/** Live dispatch runs whose progress counters this server tracks at once. */
const ACP_MAX_TRACKED_DISPATCH_RUNS = 512;

/** Delegated agents recorded against one tool call before further ones are dropped. */
const ACP_MAX_TOOL_CALL_AGENTS = 16;

/**
 * Attribution for a frame this server produced on the main session. Every live
 * frame carries it, so a client never has to decide whether an unattributed
 * frame means "the orchestrator" or "identity unavailable".
 */
const ORCHESTRATOR_ATTRIBUTION: AcpAgentAttribution = {
	version: 1,
	role: "orchestrator",
	agentId: "orchestrator",
};

const ORCHESTRATOR_UPDATE_META: Record<string, unknown> = {
	[ACP_AGENT_META_KEY]: [ORCHESTRATOR_ATTRIBUTION],
};

/** The `_meta` a tool-call frame carries: its own agents when it spawned any, else the orchestrator. */
function toolCallUpdateMeta(snapshot: AcpToolCallSnapshot | undefined): Record<string, unknown> {
	if (snapshot?.agents === undefined || snapshot.agents.length === 0) return ORCHESTRATOR_UPDATE_META;
	return { [ACP_AGENT_META_KEY]: [ORCHESTRATOR_ATTRIBUTION, ...snapshot.agents] };
}

/** Depth past which `boundRawRecord` stops walking and elides the subtree. */
const ACP_MAX_RAW_RECORD_DEPTH = 8;

/**
 * The longest prefix of `value` that fits `maxBytes` UTF-8 bytes without
 * splitting a code point. `Buffer.write` stops before a partial sequence, so a
 * surrogate pair is either wholly inside the prefix or wholly outside it and no
 * cut can produce a lone surrogate the peer decodes as a replacement character.
 */
function sliceToBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.allocUnsafe(maxBytes);
	const written = buffer.write(value, 0, maxBytes, "utf8");
	return buffer.toString("utf8", 0, written);
}

/** Bounds one string to `maxBytes` UTF-8 bytes, marker included in the budget. */
function boundString(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	// The marker is part of what goes on the wire, so it is reserved inside the
	// cap rather than appended past it.
	const budget = maxBytes - ACP_TRUNCATION_SUFFIX_BYTES;
	if (budget <= 0) return sliceToBytes(value, maxBytes);
	return `${sliceToBytes(value, budget)}${ACP_TRUNCATION_SUFFIX}`;
}

/**
 * Splits one delta into wire-sized chunks. Nothing is dropped and no code point
 * is split: the pieces concatenate back to the input, so a client that appends
 * chunks in order reconstructs the model's text exactly.
 */
function chunkText(text: string, maxBytes: number): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const chunk = sliceToBytes(rest, maxBytes);
		// One code point wider than the whole bound cannot be split further, so it
		// travels oversized rather than being dropped or mangled.
		if (chunk.length === 0) {
			chunks.push(rest);
			break;
		}
		chunks.push(chunk);
		rest = rest.slice(chunk.length);
	}
	return chunks;
}

/**
 * The string cap for the value sitting at `key` inside a record sitting at
 * `parentKey`. Everything gets {@link ACP_MAX_STRING_BYTES}; the single
 * exception is the rendered diff an `edit` or `write` result carries, which the
 * engine has already capped for exactly this purpose. The match is on the whole
 * two-segment path and not on the key alone, so a tool that happens to report a
 * top-level `diff` string does not widen itself into the exception.
 */
function rawStringBytes(key: string | undefined, parentKey: string | undefined): number {
	return key === "diff" && parentKey === "details" ? ACP_MAX_RAW_DIFF_BYTES : ACP_MAX_STRING_BYTES;
}

function boundRawValue(value: unknown, depth: number, key?: string, parentKey?: string): unknown {
	if (typeof value === "string") return boundString(value, rawStringBytes(key, parentKey));
	if (Array.isArray(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		// A member inherits no path: `details.diff` names one string, not a list
		// of them, and a thousand-entry array of wide strings is the payload the
		// record cap exists to stop.
		return value.map((entry) => boundRawValue(entry, depth + 1));
	}
	if (isRecord(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		const bounded: Record<string, unknown> = {};
		for (const [entryKey, entry] of Object.entries(value)) {
			bounded[entryKey] = boundRawValue(entry, depth + 1, entryKey, key);
		}
		return bounded;
	}
	return value;
}

/**
 * The record's serialized UTF-8 size before any bounding, or null when it does
 * not serialize at all (a cycle, a BigInt, a throwing `toJSON`). This is the
 * figure `{truncated:true,bytes}` reports: the size a client is told about is
 * the payload the engine actually produced, not the size of the shortened copy
 * this process built and then decided not to send.
 */
function originalRawRecordBytes(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
	} catch {
		return null;
	}
}

/**
 * Bounds one `rawInput`/`rawOutput` record for the wire (CONTRACT C001 §3).
 * Strings are capped first, then the whole record: a payload that is still over
 * the record cap after per-string bounding is thousands of small fields, and
 * the honest thing to send is the fact that it was elided plus its size.
 */
function boundRawRecord(value: unknown): Record<string, unknown> {
	const bounded = isRecord(value) ? (boundRawValue(value, 0) as Record<string, unknown>) : {};
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(bounded);
	} catch {
		serialized = undefined;
	}
	// Nothing about this record can be measured, so the elision carries whatever
	// size the original could still report and 0 when it could not report one.
	if (serialized === undefined) return { truncated: true, bytes: originalRawRecordBytes(value) ?? 0 };
	const boundedBytes = Buffer.byteLength(serialized, "utf8");
	if (boundedBytes <= ACP_MAX_RAW_RECORD_BYTES) return bounded;
	// The bounded size is the fallback: an unserializable original has no size of
	// its own, and reporting the copy's is closer than reporting nothing.
	return { truncated: true, bytes: originalRawRecordBytes(value) ?? boundedBytes };
}

/** Built-in tools whose first positional argument names a workspace path. */
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

/**
 * The standard `locations` field for a path-bearing call. The path is resolved
 * against the pinned workspace root but never realpath'ed: an `edit` or `write`
 * target legitimately does not exist yet, and a client that canonicalizes on
 * its own side treats an absent `locations` as "unavailable".
 */
function toolLocations(toolName: string | undefined, args: unknown, cwd: string): AcpToolCallLocation[] | null {
	if (toolName === undefined || !PATH_BEARING_TOOLS.has(toolName)) return null;
	if (!isRecord(args)) return null;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return null;
	return [{ path: boundString(resolvePath(cwd, path), ACP_MAX_LOCATION_PATH_BYTES) }];
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function emptyUsage(): AcpServerUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		costUsd: 0,
		costProvenance: "unknown",
		costProvenanceObserved: false,
	};
}

function createActivePromptState(toolProgress?: { enabled: boolean; now: () => number }): ActivePrompt {
	return {
		cancelled: false,
		permissionExpired: false,
		toolCallLimitReached: false,
		errored: false,
		sentAssistantChars: 0,
		sentThinkingChars: 0,
		updatesSent: 0,
		sawTurnEnd: false,
		stopReason: "end_turn",
		usage: emptyUsage(),
		usageMessages: new WeakSet<object>(),
		toolCallWireIds: new Map<string, string[]>(),
		usedWireIds: new Set<string>(),
		openToolCalls: new Set<string>(),
		terminalToolCalls: new Set<string>(),
		toolCallSnapshots: new Map<string, AcpToolCallSnapshot>(),
		lastEmittedToolCallId: null,
		toolCallSequence: 0,
		toolProgress: {
			enabled: toolProgress?.enabled === true,
			now: toolProgress?.now ?? Date.now,
			calls: new Map<string, { frames: number; lastSentAt: number; lastText: string }>(),
		},
		continuation: null,
		acceptsContinuation: true,
	};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Only field `sumRunUsage` (chat-loop-messages.ts) reads for a dollar figure; matched here so ACP never re-derives cost through a separate path. */
function costTotal(usage: Record<string, unknown>): number {
	const cost = usage.cost;
	return isRecord(cost) ? finite(cost.total) : 0;
}

export function mergeUsage(into: AcpServerUsage, usage: unknown): void {
	if (!isRecord(usage)) return;
	const input =
		finite(usage.input) + finite(usage.inputTokens) + finite(usage.input_tokens) + finite(usage.prompt_tokens);
	const output =
		finite(usage.output) + finite(usage.outputTokens) + finite(usage.output_tokens) + finite(usage.completion_tokens);
	const cacheRead = finite(usage.cacheRead) + finite(usage.cacheReadTokens) + finite(usage.cache_read_tokens);
	const cacheWrite = finite(usage.cacheWrite) + finite(usage.cacheWriteTokens) + finite(usage.cache_write_tokens);
	const reasoning = finite(usage.reasoning) + finite(usage.reasoningTokens) + finite(usage.reasoning_tokens);
	into.input += input;
	into.output += output;
	into.cacheRead += cacheRead;
	into.cacheWrite += cacheWrite;
	into.reasoning += reasoning;
	// Same fallback sumRunUsage uses: prefer the provider's own total, otherwise
	// sum the four merged categories for this message (reasoning excluded,
	// matching sumRunUsage, since a provider that reports reasoning separately
	// still counts it inside output for billing).
	const explicitTotal = finite(usage.totalTokens) + finite(usage.total_tokens);
	into.totalTokens += explicitTotal > 0 ? explicitTotal : input + output + cacheRead + cacheWrite;
	into.costUsd += costTotal(usage);
	const provenance = resolveCostProvenance(usage.costProvenance, "unknown");
	if (!into.costProvenanceObserved) into.costProvenance = provenance;
	else if (into.costProvenance === "unknown" || provenance === "unknown") into.costProvenance = "unknown";
	else if (into.costProvenance === "estimated" || provenance === "estimated") into.costProvenance = "estimated";
	else if (into.costProvenance === "known" || provenance === "known") into.costProvenance = "known";
	else into.costProvenance = "known_free";
	into.costProvenanceObserved = true;
}

function mergeMessageUsage(into: AcpServerUsage, message: unknown, seen?: WeakSet<object>): void {
	if (!isRecord(message)) return;
	if (seen) {
		if (seen.has(message)) return;
		seen.add(message);
	}
	mergeUsage(into, message.usage);
}

function mergeMessagesUsage(into: AcpServerUsage, messages: unknown, seen?: WeakSet<object>): void {
	if (!Array.isArray(messages)) return;
	for (const message of messages) mergeMessageUsage(into, message, seen);
}

function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	return contentText(message.content);
}

function assistantThinking(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "thinking" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("");
}

/**
 * Collapses pi-agent / Clio message stop reasons onto the ACP v1 StopReason
 * closed enum (end_turn | max_tokens | max_turn_requests | refusal | cancelled).
 * Tool-driven or unknown reasons ("stop", "toolUse", "length"…) map to
 * "end_turn"; "error" is a sentinel that the prompt handler converts into a
 * JSON-RPC error, since ACP has no error StopReason.
 */
function mapAcpStopReason(raw: unknown): string {
	switch (raw) {
		case "aborted":
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "refusal":
			return "refusal";
		case "length":
		case "max_tokens":
		case "maxTokens":
			return "max_tokens";
		case "max_turn_requests":
		case "maxTurnRequests":
			return "max_turn_requests";
		default:
			return "end_turn";
	}
}

/** Applies a message's stop reason to the active prompt, tracking the error sentinel. */
function applyStopReason(active: ActivePrompt, message: unknown): void {
	const mapped = mapAcpStopReason(isRecord(message) ? message.stopReason : undefined);
	if (mapped === "error") {
		active.errored = true;
		const explicit = isRecord(message) && typeof message.errorMessage === "string" ? message.errorMessage : "";
		const text = explicit.length > 0 ? explicit : assistantText(message);
		if (text.length > 0) active.errorMessage = text;
		return;
	}
	active.errored = false;
	active.stopReason = mapped;
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	const presentationText = toolResultPresentationText(value);
	if (presentationText !== null) return presentationText;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.output === "string") return value.output;
	if (typeof value.text === "string") return value.text;
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function toolStatus(event: AcpEventRecord): string {
	return event.isError === true ? "failed" : "completed";
}

function eventString(event: AcpEventRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = event[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function eventTextDelta(event: AcpEventRecord): string {
	const direct = eventString(event, "delta", "text");
	if (direct !== undefined) return direct;
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	if (assistantEvent) {
		const nested = assistantEvent.delta;
		if (typeof nested === "string") return nested;
	}
	return "";
}

/**
 * The next unused `clio-coder-tool-<n>`. The counter alone is not enough: an engine
 * that names its own calls `clio-coder-tool-1` would otherwise collide with an alias
 * this server minted, and two different calls sharing one wire id is the exact
 * failure aliasing exists to prevent.
 */
function nextAliasToolCallId(active: ActivePrompt): string {
	for (;;) {
		active.toolCallSequence += 1;
		const alias = `clio-coder-tool-${active.toolCallSequence}`;
		if (active.usedWireIds.has(alias)) continue;
		active.usedWireIds.add(alias);
		return alias;
	}
}

function normalizeReleasedAliasToolCallId(engineId: string): string {
	const legacy = /^clio-tool-([1-9]\d*)$/u.exec(engineId);
	return legacy === null ? engineId : `clio-coder-tool-${legacy[1]}`;
}

/** Records `wireId` as the newest wire id this engine id speaks under. */
function pushWireId(active: ActivePrompt, engineId: string, wireId: string): string {
	const existing = active.toolCallWireIds.get(engineId);
	if (existing === undefined) active.toolCallWireIds.set(engineId, [wireId]);
	else existing.push(wireId);
	return wireId;
}

/**
 * The first wire id an engine id gets. The engine's own id is used when it fits
 * the wire bound and no other call in this turn has claimed it; otherwise the
 * call travels under a per-prompt alias.
 */
function mintWireId(active: ActivePrompt, engineId: string): string {
	const candidate = normalizeReleasedAliasToolCallId(engineId);
	const usable = utf8Bytes(candidate) <= ACP_MAX_TOOL_CALL_ID_BYTES && !active.usedWireIds.has(candidate);
	if (usable) active.usedWireIds.add(candidate);
	return pushWireId(active, engineId, usable ? candidate : nextAliasToolCallId(active));
}

/**
 * The id a starting tool call travels under. An engine id this turn has already
 * used gets a fresh alias rather than the wire id of the earlier call: engines
 * that number their calls per request legitimately repeat an id, and reusing the
 * wire id merged two distinct calls into one on the client, so the second call's
 * arguments overwrote the first and one of the two ends was lost.
 */
function startToolCallId(active: ActivePrompt, engineId: string | undefined): string {
	if (engineId === undefined || engineId.length === 0) return nextAliasToolCallId(active);
	if (active.toolCallWireIds.has(engineId)) return pushWireId(active, engineId, nextAliasToolCallId(active));
	return mintWireId(active, engineId);
}

/**
 * The most recently opened wire id for this engine id, or null when it names no
 * call that is still open. "Open" is the client's own view: a `tool_call` was
 * emitted and no terminal `tool_call_update` followed it.
 */
function openWireIdFor(active: ActivePrompt, engineId: string): string | null {
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	for (let index = wireIds.length - 1; index >= 0; index -= 1) {
		const wireId = wireIds[index];
		if (wireId !== undefined && active.openToolCalls.has(wireId)) return wireId;
	}
	return null;
}

/**
 * The most recently opened wire id this turn still has running, or null when
 * nothing is open. `openToolCalls` is insertion-ordered and only ever loses
 * members, so the last one standing is the newest call the client has been shown
 * and not yet seen finish.
 */
function newestOpenToolCallId(active: ActivePrompt): string | null {
	let newest: string | null = null;
	for (const wireId of active.openToolCalls) newest = wireId;
	return newest;
}

/**
 * The wire id an ending tool call travels under, or null when this turn has no
 * call it could belong to. Nothing here mints: an end is an update to a call the
 * client already rendered, and a fresh id announced a `tool_call_update` for a
 * `tool_call` that was never sent, which a client either drops or renders as a
 * tool that finished without ever starting.
 *
 * An end that names an engine id is confined to that engine id's own calls. It
 * closes them newest first, which is the order a nested or retried call finishes
 * in, and when they are all finished it still resolves to that id's last wire id
 * so the caller can drop the end as the duplicate it is. An engine id this turn
 * emitted nothing for binds to nothing: borrowing another call's wire id
 * reported one tool's result under another tool's identity and closed a call
 * that was still running.
 *
 * An end with no engine id belongs to the newest call still running, which is
 * what makes nested lifecycles work. With A and B open and B already ended, the
 * next unidentified end is A's. With nothing open it falls back to the last call
 * the client actually saw, so the caller drops it as a duplicate rather than
 * inventing an identity for it.
 */
function endToolCallId(active: ActivePrompt, engineId: string | undefined): string | null {
	if (engineId === undefined || engineId.length === 0) {
		return newestOpenToolCallId(active) ?? active.lastEmittedToolCallId;
	}
	const open = openWireIdFor(active, engineId);
	if (open !== null) return open;
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	return wireIds[wireIds.length - 1] ?? null;
}

function sendUpdate(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	update: Record<string, unknown>,
	meta: Record<string, unknown> = ORCHESTRATOR_UPDATE_META,
): void {
	const params: AcpSessionUpdateParams = { sessionId, update, _meta: meta };
	active.updatesSent += 1;
	transport.notify("session/update", params);
}

function sendTextChunks(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
	text: string,
): void {
	for (const chunk of chunkText(text, ACP_MAX_CHUNK_BYTES)) {
		sendUpdate(transport, sessionId, active, { sessionUpdate, content: textContent(chunk) });
	}
}

/**
 * Closes out every tool call that never received a terminal update. A client
 * that renders a running spinner per `tool_call` otherwise keeps spinning after
 * the turn settled, since ACP has no "the turn is over, drop what is open"
 * signal beyond the prompt response itself.
 */
function settleOpenToolCalls(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	text: string,
): void {
	for (const toolCallId of active.openToolCalls) {
		sendUpdate(
			transport,
			sessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed" satisfies AcpToolCallStatus,
				content: toolCallContent(text),
			},
			toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)),
		);
		// The sweep is a terminal update like any other, so a late end for a swept
		// id cannot reopen the call the client has already seen fail.
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

/**
 * Streams one running tool's cumulative output as a non-terminal
 * `tool_call_update`. Nothing here mints a wire id: a frame is an update to a
 * call the client already rendered, so an event naming a call that was never
 * emitted or has already finished is dropped rather than announcing progress
 * for a `tool_call` the client has no row for.
 *
 * The three refusals below are the whole cost control. The tool's own throttle
 * bounds the rate but not the total, the payload is cumulative so a repeat
 * carries nothing new, and a client is holding per-call state that a long
 * stream would otherwise grow without a stated end.
 */
function sendToolProgress(
	event: AcpEventRecord,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
): void {
	const progress = active.toolProgress;
	if (!progress.enabled) return;
	const engineId = eventString(event, "toolCallId");
	const toolCallId = engineId === undefined ? null : openWireIdFor(active, engineId);
	if (toolCallId === null) return;
	const text = boundString(outputText(event.partialResult), ACP_MAX_CHUNK_BYTES);
	if (text.length === 0) return;
	const sent = progress.calls.get(toolCallId);
	const sentAt = progress.now();
	if (sent !== undefined) {
		if (sent.frames >= ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL) return;
		if (text === sent.lastText) return;
		if (sentAt - sent.lastSentAt < ACP_MIN_TOOL_PROGRESS_INTERVAL_MS) return;
	}
	progress.calls.set(toolCallId, { frames: (sent?.frames ?? 0) + 1, lastSentAt: sentAt, lastText: text });
	sendUpdate(
		transport,
		sessionId,
		active,
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "in_progress" satisfies AcpToolCallStatus,
			content: toolCallContent(text),
		},
		toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)),
	);
}

const EMPTY_SESSION_USAGE: ReturnType<AcpUsageSource["session"]> = {
	cost: { knownUsd: 0, hasEstimated: false, hasUnknown: false, allKnownFree: false, calls: 0 },
	rows: [],
};

/** Kinds that only look; any other settled call may have moved the branch or the worktree. */
const READ_ONLY_TOOL_KINDS: ReadonlySet<AcpToolKind> = new Set<AcpToolKind>(["read", "search", "fetch"]);

function observeTelemetry(telemetry: AcpLiveTelemetry, rawEvent: AcpServerEvent, active: ActivePrompt): void {
	if (active.permissionExpired || active.toolCallLimitReached) return;
	const event = eventRecord(rawEvent);
	if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
		telemetry.modelResponded();
	} else if (event.type === "tool_execution_end") {
		telemetry.toolSettled(!READ_ONLY_TOOL_KINDS.has(toolKind(eventString(event, "toolName"))));
	}
}

function handleChatEvent(
	rawEvent: AcpServerEvent,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	cwd: string,
	diagnostics: ((line: string) => void) | undefined,
	onToolCallLimitReached: () => void,
): void {
	const event = eventRecord(rawEvent);
	// Once the approval ceiling wins, the prompt is terminal. Registry
	// cancellation may still make engine promises unwind and emit ordinary tool
	// or assistant events; none of those are part of a continuing model turn.
	if (active.permissionExpired || active.toolCallLimitReached) return;
	if (event.type === "text_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentAssistantChars += text.length;
		sendTextChunks(transport, sessionId, active, "agent_message_chunk", text);
		return;
	}
	if (event.type === "thinking_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentThinkingChars += text.length;
		sendTextChunks(transport, sessionId, active, "agent_thought_chunk", text);
		return;
	}
	if (event.type === "notice") {
		const admission = isRecord(event.admission) ? event.admission : null;
		const reason = admission !== null && typeof admission.reason === "string" ? admission.reason : "";
		if (reason.length > 0 && active.admissionReason === undefined) active.admissionReason = admissionReason(reason);
		// An admission notice is the evidence that Clio refused to start the turn:
		// the prompt fails with its reason code, and its text names the settings
		// path, which stays off the wire. Every other transcript notice is projected.
		if (
			reason.length === 0 &&
			event.surface === "transcript" &&
			typeof event.text === "string" &&
			event.text.length > 0
		) {
			sendUpdate(
				transport,
				sessionId,
				active,
				{
					sessionUpdate: "agent_message_chunk",
					content: textContent(`${safeStoredString(event.text, ACP_MAX_CHUNK_BYTES - 2)}\n`),
				},
				{ ...ORCHESTRATOR_UPDATE_META, [ACP_NOTICE_META_KEY]: { level: event.level } },
			);
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		// Tool starts are emitted before registry validation/admission, so Clio's
		// configurable execution guard is not a wire-cardinality guarantee. Stop
		// before minting or emitting the 129th id; the prompt handler resolves with
		// ACP's standard max_turn_requests reason after the underlying run unwinds.
		if (active.usedWireIds.size >= ACP_MAX_LIVE_TOOL_CALLS) {
			active.toolCallLimitReached = true;
			onToolCallLimitReached();
			return;
		}
		const toolName = eventString(event, "toolName");
		const toolCallId = startToolCallId(active, eventString(event, "toolCallId"));
		active.openToolCalls.add(toolCallId);
		active.lastEmittedToolCallId = toolCallId;
		// Clients render kind, title and locations per capability, and the
		// coordinator reaches most capabilities through gateway op=call.
		const call = toolName === undefined ? undefined : effectiveToolCall(toolName, event.args);
		const chainSteps = toolName === undefined ? [] : gatewayChainPlan(toolName, event.args);
		const capability =
			chainSteps.length > 0
				? `gateway chain(${chainSteps.map((step) => step.capability).join(", ")})`
				: (call?.toolName ?? toolName);
		const locations = toolLocations(capability, call?.viaGateway ? call.args : event.args, cwd);
		// Built once and kept: the permission request for this call must send the
		// same objects rather than recompute them from a copy of the arguments that
		// may since have been normalized.
		const snapshot: AcpToolCallSnapshot = {
			rawInput: boundRawRecord(event.args),
			...(locations !== null ? { locations } : {}),
			title: boundString(capability ?? "tool", ACP_MAX_TOOL_TITLE_BYTES),
			kind: toolKind(chainSteps.length > 0 ? toolName : capability),
		};
		active.toolCallSnapshots.set(toolCallId, snapshot);
		sendUpdate(transport, sessionId, active, {
			sessionUpdate: "tool_call",
			toolCallId,
			name: toolName ?? "tool",
			title: snapshot.title,
			kind: snapshot.kind,
			status: "in_progress" satisfies AcpToolCallStatus,
			rawInput: snapshot.rawInput,
			...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
		});
		return;
	}
	if (event.type === "tool_execution_update") {
		sendToolProgress(event, transport, sessionId, active);
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolName = eventString(event, "toolName");
		const toolCallId = endToolCallId(active, eventString(event, "toolCallId"));
		// This turn put no `tool_call` on the wire, so there is no call an update
		// could name. The event is reported on the stderr tail instead.
		if (toolCallId === null) {
			diagnostics?.("dropped tool_execution_end with no tool call to update");
			return;
		}
		// The client has already been told how this call ended. A second terminal
		// update either resurrects a finished call or overwrites its result with a
		// later one, so the duplicate goes to the stderr tail and not the wire.
		if (active.terminalToolCalls.has(toolCallId)) {
			diagnostics?.(`dropped duplicate terminal update for ${toolCallId}`);
			return;
		}
		active.openToolCalls.delete(toolCallId);
		active.terminalToolCalls.add(toolCallId);
		const output = boundString(outputText(event.result), ACP_MAX_CHUNK_BYTES);
		const started = active.toolCallSnapshots.get(toolCallId);
		sendUpdate(
			transport,
			sessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId,
				title: started?.title ?? boundString(toolName ?? "tool", ACP_MAX_TOOL_TITLE_BYTES),
				kind: started?.kind ?? toolKind(toolName),
				status: toolStatus(event),
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: boundRawRecord({ result: event.result, isError: event.isError === true }),
			},
			toolCallUpdateMeta(active.toolCallSnapshots.get(toolCallId)),
		);
		return;
	}
	if (event.type === "message_end") {
		const message = event.message;
		if (isRecord(message) && message.role === "assistant") {
			const model = safeStoredIdentifier(message.model, ACP_MAX_MODEL_ID_BYTES);
			if (model) active.model = model;
			const apiMs = event.modelTimeMs;
			const ttftMs = event.ttftMs;
			const output = isRecord(message.usage) ? message.usage.output : undefined;
			if (typeof ttftMs === "number" && Number.isFinite(ttftMs) && ttftMs >= 0) {
				if (active.ttftMs === undefined) active.ttftMs = ttftMs;
				if (
					typeof apiMs === "number" &&
					Number.isFinite(apiMs) &&
					apiMs > ttftMs &&
					typeof output === "number" &&
					output > 0
				) {
					active.generationMs = (active.generationMs ?? 0) + apiMs - ttftMs;
					active.timedOutputTokens = (active.timedOutputTokens ?? 0) + output;
				}
			}
		}
		active.sawTurnEnd = true;
		mergeMessageUsage(active.usage, message, active.usageMessages);
		applyStopReason(active, message);
		const thinking = assistantThinking(message);
		if (thinking.length > active.sentThinkingChars) {
			const tail = thinking.slice(active.sentThinkingChars);
			active.sentThinkingChars = thinking.length;
			sendTextChunks(transport, sessionId, active, "agent_thought_chunk", tail);
		}
		const text = assistantText(message);
		if (text.length > active.sentAssistantChars) {
			const tail = text.slice(active.sentAssistantChars);
			active.sentAssistantChars = text.length;
			sendTextChunks(transport, sessionId, active, "agent_message_chunk", tail);
		}
		return;
	}
	if (event.type === "agent_end") {
		active.sawTurnEnd = true;
		mergeMessagesUsage(active.usage, event.messages, active.usageMessages);
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const last = [...messages].reverse().find((message) => isRecord(message) && message.role === "assistant");
		if (last !== undefined) applyStopReason(active, last);
		return;
	}
	// Clio lifecycle events (agent_start, retry_status, clio_coder_plan_update) have
	// no ACP v1 SessionUpdate equivalent. The prompt turn is bounded by the
	// session/prompt response, so emitting non-spec `progress` updates would
	// break strict clients. They are intentionally dropped. The same protocol
	// gap applies to routing advisories (external settings divergence, active
	// target removed): ACP v1 has no agent-initiated advisory channel, so the
	// orchestrator records those as `custom` session-ledger entries
	// (customType "clio-coder.routing-notice") instead of inventing update kinds.
}

const ACP_MAX_SESSION_ID_BYTES = 128;
const ACP_MAX_LABEL_BYTES = 256;
const ACP_MAX_CORRECTION_BYTES = 2048;
const ACP_MAX_HANDOFF_GOAL_BYTES = 2048;
/** A rendered handoff is bounded list by list; this is the ceiling on a reviewed edit of it. */
const ACP_MAX_HANDOFF_DOCUMENT_BYTES = 128 * 1024;
const ACP_MAX_HANDOFF_REASON_BYTES = 2048;

/** A handoff seeds a successor and replays it through the same readers a load needs. */
function handoffWired(options: ClioAcpServerOptions): boolean {
	return options.handoff !== undefined && branchesWired(options);
}

/** Tree, switch and fork restore through the same readers `session/load` needs. */
function branchesWired(options: ClioAcpServerOptions): boolean {
	return (
		options.session !== undefined &&
		options.readSessionEntries !== undefined &&
		options.buildReplayMessages !== undefined &&
		options.chat.resetForSession !== undefined
	);
}

/** A shell line is recorded in the session and replayed into context through the same readers. */
function shellWired(options: ClioAcpServerOptions): boolean {
	return options.labelOperatorCommand !== undefined && branchesWired(options);
}

/** The per-entry operations the terminal's queue navigator performs, plus the send-now resubmit. */
function queueEditWired(options: ClioAcpServerOptions): boolean {
	const chat = options.chat;
	return (
		chat.queueEntries !== undefined &&
		chat.removeQueuedEntry !== undefined &&
		chat.moveQueuedEntry !== undefined &&
		chat.setQueuedEntryKind !== undefined
	);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function requireBoundedClientString(
	value: unknown,
	name: string,
	maxBytes: number,
	options: { allowEmpty?: boolean } = {},
): string {
	if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
		throw new AcpRequestError(-32602, `${name} is required`, { code: "invalid_params" });
	}
	if (utf8Bytes(value) > maxBytes || hasControlCharacters(value)) {
		throw new AcpRequestError(-32602, `${name} is invalid`, { code: "invalid_params" });
	}
	return value;
}

function safeStoredString(value: unknown, maxBytes: number, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
	}
	return boundString(safe, maxBytes);
}

function safeStoredIdentifier(value: unknown, maxBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || hasControlCharacters(value) || utf8Bytes(value) > maxBytes) {
		return null;
	}
	return value;
}

/**
 * A selected route cannot be represented as null merely to satisfy the wire
 * bound: null means genuinely unselected in W001. Refuse the affected method
 * instead, with the fixed internal-error envelope, until the operator repairs
 * the local configuration.
 */
function safeConfiguredIdentifier(value: unknown, maxBytes: number): string | null {
	if (value === null || value === undefined) return null;
	const safe = safeStoredIdentifier(value, maxBytes);
	if (safe === null) {
		throw new AcpRequestError(-32603, "configured route cannot be represented safely", { code: "internal_error" });
	}
	return safe;
}

function safeIso(value: unknown): string {
	if (typeof value === "string" && !hasControlCharacters(value)) {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date(0).toISOString();
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
	return isRecord(payload) ? payload : null;
}

function replayTextBlocks(entry: MessageEntry): { text: string[]; thinking: string[] } {
	const text: string[] = [];
	const thinking: string[] = [];
	if (typeof entry.payload === "string") text.push(entry.payload);
	const payload = payloadRecord(entry.payload);
	if (payload === null) return { text, thinking };
	if (typeof payload.text === "string") text.push(payload.text);
	if (!Array.isArray(payload.content)) return { text, thinking };
	// A rich payload's `text` is the flattened copy of `content`. Prefer the
	// original blocks so a replay does not duplicate the same prose.
	if (payload.content.length > 0) text.length = 0;
	for (const block of payload.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") text.push(block.text);
		if (block.type === "thinking") {
			if (typeof block.thinking === "string") thinking.push(block.thinking);
			else if (typeof block.text === "string") thinking.push(block.text);
		}
	}
	return { text, thinking };
}

interface AcpReplayFrame {
	update: Record<string, unknown>;
	meta?: Record<string, unknown>;
}

interface AcpReplayTurn {
	frames: AcpReplayFrame[];
}

interface PreparedAcpReplay {
	params: Array<AcpSessionUpdateParams & { _meta: Record<string, unknown> }>;
	/** Dispatched runs on the replayed branch, in ledger order, for their terminal frames. */
	runs: Array<{ runId: string; agentId: string }>;
	turns: number;
	truncated: boolean;
}

function replayMessageChunks(
	frames: AcpReplayFrame[],
	sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
	texts: ReadonlyArray<string>,
): void {
	for (const text of texts) {
		for (const chunk of chunkText(text, ACP_MAX_CHUNK_BYTES)) {
			if (chunk.length === 0) continue;
			frames.push({ update: { sessionUpdate, content: textContent(chunk) } });
		}
	}
}

function replayToolCall(entry: MessageEntry): { engineId: string; name: string; args: unknown } {
	const payload = payloadRecord(entry.payload);
	return {
		engineId:
			typeof payload?.toolCallId === "string" && payload.toolCallId.length > 0
				? payload.toolCallId
				: `persisted-tool-${entry.turnId}`,
		name: safeStoredString(payload?.name ?? payload?.toolName, 64, "tool") || "tool",
		args: payload?.args,
	};
}

function closeUnrecordedReplayCalls(active: ActivePrompt, frames: AcpReplayFrame[]): void {
	for (const toolCallId of active.openToolCalls) {
		frames.push({
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed" satisfies AcpToolCallStatus,
				content: toolCallContent("unrecorded"),
			},
		});
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

/** The live shell line's call and settled update, rebuilt from what its entry recorded. */
function replayShellLine(entry: BashExecutionEntry): AcpReplayFrame[] {
	const excludeFromContext = entry.excludeFromContext === true;
	const meta = { [ACP_SHELL_META_KEY]: { version: 1, excludeFromContext } };
	const toolCallId = `shell_${entry.turnId}`;
	const command = safeStoredString(entry.command, ACP_MAX_SHELL_COMMAND_BYTES);
	const title = boundString(command, ACP_MAX_TOOL_TITLE_BYTES);
	const output = shellOutputTail(entry.output);
	return [
		{
			update: {
				sessionUpdate: "tool_call",
				toolCallId,
				name: "shell",
				title,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolCallStatus,
				rawInput: { command, excludeFromContext },
			},
			meta,
		},
		{
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: (entry.exitCode === 0 && !entry.cancelled ? "completed" : "failed") satisfies AcpToolCallStatus,
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: {
					exitCode: entry.exitCode,
					cancelled: entry.cancelled,
					truncated: entry.truncated,
					excludedFromContext: excludeFromContext,
				},
			},
			meta,
		},
	];
}

/**
 * Build client-visible replay from original active-branch transcript entries.
 * Provider-only synthetic context never enters this projection.
 */
function prepareAcpReplay(
	entries: ReadonlyArray<SessionEntry>,
	leafTurnId: string | null,
	sessionId: string,
): PreparedAcpReplay {
	const branch = filterEntriesToActivePath(entries, leafTurnId ?? undefined);
	const turns: AcpReplayTurn[] = [];
	const ids = createActivePromptState();
	let current: AcpReplayTurn | null = null;
	const runs: Array<{ runId: string; agentId: string }> = [];
	for (const entry of branch) {
		if (entry.kind === "workerRun") {
			runs.push({ runId: entry.runId, agentId: entry.agentId });
			continue;
		}
		if (entry.kind === "compactionSummary") {
			if (current === null) {
				current = { frames: [] };
				turns.push(current);
			}
			const reduction =
				entry.tokensAfter === undefined
					? `${entry.tokensBefore} tokens before`
					: `${entry.tokensBefore} → ${entry.tokensAfter} tokens`;
			for (const chunk of chunkText(`[context engine] compacted ${reduction}\n${entry.summary}`, ACP_MAX_CHUNK_BYTES)) {
				current.frames.push({
					update: { sessionUpdate: "agent_message_chunk", content: textContent(chunk) },
					meta: { [ACP_NOTICE_META_KEY]: { level: "info" } },
				});
			}
			continue;
		}
		if (entry.kind === "bashExecution") {
			// An operator shell line (terminal `!` or `_clio-coder/session/shell`)
			// runs only between turns, so the turn before it has ended.
			if (current === null) {
				current = { frames: [] };
				turns.push(current);
			} else {
				closeUnrecordedReplayCalls(ids, current.frames);
			}
			current.frames.push(...replayShellLine(entry));
			continue;
		}
		if (entry.kind !== "message") continue;
		const payload = payloadRecord(entry.payload);
		if (entry.role === "user") {
			// Middleware continuations are provider context, not operator authorship.
			if (payload?.synthetic === true) continue;
			if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);
			current = { frames: [] };
			turns.push(current);
			const operatorText =
				typeof payload?.operatorText === "string" ? [payload.operatorText] : replayTextBlocks(entry).text;
			replayMessageChunks(current.frames, "user_message_chunk", operatorText);
			continue;
		}
		if (current === null) continue;
		if (entry.role === "assistant") {
			const blocks = replayTextBlocks(entry);
			replayMessageChunks(current.frames, "agent_thought_chunk", blocks.thinking);
			replayMessageChunks(current.frames, "agent_message_chunk", blocks.text);
			continue;
		}
		if (entry.role === "tool_call") {
			const call = replayToolCall(entry);
			const toolCallId = startToolCallId(ids, call.engineId);
			ids.openToolCalls.add(toolCallId);
			ids.lastEmittedToolCallId = toolCallId;
			current.frames.push({
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					name: call.name,
					title: call.name,
					kind: toolKind(call.name),
					status: "in_progress" satisfies AcpToolCallStatus,
					rawInput: boundRawRecord(call.args),
				},
			});
			continue;
		}
		if (entry.role === "tool_result") {
			const engineId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
			const toolCallId = endToolCallId(ids, engineId);
			if (toolCallId === null || ids.terminalToolCalls.has(toolCallId)) continue;
			ids.openToolCalls.delete(toolCallId);
			ids.terminalToolCalls.add(toolCallId);
			const failed = payload?.isError === true || payload?.outcome === "error" || payload?.outcome === "blocked";
			const output = boundString(outputText(payload?.result), ACP_MAX_CHUNK_BYTES);
			const name = safeStoredString(payload?.toolName, 64, "tool") || "tool";
			current.frames.push({
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					title: name,
					kind: toolKind(name),
					status: (failed ? "failed" : "completed") satisfies AcpToolCallStatus,
					...(output.length > 0 ? { content: toolCallContent(output) } : {}),
					rawOutput: boundRawRecord({ result: payload?.result, isError: failed }),
				},
			});
		}
	}
	if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);

	const params = turns.flatMap((turn, index) =>
		turn.frames.map((frame) => ({
			sessionId,
			update: frame.update,
			_meta: { [ACP_REPLAY_META_KEY]: { turn: index + 1 }, ...frame.meta },
		})),
	);
	return { params, runs, turns: turns.length, truncated: false };
}

function sessionResultMeta(
	session: AcpServerSession,
	resumed: boolean,
	replayed?: { turns: number; truncated: boolean },
): AcpSessionResultMeta {
	return {
		sessionId: session.id,
		target: session.target,
		model: session.model,
		autonomy: session.autonomy,
		createdAt: safeIso(session.createdAt),
		resumed,
		...(replayed !== undefined ? { replayed } : {}),
	};
}

const ACP_THINKING_LEVEL_SET = new Set<AcpThinkingLevel>(ACP_THINKING_LEVELS);
// The frozen client reader ceiling is 256 KiB per JSON-RPC line. Reserve
// 16 KiB for the response envelope/request id and keep this result a stable
// prefix of whole targets/model ids.
const ACP_MAX_TARGET_LIST_RESULT_BYTES = 240 * 1024;
const ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES = utf8Bytes(
	JSON.stringify({ targets: [], _meta: { [ACP_TRUNCATED_META_KEY]: true } }),
);
// Session summaries share the same JSON-RPC line ceiling. Keep a
// stable newest-first prefix of whole rows and reserve 16 KiB for the envelope.
const ACP_MAX_SESSION_LIST_RESULT_BYTES = 240 * 1024;

function safeSettingsProjection(snapshot: AcpSafeSettingsSnapshot): AcpSafeSettings {
	const thinkingLevel = ACP_THINKING_LEVEL_SET.has(snapshot.thinkingLevel) ? snapshot.thinkingLevel : "off";
	const autonomy = isAutonomyLevel(snapshot.autonomy) ? snapshot.autonomy : DEFAULT_AUTONOMY_LEVEL;
	return {
		settings: {
			chat: {
				target: safeConfiguredIdentifier(snapshot.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeConfiguredIdentifier(snapshot.model, ACP_MAX_MODEL_ID_BYTES),
				thinkingLevel,
			},
			safety: { autonomy },
		},
		editable: [...ACP_SAFE_SETTINGS_KEYS],
	};
}

function safeTargetModels(status: ReturnType<ProvidersContract["list"]>[number]): string[] {
	const candidates = [status.target.defaultModel, ...(status.target.wireModels ?? []), ...status.discoveredModels];
	const seen = new Set<string>();
	const models: string[] = [];
	for (const candidate of candidates) {
		const id = safeStoredIdentifier(candidate, ACP_MAX_MODEL_ID_BYTES);
		if (id === null || seen.has(id)) continue;
		seen.add(id);
		models.push(id);
		if (models.length === ACP_TARGET_MODEL_LIMIT) break;
	}
	return models;
}

type AcpSafeTargetProjection = AcpTarget;

function safeTargetProjection(status: ReturnType<ProvidersContract["list"]>[number]): AcpSafeTargetProjection | null {
	const id = safeStoredIdentifier(status.target.id, ACP_MAX_TARGET_ID_BYTES);
	const runtime = safeStoredIdentifier(status.target.runtime, 64);
	if (id === null || runtime === null) return null;
	let url: string | null = null;
	if (status.target.url !== undefined) {
		try {
			const endpoint = new URL(status.target.url);
			if (endpoint.protocol === "http:" || endpoint.protocol === "https:") {
				endpoint.username = "";
				endpoint.password = "";
				endpoint.search = "";
				endpoint.hash = "";
				url = safeStoredString(endpoint.toString(), 2048);
			}
		} catch {
			/* Invalid configured endpoints disclose no raw credentials. */
		}
	}
	const models = safeTargetModels(status);
	const allModels = new Set(
		[status.target.defaultModel, ...(status.target.wireModels ?? []), ...status.discoveredModels]
			.map((model) => safeStoredIdentifier(model, ACP_MAX_MODEL_ID_BYTES))
			.filter((model) => model !== null),
	);
	const window = status.capabilities?.contextWindow;
	return {
		id,
		runtime,
		models,
		isOrchestrator: status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime),
		...(status.target.url !== undefined ? { url } : {}),
		...(status.target.defaultModel !== undefined
			? { defaultModel: safeStoredIdentifier(status.target.defaultModel, ACP_MAX_MODEL_ID_BYTES) }
			: {}),
		...(typeof status.available === "boolean" ? { available: status.available } : {}),
		...(status.health?.status !== undefined ? { health: status.health.status } : {}),
		...(status.runtime?.tier !== undefined ? { tier: status.runtime.tier } : {}),
		...(window !== undefined ? { contextWindow: Number.isFinite(window) && window > 0 ? window : null } : {}),
		modelsTruncated: allModels.size > models.length,
	};
}

function safeProbeReason(
	providers: ProvidersContract,
	status: ReturnType<ProvidersContract["list"]>[number],
): "not-configured" | "unreachable" | "unsupported" | null {
	if (status.runtime === null || typeof status.runtime.probe !== "function") return "unsupported";
	try {
		if (status.runtime.auth !== "none" && !providers.auth.statusForTarget(status.target, status.runtime).available) {
			return "not-configured";
		}
	} catch {
		return "not-configured";
	}
	// Degraded is reachable with a default the server does not serve; a client
	// that names its own model can still use the target.
	const reachable = status.health.status === "healthy" || status.health.status === "degraded";
	return status.available && reachable ? null : "unreachable";
}

/** The host side of a forwarded worker ask: the dispatch domain's answer path and the open tool call it binds to. */
interface AcpWorkerAskPort {
	/** True once the client advertised `clio-coder/workerPermissions` at initialize. */
	enabled: () => boolean;
	/** Settles the worker's parked ask. Throws when the run no longer accepts a decision. */
	resolve: (runId: string, requestId: string, decision: "approve" | "deny") => void;
	/** The wire id of the open tool call this run belongs to, else the newest open one, else null. */
	bindToolCall: (runId: string) => string | null;
	/** Tells the client an ask it still holds is no longer waiting. */
	withdraw: (sessionId: string, requestId: string) => void;
}

/** The one client-facing ask in flight, shared by main-agent and worker asks. */
interface AcpPermissionQueue {
	chain: Promise<void>;
	cancel: ((reason: string) => void) | null;
	cancelWorkers: (() => void) | null;
}

/** How often a worker ask retries binding to an open tool call while the model is between calls. */
const ACP_WORKER_ASK_BIND_POLL_MS = 200;
const ACP_MAX_WORKER_ASK_ID_BYTES = 128;

interface AcpWorkerAsk {
	requestId: string;
	runId: string;
	agentId: string;
	tool: string;
	payload: PermissionRequestedPayload;
}

/** A live worker escalation, read the way the terminal's overlay reads it. */
function workerAskOf(payload: PermissionRequestedPayload): AcpWorkerAsk | null {
	if (payload.escalation !== true) return null;
	const origin = typeof payload.origin === "string" ? payload.origin : undefined;
	const legacyWorkerEvent = origin === undefined && typeof payload.requestedBy === "string";
	if (!(origin?.startsWith("worker:") || legacyWorkerEvent)) return null;
	const requestId = safeStoredIdentifier(payload.requestId, ACP_MAX_WORKER_ASK_ID_BYTES);
	const runId = safeStoredIdentifier(
		typeof payload.requestedBy === "string" ? payload.requestedBy : origin?.slice("worker:".length),
		ACP_MAX_WORKER_ASK_ID_BYTES,
	);
	if (requestId === null || runId === null) return null;
	return {
		requestId,
		runId,
		agentId: safeStoredIdentifier(payload.agentId, ACP_MAX_WORKER_ASK_ID_BYTES) ?? "worker",
		tool: safeStoredString(payload.tool, 64, "unknown"),
		payload,
	};
}

function workerAskAxis(
	payload: PermissionRequestedPayload,
): { kind: "safety-net"; ruleId: string } | { kind: "autonomy"; level: string } {
	const axisId = typeof payload.axis === "string" ? payload.axis : undefined;
	if (axisId?.startsWith("net:")) return { kind: "safety-net", ruleId: axisId.slice("net:".length) || "unknown" };
	if (axisId?.startsWith("autonomy:")) {
		return { kind: "autonomy", level: axisId.slice("autonomy:".length) || DEFAULT_AUTONOMY_LEVEL };
	}
	if (typeof payload.ruleId === "string" && payload.ruleId.length > 0) {
		return { kind: "safety-net", ruleId: payload.ruleId };
	}
	return { kind: "autonomy", level: DEFAULT_AUTONOMY_LEVEL };
}

/**
 * Puts a dispatched worker's escalation in front of an attended ACP client as
 * `session/request_permission`, bound to the tool call the run belongs to, and
 * answers the worker with what the person chose. The ask carries the worker's
 * provenance beside the decision facts so a client can say whose request it is
 * and who may discharge it. An ask nobody can be shown (no open tool call
 * before the worker's own deadline) is left to the worker's timeout fallback
 * rather than denied in the operator's name.
 */
function installWorkerAskBridge(
	input: {
		transport: AcpJsonRpcPeerTransport;
		bus?: SafeEventBus;
		toolCallSnapshot: (wireId: string) => AcpToolCallSnapshot | null;
		activeSessionId: () => string | null;
		permissionTimeoutMs: number;
		cancelActivePrompt: (reason: string) => void;
		workerAsks?: AcpWorkerAskPort;
		diagnostics?: (line: string) => void;
	},
	queue: AcpPermissionQueue,
): () => void {
	const workers = input.workerAsks;
	const bus = input.bus;
	if (workers === undefined || bus === undefined) return () => {};
	// Asks still queued or on the client, each with the callback that marks it
	// settled elsewhere (the worker timed out, the run ended, the owner revoked it).
	const waiting = new Map<string, () => void>();
	queue.cancelWorkers = () => {
		for (const settle of waiting.values()) settle();
	};
	const unregisterRequested = bus.on(BusChannels.PermissionRequested, (payload: PermissionRequestedPayload) => {
		if (!workers.enabled()) return;
		const ask = workerAskOf(payload);
		if (ask === null || waiting.has(ask.requestId)) return;
		const owningSessionId = input.activeSessionId();
		if (owningSessionId === null || (payload.sessionId !== undefined && payload.sessionId !== owningSessionId)) return;
		const askWindowMs = Math.min(
			input.permissionTimeoutMs,
			typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
				? payload.timeoutMs
				: input.permissionTimeoutMs,
		);
		const giveUpAt = performance.now() + askWindowMs;
		let settledElsewhere = false;
		let signalSettled: () => void = () => {};
		const settled = new Promise<{ kind: "settled" }>((resolve) => {
			signalSettled = () => resolve({ kind: "settled" });
		});
		waiting.set(ask.requestId, () => {
			settledElsewhere = true;
			signalSettled();
		});
		const answerWorker = (decision: "approve" | "deny"): void => {
			try {
				workers.resolve(ask.runId, ask.requestId, decision);
			} catch (err) {
				// The run ended or the ask expired while the person was deciding; the
				// worker already applied its fallback, so a late answer has no one to reach.
				input.diagnostics?.(
					`worker permission ${ask.requestId} could not be answered: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		};
		const wait = (ms: number): Promise<void> =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				timer.unref?.();
			});
		const run = async (): Promise<void> => {
			try {
				if (settledElsewhere) return;
				let sessionId: string | null = null;
				let toolCallId: string | null = null;
				// The model is often between tool calls when a worker asks, so binding
				// retries until the ask's own window closes instead of failing at once.
				for (;;) {
					sessionId = input.activeSessionId();
					if (sessionId !== owningSessionId) return;
					toolCallId = sessionId === null ? null : workers.bindToolCall(ask.runId);
					if (toolCallId !== null || settledElsewhere || performance.now() >= giveUpAt) break;
					await Promise.race([wait(ACP_WORKER_ASK_BIND_POLL_MS), settled]);
				}
				const snapshot = toolCallId === null ? null : input.toolCallSnapshot(toolCallId);
				if (settledElsewhere || performance.now() >= giveUpAt) return;
				if (sessionId === null || toolCallId === null || snapshot === null) {
					input.diagnostics?.(`worker permission ${ask.requestId} had no open tool call to ask under`);
					return;
				}
				const facts = decisionFactsForPermission({
					tool: ask.tool,
					actionClass: decisionActionClass(payload.actionClass),
					axis: workerAskAxis(payload),
					origin: { kind: "worker", agentId: ask.agentId, runId: ask.runId },
				});
				const presentation = classifyDecisionPresentation(facts);
				const approveAction = presentation.requiredActions.find((action) => action.id === "approve-once");
				const denyAction = presentation.requiredActions.find((action) => action.id === "deny");
				const stopAction = presentation.requiredActions.find((action) => action.id === "stop");
				const consequence = Array.isArray(payload.consequence)
					? payload.consequence.filter((line): line is string => typeof line === "string")
					: [];
				const workerMeta = {
					version: 1,
					requestId: ask.requestId,
					requestedBy: ask.runId,
					agentId: ask.agentId,
					...(payload.approvalAuthority === "main" || payload.approvalAuthority === "operator"
						? { approvalAuthority: payload.approvalAuthority }
						: {}),
					forwardedByMain: payload.forwardedByMain === true,
					fallback: payload.fallback === "fail" ? "fail" : "deny",
					...(typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
						? { timeoutMs: Math.max(0, Math.floor(payload.timeoutMs)) }
						: {}),
				};
				const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolveCancelled) => {
					queue.cancel = (reason: string) => resolveCancelled({ kind: "cancelled", reason });
				});
				const answered = Promise.resolve()
					.then(() =>
						input.transport.request<AcpRequestPermissionResponse>(
							"session/request_permission",
							{
								sessionId,
								toolCall: {
									toolCallId,
									title: snapshot.title,
									kind: snapshot.kind,
									status: "in_progress",
									rawInput: snapshot.rawInput,
									...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
								},
								options: [
									{ optionId: "allow-once", name: approveAction?.label ?? "Approve once", kind: "allow_once" },
									{ optionId: "reject-once", name: denyAction?.label ?? "Deny this request", kind: "reject_once" },
									{ optionId: "reject-and-stop", name: stopAction?.label ?? "Deny and stop", kind: "reject_once" },
								],
								_meta: {
									...decisionMeta(facts, presentation, typeof payload.target === "string" ? payload.target : "", consequence),
									[ACP_WORKER_ASK_META_KEY]: workerMeta,
								},
							},
							Math.max(1, giveUpAt - performance.now()),
						),
					)
					.then(
						(response) => ({ kind: "response" as const, response }),
						(err: unknown) => ({ kind: "failed" as const, err }),
					);
				try {
					const outcome = await Promise.race([answered, cancelled, settled]);
					if (outcome.kind === "settled") {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (outcome.kind === "cancelled") {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (outcome.kind === "failed") {
						workers.withdraw(sessionId, ask.requestId);
						input.diagnostics?.(
							`worker permission ${ask.requestId} failed: ${outcome.err instanceof Error ? outcome.err.message : String(outcome.err)}`,
						);
						return;
					}
					if (settledElsewhere || performance.now() >= giveUpAt) {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					const response: unknown = outcome.response;
					const answer = isRecord(response) && isRecord(response.outcome) ? response.outcome : null;
					if (
						answer === null ||
						answer.outcome !== "selected" ||
						typeof answer.optionId !== "string" ||
						!["allow-once", "reject-once", "reject-and-stop"].includes(answer.optionId)
					) {
						workers.withdraw(sessionId, ask.requestId);
						return;
					}
					if (answer.outcome === "selected" && answer.optionId === "allow-once") {
						answerWorker("approve");
						return;
					}
					answerWorker("deny");
					// The terminal's Deny and stop: the worker is denied first, then the
					// main turn the person asked to stop being asked in is cancelled.
					if (answer.outcome === "selected" && answer.optionId === "reject-and-stop") {
						input.cancelActivePrompt("ACP client denied a worker request and stopped the run");
					}
				} finally {
					queue.cancel = null;
				}
			} finally {
				waiting.delete(ask.requestId);
			}
		};
		queue.chain = queue.chain.then(run, run);
	});
	// Any resolution of an ask this bridge has not answered itself means the
	// person's card is stale: the worker timed out, the run ended, or the owner revoked it.
	const unregisterResolved = bus.on(BusChannels.PermissionResolved, (payload) => {
		if (typeof payload.requestId === "string") waiting.get(payload.requestId)?.();
	});
	return () => {
		queue.cancelWorkers?.();
		unregisterRequested();
		unregisterResolved();
	};
}

interface AcpPermissionBridge {
	unregister(): void;
	/** Settles the outstanding permission request, if any, as cancellation. */
	cancelPending(reason: string): void;
}

/**
 * The closed set of option ids a `session/request_permission` from this server
 * offers, announced at initialize. Exactly one grants; the other two deny and
 * differ only in what happens to the rest of the turn. A client that returns
 * anything outside this list is denied, so minting `allow-always` cannot buy a
 * grant this server never offered.
 */
const ACP_PERMISSION_OPTION_IDS = ["allow-once", "reject-once", "reject-and-stop"] as const;

/** Bound for one line of decision copy. The longest of them is well under this. */
const ACP_MAX_DECISION_COPY_BYTES = 512;

function decisionCopy(value: string): string {
	return boundString(sanitizeCallTargetText(value), ACP_MAX_DECISION_COPY_BYTES);
}

/**
 * The classification the server already performed to label the two options,
 * attached to the ask instead of discarded. Everything here is host-derived:
 * the copy is generated from enforced policy facts, and the one caller-shaped
 * value, the call target, is rendered from the tool's own field allowlist and
 * sanitized before it is bounded. No model-authored prose reaches this record,
 * which is what lets a client render it as an authority statement rather than
 * as tool output.
 */
function decisionMeta(
	facts: TrustedDecisionFacts,
	presentation: DecisionPresentation,
	callTarget: string,
	consequence: ReadonlyArray<string>,
): Record<string, unknown> {
	const axis =
		facts.axis.kind === "safety-net"
			? { kind: facts.axis.kind, ruleId: decisionCopy(facts.axis.ruleId) }
			: facts.axis.kind === "autonomy"
				? { kind: facts.axis.kind, level: decisionCopy(facts.axis.level) }
				: { kind: facts.axis.kind };
	const origin =
		facts.origin.kind === "worker"
			? {
					kind: facts.origin.kind,
					agentId: decisionCopy(facts.origin.agentId),
					runId: decisionCopy(facts.origin.runId),
				}
			: { kind: facts.origin.kind };
	const target = decisionCopy(callTarget);
	// What a bash command would do, one sentence per step. The sentences are
	// written by the host from the full command, so a client renders them beside
	// the generic consequence copy instead of re-deriving them from `target`,
	// which is flattened to one line and cut.
	const consequenceLines = consequence
		.slice(0, COMMAND_CONSEQUENCE_MAX_SEVERE + 1)
		.map(decisionCopy)
		.filter((line) => line.length > 0);
	return {
		[ACP_DECISION_META_KEY]: {
			version: 1,
			tier: presentation.tier,
			tierLabel: decisionCopy(presentation.tierLabel),
			title: decisionCopy(presentation.title),
			semanticToken: presentation.semanticToken,
			authorizationCopy: decisionCopy(presentation.authorizationCopy),
			consequenceCopy: decisionCopy(presentation.consequenceCopy),
			reversibilityCopy: decisionCopy(presentation.reversibilityCopy),
			requestedByCopy: decisionCopy(presentation.requestedByCopy),
			actionClass: facts.actionClass ?? "unknown",
			axis,
			origin,
			exposure: facts.exposure,
			affectedScope: facts.affectedScope,
			reversibility: facts.reversibility,
			...(target.length > 0 ? { target } : {}),
			...(consequenceLines.length > 0 ? { consequenceLines } : {}),
		},
	};
}

function installPermissionBridge(input: {
	transport: AcpJsonRpcPeerTransport;
	toolRegistry: ToolRegistry | undefined;
	bus?: SafeEventBus;
	activeSessionId: () => string | null;
	/**
	 * The wire id of the engine id's most recently opened tool call, or null when
	 * it names no call the client currently has open. Lookup only: this never
	 * mints a wire id, so an engine id nothing was emitted for fails closed.
	 */
	resolveToolCallId: (engineToolCallId: string) => string | null;
	/** The wire id of the turn's one open tool call, or null when it is not exactly one. */
	soleOpenToolCallId: () => string | null;
	/**
	 * What this wire id's `tool_call` update put on the wire, or null when this
	 * turn emitted no such call. The ask repeats it verbatim; nothing here is
	 * rebuilt from the registry's arguments.
	 */
	toolCallSnapshot: (wireId: string) => AcpToolCallSnapshot | null;
	permissionTimeoutMs: number;
	expireActivePrompt: () => void;
	cancelActivePrompt: (reason: string) => void;
	/** Forwarded worker asks; absent leaves them to the worker's own timeout fallback. */
	workerAsks?: AcpWorkerAskPort;
	diagnostics?: (line: string) => void;
}): AcpPermissionBridge {
	// One client-facing ask at a time: a main-agent ask and a forwarded worker ask
	// share this queue because the client holds a single pending permission.
	const queue: AcpPermissionQueue = { chain: Promise.resolve(), cancel: null, cancelWorkers: null };
	const unregisterWorkerAsks = installWorkerAskBridge(input, queue);
	if (!input.toolRegistry) {
		return {
			unregister: unregisterWorkerAsks,
			cancelPending: (reason) => {
				queue.cancelWorkers?.();
				queue.cancel?.(reason);
			},
		};
	}
	const queuedRequestIds = new Set<string>();
	const queuedRequestDetails = new Map<string, { tool: string; actionClass: string }>();
	const unregister = input.toolRegistry.onPermissionRequired((call, decision, meta) => {
		if (queuedRequestIds.has(meta.requestId)) return;
		// The facts are kept, not just the presentation built from them. The ask
		// used to throw away everything but two label strings, leaving a client to
		// re-derive the tier and the consequence from a tool name it cannot
		// classify.
		const facts = decisionFactsForPermission({
			tool: call.tool,
			actionClass: decision.classification.actionClass,
			axis: meta.axis.startsWith("net:")
				? { kind: "safety-net", ruleId: meta.axis.slice("net:".length) || "unknown" }
				: { kind: "autonomy", level: meta.axis.slice("autonomy:".length) || DEFAULT_AUTONOMY_LEVEL },
			origin: { kind: "main" },
			...(call.tool === ToolNames.AskUser ? { exposure: askUserExposure(call.args) } : {}),
		});
		const presentation = classifyDecisionPresentation(facts);
		const approveAction = presentation.requiredActions.find((action) => action.id === "approve-once");
		const denyAction = presentation.requiredActions.find((action) => action.id === "deny");
		const stopAction = presentation.requiredActions.find((action) => action.id === "stop");
		queuedRequestIds.add(meta.requestId);
		queuedRequestDetails.set(meta.requestId, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
		});
		const resolve = (
			payload: { status: "granted" | "denied" | "expired"; decidedBy: string; reason?: string },
			action: "grant" | "deny" | "stop" | "expire" = "deny",
			beforeRelease?: () => void,
			reason?: string,
		) =>
			resolvePermission(
				{ ...(input.bus ? { bus: input.bus } : {}), ...(input.toolRegistry ? { registry: input.toolRegistry } : {}) },
				{
					action,
					payload: {
						...payload,
						requestId: meta.requestId,
						origin: "acp-server",
						tool: call.tool,
						actionClass: decision.classification.actionClass,
					},
					...(action === "grant" ? { grantRequestedBy: "acp-client" } : {}),
					...(beforeRelease ? { beforeRelease } : {}),
					...(reason !== undefined ? { reason } : {}),
				},
			);
		const emitQueuedErrorResolutions = (currentRequestId: string, reason: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				input.bus?.emit(BusChannels.PermissionResolved, {
					status: "denied",
					requestId,
					origin: "acp-server",
					decidedBy: "error",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason,
				});
			}
		};
		const emitQueuedExpiryResolutions = (currentRequestId: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				input.bus?.emit(BusChannels.PermissionResolved, {
					status: "expired",
					requestId,
					origin: "acp-server",
					decidedBy: "timeout",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason: "permission approval expired",
				});
			}
		};
		const run = async (): Promise<void> => {
			if (!queuedRequestIds.has(meta.requestId)) return;
			const sessionId = input.activeSessionId();
			const noSessionReason = "ACP permission requested with no active session";
			if (!sessionId) {
				resolve({ status: "denied", decidedBy: "error", reason: noSessionReason }, "stop", () => {
					emitQueuedErrorResolutions(meta.requestId, noSessionReason);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
				});
				return;
			}
			// The client already rendered a tool_call under the engine's id; asking
			// about a different id would present the operator with a call they
			// cannot see. So the engine's id is resolved by lookup and nothing
			// else: an id no tool_call was emitted for, or one whose call the
			// client has already seen finish, binds to nothing. When the bridge
			// gets no engine id, the turn's one open call is the only binding that
			// can be right. Everything else fails closed: a bridge-local id nothing
			// on the client matches asked the operator to approve a call they had
			// no way to identify.
			const toolCallId =
				meta.toolCallId !== undefined && meta.toolCallId.length > 0
					? input.resolveToolCallId(meta.toolCallId)
					: input.soleOpenToolCallId();
			// The operator is being shown a call the client already rendered, so the
			// arguments in the ask are that frame's own: a tool's admission normalizer
			// can rewrite a relative path to an absolute one or attach a prepared
			// artifact, and rebuilding the record from the registry's copy produced a
			// `rawInput` the client could not match to anything it had drawn. A bound
			// id always has a snapshot, since every open call stored one when it was
			// emitted; the missing case fails closed anyway.
			const snapshot = toolCallId === null ? null : input.toolCallSnapshot(toolCallId);
			if (toolCallId === null || snapshot === null) {
				const unbindableReason = "permission request has no bindable tool call";
				resolve({ status: "denied", decidedBy: "error", reason: unbindableReason });
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
				return;
			}
			// The transport has no per-request abort, so a cancelled prompt races
			// the outstanding request against a local deferral. The client's late
			// answer resolves a promise nothing is waiting on any more.
			const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolveCancelled) => {
				queue.cancel = (reason: string) => resolveCancelled({ kind: "cancelled", reason });
			});
			try {
				const answered = Promise.resolve()
					.then(() =>
						input.transport.request<AcpRequestPermissionResponse>(
							"session/request_permission",
							{
								sessionId,
								toolCall: {
									toolCallId,
									title: boundString(call.tool, ACP_MAX_TOOL_TITLE_BYTES),
									kind: toolKind(call.tool),
									status: "pending",
									rawInput: snapshot.rawInput,
									...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
								},
								options: [
									{
										optionId: "allow-once",
										name: approveAction?.label ?? "Approve once",
										kind: "allow_once",
									},
									{
										optionId: "reject-once",
										name: denyAction?.label ?? "Deny this request",
										kind: "reject_once",
									},
									// The TUI's third action, which the wire had no
									// equivalent for. It is `reject_once` and not
									// `reject_always`: it grants no standing denial, it
									// ends this run. A client that renders only the spec
									// kinds shows it as a second deny, which is a true
									// reading of what it does.
									{
										optionId: "reject-and-stop",
										name: stopAction?.label ?? "Deny and stop",
										kind: "reject_once",
									},
								],
								_meta: {
									...decisionMeta(
										facts,
										presentation,
										describeCallTarget(call.tool, call.args),
										describeMainCallConsequences(call),
									),
									// The plan admission rendered, whose hash a plan-scale run seals.
									...(meta.dispatchPlan !== undefined
										? { [ACP_DISPATCH_PLAN_META_KEY]: projectDispatchPlanMeta(meta.dispatchPlan) }
										: {}),
								},
							},
							input.permissionTimeoutMs,
						),
					)
					.then(
						(response) => ({ kind: "response" as const, response }),
						(err: unknown) => ({ kind: "failed" as const, err }),
					);
				const outcome = await Promise.race([answered, cancelled]);
				if (outcome.kind === "cancelled") {
					resolve({ status: "denied", decidedBy: "cancelled", reason: outcome.reason });
					return;
				}
				if (outcome.kind === "response") {
					// Exactly one option grants. `startsWith("allow")` would let a
					// client mint `allow-always` and get a grant this server never
					// offered as an option.
					const answer = outcome.response.outcome;
					if (answer.outcome === "cancelled") {
						const reason = "ACP client cancelled permission";
						// Abort before releasing the parked tools so their results cannot
						// start another model request while session/cancel is in flight.
						input.cancelActivePrompt(reason);
						resolve({ status: "denied", decidedBy: "cancelled", reason }, "stop", () => {
							queuedRequestIds.clear();
							queuedRequestDetails.clear();
						});
						return;
					}
					// Deny-and-stop is the TUI's `s` action on the wire: it denies
					// every parked request from this turn and ends the run, not just
					// the one the operator is looking at. It orders like the client
					// cancellation above rather than like a plain denial, because a
					// parked call released before the prompt aborts can start another
					// model request while the abort is in flight.
					if (answer.outcome === "selected" && answer.optionId === "reject-and-stop") {
						const reason = "ACP client denied this tool call and stopped the run";
						input.cancelActivePrompt(reason);
						resolve({ status: "denied", decidedBy: "acp-client", reason }, "stop", () => {
							queuedRequestIds.clear();
							queuedRequestDetails.clear();
						});
						return;
					}
					if (answer.outcome === "selected" && answer.optionId === "allow-once") {
						await resolve({ status: "granted", decidedBy: "acp-client" }, "grant");
						return;
					}
					resolve({ status: "denied", decidedBy: "acp-client", reason: "ACP client denied this tool call" });
					return;
				}
				const err = outcome.err;
				const message = `ACP permission request failed: ${err instanceof Error ? err.message : String(err)}`;
				if (err instanceof AcpTimeoutError) {
					resolve({ status: "expired", decidedBy: "timeout", reason: "permission approval expired" }, "expire", () => {
						emitQueuedExpiryResolutions(meta.requestId);
						queuedRequestIds.clear();
						queuedRequestDetails.clear();
						input.expireActivePrompt();
					});
					return;
				}
				resolve({ status: "denied", decidedBy: "error", reason: message }, "stop", () => {
					emitQueuedErrorResolutions(meta.requestId, message);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
				});
			} finally {
				queue.cancel = null;
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
			}
		};
		queue.chain = queue.chain.then(run, run);
	});
	return {
		unregister: () => {
			unregister();
			unregisterWorkerAsks();
		},
		cancelPending: (reason: string) => {
			queue.cancelWorkers?.();
			queue.cancel?.(reason);
		},
	};
}

/** How long transport close waits for an in-flight prompt handler to settle. */
const ACP_PROMPT_SETTLE_BOUND_MS = 5000;

/**
 * Where a steer lands. `interrupt` is deliberately not admitted here: the
 * engine's interrupt mode cancels the run and resubmits the text as a fresh
 * prompt, and ACP binds a turn to the `session/prompt` request/response pair,
 * so that second turn would have no request to carry its stop reason. A client
 * that wants it cancels through `_clio-coder/session/interrupt` and prompts again.
 */
const ACP_STEERING_MODES = ["next-slot", "end-of-turn"] as const;
type AcpSteeringMode = (typeof ACP_STEERING_MODES)[number];

/** Model-facing steer prose. Wider than a label, far under the transport's line bound. */
const ACP_MAX_STEER_TEXT_BYTES = 16 * 1024;
/** Host-authored context a client may attach to an interrupt, echoed into the cancel reason. */
const ACP_MAX_INTERRUPT_REASON_BYTES = 256;
/** Queue entries read back in one response; a deeper queue is reported truncated. */
const ACP_MAX_QUEUED_MESSAGES = 64;

/**
 * Steer text is model-facing prose, not an identifier, so newlines and tabs are
 * content and are admitted where {@link requireBoundedClientString} would refuse
 * the whole message. The remaining C0 controls are still refused rather than
 * stripped: a steer the model saw shortened or rewritten would disagree with the
 * text the client sent and with the copy its own UI is showing.
 */
function requireSteerText(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AcpRequestError(-32602, `${name} is required`, { code: "invalid_params" });
	}
	if (utf8Bytes(value) > maxBytes || hasControlCharacters(value.replace(/[\n\r\t]/g, " "))) {
		throw new AcpRequestError(-32602, `${name} is invalid`, { code: "invalid_params" });
	}
	return value;
}

/** Bounded read-back of one engine queue, in enqueue order. */
function boundedQueueTexts(texts: ReadonlyArray<string>): string[] {
	return texts.slice(0, ACP_MAX_QUEUED_MESSAGES).map((text) => boundString(text, ACP_MAX_STEER_TEXT_BYTES));
}

/** The queue navigator's per-entry keys: x, e, Shift+Up/Down, t and Enter. */
const ACP_QUEUE_EDIT_OPS = ["remove", "restore", "move", "set_kind", "send_now"] as const;
type AcpQueueEditOp = (typeof ACP_QUEUE_EDIT_OPS)[number];
/** Entry ids are minted by the chat loop (`steer_<8 hex>_<n>`); anything wider is not one. */
const ACP_MAX_QUEUE_ENTRY_ID_BYTES = 128;

type AcpQueueEntryProjection = AcpQueueEntry;

/** The queue in delivery order, each entry as the client addresses it. */
function projectQueueEntries(entries: ReadonlyArray<AcpQueuedEntry>): AcpQueueEntryProjection[] {
	return entries.slice(0, ACP_MAX_QUEUED_MESSAGES).map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		text: boundString(entry.text, ACP_MAX_STEER_TEXT_BYTES),
		enqueuedAt: entry.enqueuedAt,
		pinned: entry.pinned === true,
	}));
}

/** One editor line's worth of command; the terminal admits no newline in it either. */
const ACP_MAX_SHELL_COMMAND_BYTES = 16 * 1024;
/** A shell line's output on the wire is its tail; the whole output is in the session entry. */
const ACP_MAX_SHELL_OUTPUT_BYTES = ACP_MAX_CHUNK_BYTES;
const ACP_SHELL_TRUNCATION_PREFIX = "[truncated]…";

/**
 * A shell line is the terminal's `!` operator: one line, run as typed. A
 * newline would make it a script, which the terminal editor never admits, and
 * the other C0 controls are refused rather than stripped so the command that
 * runs is the command the client shows.
 */
function requireShellCommand(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AcpRequestError(-32602, "command is required", { code: "invalid_params" });
	}
	if (
		utf8Bytes(value) > ACP_MAX_SHELL_COMMAND_BYTES ||
		/[\n\r]/u.test(value) ||
		hasControlCharacters(value.replace(/\t/g, " "))
	) {
		throw new AcpRequestError(-32602, "command is invalid", { code: "invalid_params" });
	}
	return value.trim();
}

/** The last {@link ACP_MAX_SHELL_OUTPUT_BYTES} of a shell line's output, marked at the front when cut. */
function shellOutputTail(output: string): string {
	if (utf8Bytes(output) <= ACP_MAX_SHELL_OUTPUT_BYTES) return output;
	const budget = ACP_MAX_SHELL_OUTPUT_BYTES - utf8Bytes(ACP_SHELL_TRUNCATION_PREFIX);
	const bytes = Buffer.from(output, "utf8");
	let start = bytes.length - budget;
	// Step forward off UTF-8 continuation bytes so no code point is split.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return `${ACP_SHELL_TRUNCATION_PREFIX}${bytes.subarray(start).toString("utf8")}`;
}

/**
 * Refusal codes for `_clio-coder/dispatch/steer`. `DispatchContract.steer` reports
 * every refusal as an operator-facing Error, so the wire gets the classification
 * and the prose goes to the stderr tail: the message legitimately quotes a
 * runtime id and a worker path, and neither belongs in a client's UI.
 */
function dispatchSteerReason(message: string): string {
	if (message.includes("empty message")) return "empty-message";
	if (message.includes("does not support live steering")) return "steering-unsupported";
	if (message.includes("has no input channel")) return "no-input-channel";
	if (message.includes("no longer accepts input")) return "input-closed";
	if (message.includes("cannot be steered")) return "run-terminating";
	if (message.includes("is not active")) return "run-not-active";
	return "steer-failed";
}

export interface AcpHandshakeFeatures {
	version?: string;
	session: boolean;
	loadSession: boolean;
	settings: boolean;
	providers: boolean;
	commandsCapability?: AcpCommandsCapability & { count?: number; promptTurns?: boolean };
	steer: boolean;
	dispatch: boolean;
	toolRegistry: boolean;
	bus: boolean;
	/** Whether `_clio-coder/session/board` answers; absent reads as false. */
	board?: boolean;
	/** Whether the board's supersede and memory-propose methods answer; absent reads as false. */
	boardActions?: boolean;
	/** Whether the session tree, branch switch and fork methods answer; absent reads as false. */
	branches?: boolean;
	/** Whether the handoff prepare, commit and cancel methods answer; absent reads as false. */
	handoff?: boolean;
	/** Whether the fleet preview and run methods answer; absent reads as false. */
	fleet?: boolean;
	/** Whether `_clio-coder/context/ledger` answers; absent reads as false. */
	contextLedger?: boolean;
	/** Whether `_clio-coder/artifacts/list` and `/read` answer; absent reads as false. */
	artifacts?: boolean;
	/** Whether the extension list and reload methods answer; absent reads as false. */
	extensions?: boolean;
	/** Whether `_clio-coder/library/reload` answers; absent reads as false. */
	libraryReload?: boolean;
	/** Whether the side-question and draft methods answer; absent reads as false. */
	aside?: boolean;
	/** Whether `_clio-coder/usage/read` answers; absent reads as false. */
	usage?: boolean;
	/** Whether session responses and `session_info_update` carry the workspace view; absent reads as false. */
	workspace?: boolean;
	/** Whether prompts are expanded, which is what admits image blocks; absent reads as false. */
	images?: boolean;
	/** Whether the host can ask `ask_user` rounds over `_clio-coder/interview/request`; absent reads as false. */
	interviews?: boolean;
	/** Whether the host can forward worker permission asks over `session/request_permission`; absent reads as false. */
	workerPermissions?: boolean;
	/** Whether `_clio-coder/session/shell` runs operator shell lines; absent reads as false. */
	shell?: boolean;
	/** Whether `_clio-coder/session/queue_edit` acts on one queued entry; absent reads as false. */
	queueEdit?: boolean;
}

/** ACP stdio declarations are client authority for one session, never saved settings. */
function parseClientMcpServers(value: unknown, required: boolean): McpClientServerSpec[] {
	if (value === undefined && !required) return [];
	if (!Array.isArray(value) || value.length > 32) {
		throw new AcpRequestError(-32602, "mcpServers must be an array of at most 32 stdio servers", {
			code: "invalid_params",
		});
	}
	return value.map((raw: unknown) => {
		if (
			!isRecord(raw) ||
			(raw.type !== undefined && raw.type !== "stdio") ||
			typeof raw.name !== "string" ||
			raw.name.trim().length === 0 ||
			Buffer.byteLength(raw.name) > 128 ||
			typeof raw.command !== "string" ||
			!isAbsolute(raw.command) ||
			Buffer.byteLength(raw.command) > 512 ||
			!Array.isArray(raw.args) ||
			raw.args.length > 64 ||
			!raw.args.every((arg: unknown) => typeof arg === "string" && Buffer.byteLength(arg) <= 4096) ||
			!Array.isArray(raw.env) ||
			raw.env.length > 64
		) {
			throw new AcpRequestError(-32602, "invalid stdio MCP server declaration", { code: "invalid_params" });
		}
		const env: Record<string, string> = {};
		for (const entry of raw.env) {
			if (
				!isRecord(entry) ||
				typeof entry.name !== "string" ||
				!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ||
				typeof entry.value !== "string" ||
				Buffer.byteLength(entry.value) > 4096
			) {
				throw new AcpRequestError(-32602, "invalid stdio MCP server environment", { code: "invalid_params" });
			}
			env[entry.name] = entry.value;
		}
		return { name: raw.name, command: raw.command, args: raw.args as string[], env };
	});
}

function assertNoAdditionalDirectories(value: unknown): void {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
	throw new AcpRequestError(-32602, "additionalDirectories are not supported by this host", { code: "invalid_params" });
}

export interface AcpHandshake {
	readonly initialized: boolean;
	readonly loggedOut: boolean;
	readonly enabledEventKinds: ReadonlySet<AcpForwardableEventKind>;
	readonly toolProgressEnabled: boolean;
	/** The client advertised `clio-coder/interviews` and this host can ask over it. */
	readonly interviewsEnabled: boolean;
	/** The client advertised `clio-coder/workerPermissions`: a person answers forwarded worker asks. */
	readonly workerPermissionsEnabled: boolean;
	/** The client advertised `clio-coder/queue` and is sent `_clio-coder/session/queue_changed`. */
	readonly queueEventsEnabled: boolean;
	readonly workspaceInstanceId: string;
	initialize(params: unknown): AcpInitializeResponse;
	authenticate(params: unknown): never;
	logout(params: unknown): Record<string, never>;
}

/** The front and the bound server use one handshake and one capability projection. */
export function createAcpHandshake(features: AcpHandshakeFeatures): AcpHandshake {
	let initialized = false;
	let loggedOut = false;
	let toolProgressEnabled = false;
	let interviewsEnabled = false;
	let workerPermissionsEnabled = false;
	let queueEventsEnabled = false;
	const enabledEventKinds = new Set<AcpForwardableEventKind>();
	const workspaceInstanceId = randomUUID();
	const requireInitialized = (): void => {
		if (!initialized) throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
	};
	const assertHandshakeParams = (params: unknown, keys: ReadonlySet<string>): Record<string, unknown> => {
		if (params === undefined) return {};
		if (!isRecord(params) || Object.keys(params).some((key) => key !== "_meta" && !keys.has(key))) {
			throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
		}
		return params;
	};
	return {
		get initialized() {
			return initialized;
		},
		get loggedOut() {
			return loggedOut;
		},
		get enabledEventKinds() {
			return enabledEventKinds;
		},
		get toolProgressEnabled() {
			return toolProgressEnabled;
		},
		get interviewsEnabled() {
			return interviewsEnabled;
		},
		get workerPermissionsEnabled() {
			return workerPermissionsEnabled;
		},
		get queueEventsEnabled() {
			return queueEventsEnabled;
		},
		workspaceInstanceId,
		initialize(params) {
			if (initialized) throw new AcpRequestError(-32600, "already initialized", { code: "already_initialized" });
			const clientCapabilities =
				isRecord(params) && isRecord(params.clientCapabilities) ? params.clientCapabilities : null;
			const clientMeta =
				clientCapabilities !== null && isRecord(clientCapabilities._meta) ? clientCapabilities._meta : null;
			const eventRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_EVENTS_META_KEY]) ? clientMeta[ACP_EVENTS_META_KEY] : null;
			const requestedEventKinds = eventRequest !== null ? eventRequest.kinds : null;
			// A malformed request refuses the whole opt-in rather than the offending
			// entry: a client that sent an unrepresentable kind does not know what it
			// asked for, and silently honouring the rest of its list hides that.
			enabledEventKinds.clear();
			if (
				eventRequest !== null &&
				eventRequest.version === 1 &&
				Array.isArray(requestedEventKinds) &&
				requestedEventKinds.length <= ACP_MAX_REQUESTED_EVENT_KINDS &&
				requestedEventKinds.every(
					(kind) => typeof kind === "string" && utf8Bytes(kind) <= 64 && !hasControlCharacters(kind),
				)
			) {
				for (const kind of ACP_FORWARDABLE_EVENT_KINDS) {
					if (requestedEventKinds.includes(kind)) enabledEventKinds.add(kind);
				}
			}
			// Repeated in-progress frames for one call are only useful to a client
			// that collapses them onto the row it already drew. One that appends
			// every frame it receives would grow a tool segment by a full output
			// snapshot several times a second, so nothing streams until it asks.
			const toolProgressRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_TOOL_PROGRESS_META_KEY])
					? clientMeta[ACP_TOOL_PROGRESS_META_KEY]
					: null;
			toolProgressEnabled = toolProgressRequest !== null && toolProgressRequest.version === 1;
			// One switch for "a person is here": the client names the request method it
			// will answer, so a client that advertises an older or different shape is
			// treated as unattended instead of being sent a call it cannot read.
			const interviewRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_INTERVIEWS_META_KEY]) ? clientMeta[ACP_INTERVIEWS_META_KEY] : null;
			interviewsEnabled =
				features.interviews === true &&
				interviewRequest !== null &&
				interviewRequest.version === 1 &&
				interviewRequest.request === ACP_INTERVIEW_REQUEST_METHOD;
			const workerPermissionsRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_WORKER_PERMISSIONS_META_KEY])
					? clientMeta[ACP_WORKER_PERMISSIONS_META_KEY]
					: null;
			workerPermissionsEnabled =
				features.workerPermissions === true &&
				workerPermissionsRequest !== null &&
				workerPermissionsRequest.version === 1 &&
				workerPermissionsRequest.withdraw === ACP_PERMISSION_WITHDRAW_METHOD;
			// A queue snapshot on every enqueue, hand-over and edit is only worth
			// sending to a client that replaces its list with it instead of polling.
			const queueRequest =
				clientMeta !== null && isRecord(clientMeta[ACP_QUEUE_META_KEY]) ? clientMeta[ACP_QUEUE_META_KEY] : null;
			queueEventsEnabled = features.queueEdit === true && queueRequest !== null && queueRequest.version === 1;
			const canLoadSession = features.loadSession;
			initialized = true;
			return {
				protocolVersion: 1,
				agentInfo: {
					name: "clio-coder",
					title: "Clio Coder",
					...(features.version !== undefined ? { version: features.version } : {}),
				},
				agentCapabilities: {
					loadSession: canLoadSession,
					promptCapabilities: { audio: false, embeddedContext: true, image: features.images === true },
					mcpCapabilities: { http: false, sse: false },
					sessionCapabilities: {
						close: {},
						...(features.session ? { list: {}, delete: {} } : {}),
						...(canLoadSession ? { resume: {} } : {}),
					},
					auth: { logout: {} },
					// Clio mediates every tool through its own safety policy. Extensions
					// are advertised through _meta while stable capabilities use schema fields.
					_meta: checkAcpAgentCapabilitiesMeta({
						[ACP_SESSION_META_KEY]: {
							close: true,
							label: features.session,
						},
						[ACP_SETTINGS_META_KEY]: {
							get_safe: features.settings,
							patch_safe: features.settings,
						},
						[ACP_TARGETS_META_KEY]: {
							list: features.providers,
							probe: features.providers,
						},
						[ACP_TRUST_META_KEY]: ACP_TRUST_CAPABILITY,
						...(features.commandsCapability !== undefined
							? {
									[ACP_COMMANDS_META_KEY]: {
										version: features.commandsCapability.version,
										list: features.commandsCapability.list,
										invoke: features.commandsCapability.invoke,
										...(features.commandsCapability.promptTurns !== undefined
											? { promptTurns: features.commandsCapability.promptTurns }
											: {}),
									},
								}
							: {}),
						// Steering is announced, never negotiated: every method here is
						// namespaced and additive, so a client that ignores this block
						// keeps the exact v1 surface it had. `main` and `dispatch` report
						// which queues this build actually wired, because an embedder may
						// pass a chat that cannot steer and a server with no fleet.
						[ACP_STEERING_META_KEY]: {
							version: 1,
							main: features.steer,
							dispatch: features.dispatch,
							modes: ACP_STEERING_MODES,
							interrupt: true,
							methods: {
								steer: ACP_SESSION_STEER_METHOD,
								queue: ACP_SESSION_QUEUE_METHOD,
								clear: ACP_SESSION_QUEUE_CLEAR_METHOD,
								interrupt: ACP_SESSION_INTERRUPT_METHOD,
								dispatch: ACP_DISPATCH_STEER_METHOD,
							},
						},
						// Per-frame agent attribution on `session/update`. Announced so a
						// client can tell "this agent produced nothing" apart from "this
						// peer does not report identity at all".
						[ACP_AGENT_META_KEY]: { version: 1, meta: ACP_AGENT_META_KEY },
						// The bounds are announced, not just applied: a client sizing a
						// progress buffer needs to know where the stream stops, and a
						// client that never receives a second frame has to be able to
						// tell "the tool printed once" from "the floor suppressed it".
						[ACP_TOOL_PROGRESS_META_KEY]: {
							version: 1,
							minIntervalMs: ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
							maxFramesPerCall: ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
							maxContentBytes: ACP_MAX_CHUNK_BYTES,
						},
						...(features.toolRegistry
							? {
									[ACP_DECISION_META_KEY]: {
										version: 1,
										meta: ACP_DECISION_META_KEY,
										options: ACP_PERMISSION_OPTION_IDS,
									},
								}
							: {}),
						...(features.bus
							? {
									[ACP_EVENTS_META_KEY]: {
										version: 1,
										notification: ACP_EVENT_NOTIFICATION,
										kinds: ACP_FORWARDABLE_EVENT_KINDS,
										workspaceInstanceId,
									},
								}
							: {}),
						...(features.toolRegistry ? { [ACP_TOOLS_META_KEY]: "mediated" } : {}),
						...(features.board
							? {
									[ACP_BOARD_META_KEY]: {
										version: 1,
										method: ACP_BOARD_METHOD,
										...(features.boardActions
											? { supersede: ACP_DECISION_SUPERSEDE_METHOD, proposeMemory: ACP_MEMORY_PROPOSE_METHOD }
											: {}),
									},
								}
							: {}),
						...(features.branches
							? {
									[ACP_BRANCHES_META_KEY]: {
										version: 1,
										tree: ACP_SESSION_TREE_METHOD,
										switchTurn: ACP_SESSION_SWITCH_TURN_METHOD,
										fork: ACP_SESSION_FORK_METHOD,
									},
								}
							: {}),
						...(features.extensions
							? {
									[ACP_EXTENSIONS_META_KEY]: {
										version: 1,
										list: ACP_EXTENSIONS_LIST_METHOD,
										reload: ACP_EXTENSIONS_RELOAD_METHOD,
									},
								}
							: {}),
						...(features.libraryReload ? { [ACP_LIBRARY_META_KEY]: { version: 1, reload: ACP_LIBRARY_RELOAD_METHOD } } : {}),
						...(features.usage ? { [ACP_ACCOUNTING_META_KEY]: { version: 1, read: ACP_USAGE_READ_METHOD } } : {}),
						...(features.workspace ? { [ACP_WORKSPACE_META_KEY]: { version: 1, update: "session_info_update" } } : {}),
						...(features.aside
							? {
									[ACP_ASIDE_META_KEY]: {
										version: 1,
										ask: ACP_ASIDE_ASK_METHOD,
										draft: ACP_ASIDE_DRAFT_METHOD,
										cancel: ACP_ASIDE_CANCEL_METHOD,
										draftCounts: { ...ACP_ASIDE_DRAFT_COUNTS },
									},
								}
							: {}),
						// Echoed only when the client opted in, so the client's own gate
						// ("the runtime announced it") and the host's agree on one answer.
						...(interviewsEnabled
							? {
									[ACP_INTERVIEWS_META_KEY]: {
										version: 1,
										request: ACP_INTERVIEW_REQUEST_METHOD,
										cancel: ACP_INTERVIEW_CANCEL_METHOD,
									},
								}
							: {}),
						...(features.contextLedger
							? {
									[ACP_CONTEXT_META_KEY]: {
										version: 1,
										ledger: ACP_CONTEXT_LEDGER_METHOD,
										status: ACP_CONTEXT_STATUS_METHOD,
										...(features.bus ? { activity: "context.activity" } : {}),
										...(features.commandsCapability ? { invoke: ACP_COMMANDS_INVOKE_METHOD } : {}),
									},
								}
							: {}),
						...(features.artifacts
							? {
									[ACP_ARTIFACTS_META_KEY]: {
										version: 1,
										list: ACP_ARTIFACTS_LIST_METHOD,
										read: ACP_ARTIFACTS_READ_METHOD,
										categories: ACP_ARTIFACT_CATEGORIES,
										perCategory: ACP_ARTIFACTS_PER_CATEGORY,
									},
								}
							: {}),
						...(features.fleet
							? {
									[ACP_FLEET_META_KEY]: {
										version: 1,
										preview: ACP_FLEET_PREVIEW_METHOD,
										run: ACP_FLEET_RUN_METHOD,
										// Terminal dispatch frames carry `_meta[ACP_RECEIPT_META_KEY]` (#ACP-02).
										receiptFacts: true,
									},
								}
							: {}),
						...(features.handoff
							? {
									[ACP_HANDOFF_META_KEY]: {
										version: 1,
										prepare: ACP_HANDOFF_PREPARE_METHOD,
										commit: ACP_HANDOFF_COMMIT_METHOD,
										cancel: ACP_HANDOFF_CANCEL_METHOD,
									},
								}
							: {}),
						...(features.shell
							? {
									[ACP_SHELL_META_KEY]: {
										version: 1,
										run: ACP_SESSION_SHELL_METHOD,
										timeoutMs: OPERATOR_SHELL_TIMEOUT_MS,
									},
								}
							: {}),
						// The `queue` read gains `entries` alongside its two text lists. The
						// change notification carries the same list and is sent only to a
						// client that advertised this key, like the tool-progress stream.
						...(features.queueEdit
							? {
									[ACP_QUEUE_META_KEY]: {
										version: 1,
										edit: ACP_QUEUE_EDIT_METHOD,
										ops: ACP_QUEUE_EDIT_OPS,
										notification: ACP_QUEUE_CHANGED_NOTIFICATION,
									},
								}
							: {}),
					}),
				},
				authMethods:
					isRecord(clientCapabilities?.auth) && clientCapabilities.auth.terminal === true
						? [
								{
									id: "clio-login",
									name: "Clio Coder Target Auth & Setup",
									description: "Configure models, API keys, and target endpoints in terminal",
									type: "terminal",
									args: ["auth", "login"],
								},
							]
						: [],
			} satisfies AcpInitializeResponse;
		},
		authenticate(params) {
			requireInitialized();
			const request = assertHandshakeParams(params, new Set(["methodId"]));
			if (typeof request.methodId !== "string" || request.methodId.length === 0) {
				throw new AcpRequestError(-32602, "unknown authentication method", { code: "invalid_params" });
			}
			// Terminal authentication runs in a separate process.
			throw new AcpRequestError(-32602, "unknown authentication method", { code: "invalid_params" });
		},
		logout(params) {
			requireInitialized();
			assertHandshakeParams(params, new Set());
			loggedOut = true;
			return {};
		},
	};
}

export async function serveClioAcpAgent(options: ClioAcpServerOptions): Promise<number> {
	const sessions = new Map<string, AcpServerSession>();
	const handshake =
		options.handshake ??
		createAcpHandshake({
			...(options.version === undefined ? {} : { version: options.version }),
			session: options.session !== undefined,
			loadSession:
				options.session !== undefined &&
				options.readSessionEntries !== undefined &&
				options.buildReplayMessages !== undefined &&
				options.chat.resetForSession !== undefined,
			settings: options.settings !== undefined,
			providers: options.providers !== undefined,
			...(options.commands === undefined
				? {}
				: {
						commandsCapability: {
							version: 1,
							list: ACP_COMMANDS_LIST_METHOD,
							invoke: ACP_COMMANDS_INVOKE_METHOD,
							...(options.chat.whenSettled ? { promptTurns: true } : {}),
						},
					}),
			steer: options.chat.steer !== undefined,
			dispatch: options.dispatch !== undefined,
			toolRegistry: options.toolRegistry !== undefined,
			bus: options.bus !== undefined,
			board: options.board !== undefined,
			boardActions: options.board !== undefined && options.boardActions !== undefined,
			branches: branchesWired(options),
			handoff: handoffWired(options),
			fleet: options.fleet !== undefined,
			contextLedger: options.contextLedger !== undefined,
			artifacts: options.artifacts !== undefined,
			extensions: options.extensions !== undefined,
			libraryReload: options.libraryReload !== undefined,
			aside: options.aside !== undefined,
			usage: options.usage !== undefined,
			workspace: options.workspace !== undefined,
			images: options.expandPrompt !== undefined,
			interviews: options.interviews !== undefined,
			workerPermissions: options.workerPermissions !== undefined,
			shell: shellWired(options),
			queueEdit: queueEditWired(options),
		});
	const workspaceInstanceId = handshake.workspaceInstanceId;
	const now = options.now ?? Date.now;
	let eventSequence = 0;
	/**
	 * Per-run progress counters for the forwarded dispatch stream, insertion
	 * ordered. A terminal event removes its run; the cap evicts the oldest live
	 * run rather than refusing the newest, so a leaked run cannot starve the
	 * board of the run an operator is actually watching.
	 */
	const dispatchProgress = new Map<string, { count: number; capped: boolean }>();
	let activeSessionId: string | null = null;
	/**
	 * The one session this process hosts, from the moment it is bound until it is
	 * closed. Distinct from {@link activeSessionId}, which is only set while a
	 * prompt is running: a detached dispatch run legitimately finishes after the
	 * turn that started it, and a client keyed on the bound session still needs
	 * that outcome so its board does not leave the run running forever.
	 */
	let boundSessionId: string | null = null;
	let activePromptState: ActivePrompt | null = null;
	let sessionCreated = false;
	/** The one document awaiting review, keyed by the id its client holds. */
	let pendingHandoff: { handoffId: string; sessionId: string; draft: AcpHandoffDraft } | null = null;
	let handoffPreparing = false;
	/** Counts prompts, so a draft drawn while a request started is known to be stale. */
	let promptSerial = 0;
	let promptSettled: Promise<void> | null = null;
	/** The one operator shell line this process runs at a time, as the terminal runs one. */
	let activeShell: { sessionId: string; abort: AbortController; settled: Promise<void> } | null = null;
	const closedSessionIds = new Set<string>();
	const closingSessions = new Map<string, Promise<Record<string, never>>>();
	// The launch cwd is the process's one workspace identity: settings, project
	// context, and the session ledger were all resolved against it during boot.
	// It is canonicalized once here so a client that passes a symlinked path, a
	// trailing slash, or a `/.` suffix is recognised rather than refused.
	let contextActivity: ContextActivityPayload | null = null;
	let contextCommandInFlight: Promise<unknown> | null = null;
	const canonicalCwd = realpathSync(options.cwd ?? process.cwd());
	const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS;
	const telemetry: AcpLiveTelemetry = createAcpLiveTelemetry({
		notify: (sessionId, update) => options.transport.notify("session/update", { sessionId, update }),
		sessionId: () => boundSessionId,
		cwd: canonicalCwd,
		...(options.contextLedger !== undefined ? { contextLedger: options.contextLedger } : {}),
		...(options.usage !== undefined ? { sessionUsage: () => options.usage?.session() ?? EMPTY_SESSION_USAGE } : {}),
		...(options.plan !== undefined ? { plan: options.plan } : {}),
		...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	const workspaceResultMeta = async (): Promise<Record<string, unknown>> => {
		const view = await telemetry.workspace();
		return view === null ? {} : { [ACP_WORKSPACE_META_KEY]: view };
	};
	if (
		!Number.isSafeInteger(permissionTimeoutMs) ||
		permissionTimeoutMs < 1 ||
		permissionTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new Error(`ACP permission timeout must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
	}
	const permission = installPermissionBridge({
		transport: options.transport,
		toolRegistry: options.toolRegistry,
		...(options.bus ? { bus: options.bus } : {}),
		activeSessionId: () => activeSessionId,
		resolveToolCallId: (engineToolCallId) =>
			activePromptState === null ? null : openWireIdFor(activePromptState, engineToolCallId),
		soleOpenToolCallId: () => {
			if (activePromptState === null || activePromptState.openToolCalls.size !== 1) return null;
			const [only] = activePromptState.openToolCalls;
			return only ?? null;
		},
		toolCallSnapshot: (wireId) =>
			activePromptState === null ? null : (activePromptState.toolCallSnapshots.get(wireId) ?? null),
		permissionTimeoutMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
		...(options.workerPermissions !== undefined
			? {
					workerAsks: {
						enabled: () => handshake.initialized && handshake.workerPermissionsEnabled,
						resolve: options.workerPermissions.resolve,
						bindToolCall: (runId: string) => {
							const active = activePromptState;
							if (active === null) return null;
							let attributed: string | null = null;
							for (const wireId of active.openToolCalls) {
								if (active.toolCallSnapshots.get(wireId)?.agents?.some((agent) => agent.runId === runId)) {
									attributed = wireId;
								}
							}
							return attributed ?? newestOpenToolCallId(active);
						},
						withdraw: (sessionId: string, requestId: string) =>
							options.transport.notify(ACP_PERMISSION_WITHDRAW_METHOD, { sessionId, requestId }),
					},
				}
			: {}),
		expireActivePrompt: () => {
			if (activePromptState === null) return;
			activePromptState.permissionExpired = true;
			options.chat.cancel();
		},
		cancelActivePrompt: (reason) => {
			const session = activeSessionId === null ? undefined : sessions.get(activeSessionId);
			if (session) cancelSession(session, reason);
		},
	});
	/**
	 * Sends one frame of the opt-in stream. Every forwarded channel goes through
	 * here so the envelope, the sequence, and the opt-in check cannot drift per
	 * channel. Nothing is sent before a session exists: the envelope's
	 * `sessionId` is the client's only way to bind a fact to what it is showing.
	 */
	const forwardEvent = (
		kind: AcpForwardableEventKind,
		turnId: string | null,
		terminal: boolean,
		payload: Record<string, unknown>,
		meta?: Record<string, unknown>,
	): void => {
		const sessionId = activeSessionId ?? boundSessionId;
		if (!handshake.initialized || !handshake.enabledEventKinds.has(kind) || sessionId === null) return;
		eventSequence += 1;
		try {
			options.transport.notify(ACP_EVENT_NOTIFICATION, {
				version: 1,
				workspaceInstanceId,
				sessionId,
				turnId,
				sequence: eventSequence,
				kind,
				terminal,
				payload,
				...(meta !== undefined ? { _meta: meta } : {}),
			});
		} catch {
			options.diagnostics?.("failed to send an opted-in ACP event");
		}
	};

	/**
	 * The identity every dispatch frame carries. The exact task never crosses:
	 * what goes on the wire is a control-character-stripped, byte-bounded prefix
	 * carrying the standard truncation marker, so a client can label a run
	 * without receiving the operator's prose. A run whose id or agent cannot be
	 * represented safely is dropped rather than forwarded under a repaired
	 * identity, because a board keyed on a rewritten id merges distinct runs.
	 */
	const dispatchIdentity = (payload: {
		runId: string;
		agentId: string;
		task?: string | undefined;
		node?: string | undefined;
	}): { runId: string; agentId: string; taskPreview: string | null; node: string | null } | null => {
		const runId = safeStoredIdentifier(payload.runId, ACP_MAX_DISPATCH_ID_BYTES);
		const agentId = safeStoredIdentifier(payload.agentId, ACP_MAX_DISPATCH_ID_BYTES);
		if (runId === null || agentId === null) return null;
		const preview =
			payload.task === undefined ? "" : safeStoredString(payload.task, ACP_MAX_DISPATCH_TASK_PREVIEW_BYTES).trim();
		return {
			runId,
			agentId,
			taskPreview: preview.length === 0 ? null : preview,
			node: safeStoredIdentifier(payload.node, ACP_MAX_DISPATCH_ID_BYTES),
		};
	};

	/** Forgets a run's progress counter and keeps the live map inside its cap. */
	const trackDispatchRun = (runId: string): { count: number; capped: boolean } => {
		const existing = dispatchProgress.get(runId);
		if (existing !== undefined) return existing;
		if (dispatchProgress.size >= ACP_MAX_TRACKED_DISPATCH_RUNS) {
			const oldest = dispatchProgress.keys().next();
			if (!oldest.done) dispatchProgress.delete(oldest.value);
		}
		const created = { count: 0, capped: false };
		dispatchProgress.set(runId, created);
		return created;
	};

	const safeCount = (value: unknown): number | null =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

	/**
	 * The sealed receipt's facts for a terminal dispatch frame, projected by the
	 * same readers the TUI footer uses. The domain seals the receipt before it
	 * publishes the terminal event, so a live read finds it; a missing or
	 * unreadable one reports `unavailable: true` rather than failing the frame.
	 */
	const readReceipt = (runId: string, replay: boolean): RunReceiptFacts | null => {
		try {
			return replay ? readRunReceiptFactsForReplay(runId) : readRunReceiptFacts(runId);
		} catch {
			// The readers already swallow I/O and parse errors; anything else still
			// must not take down the frame, and null reads as unavailable.
			return null;
		}
	};
	const receiptMeta = (runId: string, facts: RunReceiptFacts | null): Record<string, unknown> => ({
		[ACP_RECEIPT_META_KEY]: receiptWireFacts(runId, facts),
	});

	const unsubscribeEvents: Array<() => void> = [];
	if (options.bus !== undefined) {
		const bus = options.bus;
		unsubscribeEvents.push(
			bus.on(BusChannels.EggsChanged, (payload) => {
				const sessionId = activeSessionId ?? boundSessionId;
				if (!handshake.initialized || sessionId === null || payload.sessionId !== sessionId) return;
				options.transport.notify("session/update", {
					sessionId,
					update: { sessionUpdate: "session_info_update", _meta: { [ACP_EGGS_META_KEY]: payload.active } },
				});
			}),
			bus.on(BusChannels.MemoryGuardianChanged, (payload) => {
				const sessionId = activeSessionId ?? boundSessionId;
				if (!handshake.initialized || sessionId === null || payload.sessionId !== sessionId) return;
				options.transport.notify("session/update", {
					sessionId,
					update: {
						sessionUpdate: "session_info_update",
						_meta: { [ACP_MEMORY_META_KEY]: { state: payload.state } },
					},
				});
			}),
			bus.on(BusChannels.LoopBlocked, (payload: LoopBlockedPayload) => {
				// Loop blocks describe the turn that is running, so unlike a dispatch
				// run they are meaningless outside one.
				if (activePromptState === null) return;
				if (
					!Number.isSafeInteger(payload.repeatCount) ||
					payload.repeatCount < 1 ||
					!Number.isSafeInteger(payload.blocksThisTurn) ||
					payload.blocksThisTurn < 1 ||
					!Number.isSafeInteger(payload.budget) ||
					payload.budget < 1 ||
					!(["block", "lockout", "stop"] as ReadonlyArray<string>).includes(payload.disposition) ||
					payload.interrupted !== (payload.disposition === "stop")
				) {
					return;
				}
				const tool = safeStoredString(payload.tool, 64).trim();
				if (tool.length === 0) return;
				forwardEvent("safety.loopBlocked", safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES), false, {
					toolCallId: null,
					tool,
					repeatCount: payload.repeatCount,
					blocksThisTurn: payload.blocksThisTurn,
					budget: payload.budget,
					disposition: payload.disposition,
					interrupted: payload.interrupted,
					shape: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchEnqueued, (payload: DispatchEnqueuedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(identity.runId);
				forwardEvent("dispatch.enqueued", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: null,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchStarted, (payload: DispatchStartedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				trackDispatchRun(identity.runId);
				// A run started by a tool call this turn already put on the wire is
				// the one place the harness knows which agent produced a tool
				// segment. Record it and re-announce the call so a client can label
				// the segment while the worker is still running.
				attributeRunToToolCall(payload.parentToolCallId, identity);
				forwardEvent("dispatch.started", null, false, {
					...identity,
					origin: safeStoredIdentifier(payload.requestOrigin, 64),
					attempt: safeCount(payload.attempt),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchProgress, (payload: DispatchProgressPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				const state = trackDispatchRun(identity.runId);
				if (state.capped) return;
				state.count += 1;
				const capped = state.count > ACP_MAX_DISPATCH_PROGRESS_EVENTS;
				if (capped) state.capped = true;
				// The worker/ACP event that triggered this crossed a process boundary
				// and is typed `unknown`; none of it goes on the wire. What a board
				// needs is that the run is alive and roughly how much it has done.
				forwardEvent("dispatch.progress", null, false, {
					runId: identity.runId,
					agentId: identity.agentId,
					progressCount: state.count,
					truncated: capped,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchCompleted, (payload: DispatchCompletedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				dispatchProgress.delete(identity.runId);
				forwardEvent(
					"dispatch.completed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
						tokenCount: safeCount(payload.tokenCount),
					},
					receiptMeta(identity.runId, readReceipt(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchFailed, (payload: DispatchFailedPayload) => {
				const identity = dispatchIdentity(payload);
				if (identity === null) return;
				dispatchProgress.delete(identity.runId);
				forwardEvent(
					"dispatch.failed",
					null,
					true,
					{
						runId: identity.runId,
						agentId: identity.agentId,
						outcome: safeStoredIdentifier(payload.outcome, 64),
						reason: safeStoredIdentifier(payload.reason, 64),
						outcomeCode: safeStoredIdentifier(payload.outcomeCode, 64),
						outcomeDetail: safeStoredString(payload.outcomeDetail, 2048) || null,
						durationMs: safeCount(payload.durationMs),
					},
					receiptMeta(identity.runId, readReceipt(identity.runId, false)),
				);
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.AccountabilityEvidenceReady, (payload: AccountabilityEvidenceReadyPayload) => {
				// Arrives after dispatch.completed or dispatch.failed for the same run,
				// so it is terminal too: nothing about that run follows it. The
				// bundle's prose (findings, overview) stays behind; only the summary
				// counters the projection itself carries cross, and the tags are
				// filtered to bounded identifiers rather than truncated into new ones.
				const runId = safeStoredIdentifier(payload.runId, ACP_MAX_DISPATCH_ID_BYTES);
				const evidenceId = safeStoredIdentifier(payload.evidenceId, ACP_MAX_DISPATCH_ID_BYTES);
				if (runId === null || evidenceId === null) return;
				const tags = (Array.isArray(payload.tags) ? payload.tags : [])
					.map((tag) => safeStoredIdentifier(tag, ACP_MAX_EVIDENCE_TAG_BYTES))
					.filter((tag): tag is string => tag !== null)
					.slice(0, ACP_MAX_EVIDENCE_TAGS);
				forwardEvent("accountability.evidenceReady", null, true, {
					runId,
					evidenceId,
					firstPassSuccess: payload.firstPassSuccess === true,
					findingCount: safeCount(payload.findingCount),
					tags,
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.ContextActivity, (payload) => {
				if (!payload.operation || payload.operation.sessionId !== boundSessionId || payload.operation.cwd !== canonicalCwd)
					return;
				const operation = readContextOperation(payload.operation);
				if (!operation) return;
				contextActivity = {
					kind: payload.kind,
					phase: payload.phase,
					status: payload.status,
					at: payload.at,
					message: safeStoredString(payload.message, 1024),
					operation,
					...(payload.current === undefined ? {} : { current: payload.current }),
					...(payload.total === undefined ? {} : { total: payload.total }),
					...(payload.detail === undefined ? {} : { detail: safeStoredString(payload.detail, 1024) }),
					...(payload.stages === undefined ? {} : { stages: payload.stages }),
					...(payload.timing === undefined ? {} : { timing: payload.timing }),
				};
				forwardEvent("context.activity", null, operation.outcome !== undefined, { ...contextActivity });
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.CompactionEnd, (payload: CompactionPayload) => {
				// Only the end fires: a client that drew a "compacting" state from
				// the begin channel would have to guess when to clear it, and the
				// fact a context meter needs is that the window was just cut.
				const trigger = safeStoredIdentifier(payload.trigger, 64);
				if (trigger === null) return;
				forwardEvent("compaction.end", null, false, { trigger });
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.ContextWarning, (payload: ContextWarningPayload) => {
				// Transition-only upstream, so this is a level edge, not a poll:
				// `warning: null` is the clear and has to cross as itself rather than
				// be dropped, or a client's banner never comes down.
				if (payload.warning !== null && typeof payload.warning !== "string") return;
				const warning = payload.warning === null ? null : safeStoredString(payload.warning, ACP_MAX_EVENT_TEXT_BYTES);
				forwardEvent("context.warning", null, false, { warning: warning === "" ? null : warning });
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.DispatchScopeNotice, (payload) => {
				// The same fields every other surface draws. The message is host-authored
				// prose about what a dispatch's scope entry did, so it crosses bounded;
				// the paths a legacy notice lists stay behind.
				const notice = readDispatchScopeNotice(payload);
				if (notice === null) return;
				forwardEvent("dispatch.scopeNotice", null, false, {
					code: notice.code,
					level: notice.level,
					message: safeStoredString(notice.message, ACP_MAX_SCOPE_NOTICE_BYTES),
				});
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.ToolBudgetExceeded, (payload: ToolBudgetExceededPayload) => {
				// Bound to the turn that is running, like `safety.loopBlocked`: the
				// budget it names is per-turn and means nothing outside one.
				if (activePromptState === null) return;
				const callsThisTurn = safeCount(payload.callsThisTurn);
				const softBudget = safeCount(payload.softBudget);
				const hardCeiling = safeCount(payload.hardCeiling);
				const tool = safeStoredString(payload.tool, 64).trim();
				if (callsThisTurn === null || softBudget === null || hardCeiling === null || tool.length === 0) return;
				forwardEvent(
					"safety.toolBudgetExceeded",
					safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES),
					payload.interrupted === true,
					{ tool, callsThisTurn, softBudget, hardCeiling, interrupted: payload.interrupted === true },
				);
			}),
		);
		unsubscribeEvents.push(
			bus.on(BusChannels.ProviderHealth, (payload: ProviderHealthPayload) => {
				// `status.lastError` is provider prose that legitimately quotes URLs,
				// response bodies, and credentials-adjacent detail, so it stays behind
				// exactly as `dispatch.failed`'s `outcomeDetail` does. What crosses is
				// the taxonomy a retry-visibility row needs.
				const targetId = safeStoredIdentifier(payload.id, ACP_MAX_TARGET_ID_BYTES);
				const status = payload.status?.health?.status;
				if (targetId === null || !(["healthy", "degraded", "unknown", "down"] as ReadonlyArray<unknown>).includes(status)) {
					return;
				}
				forwardEvent("provider.health", null, false, {
					targetId,
					status,
					available: payload.status.available === true,
					latencyMs: safeCount(payload.status.health.latencyMs),
				});
			}),
		);
	}
	const unsubscribeEventStream = (): void => {
		for (const unsubscribe of unsubscribeEvents) unsubscribe();
		unsubscribeEvents.length = 0;
		dispatchProgress.clear();
	};
	// The chat loop reports every enqueue, hand-over, edit and drain, mid-turn
	// or not. A client that opted in replaces its queue rows with each list
	// instead of polling `queue` while a turn runs.
	const unsubscribeQueueEvents = queueEditWired(options)
		? options.chat.onEvent((raw) => {
				if (eventRecord(raw).type !== "queue_update") return;
				const sessionId = activeSessionId ?? boundSessionId;
				if (!handshake.initialized || !handshake.queueEventsEnabled || sessionId === null) return;
				try {
					options.transport.notify(ACP_QUEUE_CHANGED_NOTIFICATION, {
						sessionId,
						entries: projectQueueEntries(options.chat.queueEntries?.() ?? []),
					});
				} catch {
					options.diagnostics?.("failed to send a queue change notification");
				}
			})
		: () => {};

	/**
	 * Records a delegated agent against the tool call that spawned it and
	 * re-announces that call so the attribution reaches the client while the
	 * worker is running. Nothing is minted here: an id with no open call this
	 * turn binds to nothing, exactly as on the permission path.
	 */
	function attributeRunToToolCall(
		parentToolCallId: string | undefined,
		identity: { runId: string; agentId: string; node: string | null },
	): void {
		const active = activePromptState;
		if (active === null || activeSessionId === null) return;
		if (parentToolCallId === undefined || parentToolCallId.length === 0) return;
		const wireId = openWireIdFor(active, parentToolCallId);
		if (wireId === null) return;
		const snapshot = active.toolCallSnapshots.get(wireId);
		if (snapshot === undefined) return;
		const agents = snapshot.agents ?? [];
		if (agents.length >= ACP_MAX_TOOL_CALL_AGENTS) return;
		if (agents.some((agent) => agent.runId === identity.runId)) return;
		agents.push({
			version: 1,
			role: "worker",
			agentId: identity.agentId,
			runId: identity.runId,
			...(identity.node !== null ? { node: identity.node } : {}),
		});
		snapshot.agents = agents;
		sendUpdate(
			options.transport,
			activeSessionId,
			active,
			{
				sessionUpdate: "tool_call_update",
				toolCallId: wireId,
				title: snapshot.title,
				kind: snapshot.kind,
				status: "in_progress" satisfies AcpToolCallStatus,
			},
			toolCallUpdateMeta(snapshot),
		);
	}

	const requireInitialized = (): void => {
		if (!handshake.initialized)
			throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
	};
	const requireAuthenticated = (): void => {
		if (handshake.loggedOut)
			throw new AcpRequestError(-32000, "authentication required", { code: "authentication_required" });
	};

	const sessionIdOf = (params: unknown): string => {
		return requireBoundedClientString(
			isRecord(params) ? params.sessionId : undefined,
			"sessionId",
			ACP_MAX_SESSION_ID_BYTES,
		);
	};

	const assertParamKeys = (params: unknown, allowed: ReadonlySet<string>): Record<string, unknown> => {
		if (params === undefined) return {};
		if (!isRecord(params) || Object.keys(params).some((key) => key !== "_meta" && !allowed.has(key))) {
			throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
		}
		return params;
	};

	const canonicalSessionCwd = (requested: unknown): string => {
		const mismatch = (): AcpRequestError =>
			new AcpRequestError(-32602, `session cwd does not match bound workspace root ${canonicalCwd}`, {
				code: "session_cwd_mismatch",
			});
		if (typeof requested !== "string" || requested.trim().length === 0 || !isAbsolute(requested)) throw mismatch();
		let sessionCwd: string;
		try {
			sessionCwd = realpathSync(resolvePath(requested));
		} catch {
			throw mismatch();
		}
		if (sessionCwd !== canonicalCwd) throw mismatch();
		return sessionCwd;
	};
	const attachClientMcpServers = async (servers: ReadonlyArray<McpClientServerSpec>): Promise<void> => {
		if (servers.length === 0) return;
		if (!options.mcpCapabilities) {
			throw new AcpRequestError(-32602, "client MCP servers are unavailable in this host", { code: "invalid_params" });
		}
		try {
			await options.mcpCapabilities.attachClientServers(servers);
		} catch (error) {
			await options.mcpCapabilities.detachClientServers();
			options.diagnostics?.(`client MCP launch failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "client MCP servers could not start", { code: "internal_error" });
		}
	};

	const workspaceHistory = (): SessionMeta[] => {
		const history = options.session?.history() ?? [];
		return history.filter((meta) => {
			if (safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null) return false;
			try {
				return realpathSync(resolvePath(meta.cwd)) === canonicalCwd;
			} catch {
				return false;
			}
		});
	};

	const workspaceMeta = (sessionId: string): SessionMeta => {
		const meta = workspaceHistory().find((candidate) => candidate.id === sessionId);
		if (!meta) throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		return meta;
	};

	const routingSnapshot = (): AcpRoutingSnapshot => {
		const route = options.routing?.() ?? { target: null, model: null };
		return {
			target: safeConfiguredIdentifier(route.target, ACP_MAX_TARGET_ID_BYTES),
			model: safeConfiguredIdentifier(route.model, ACP_MAX_MODEL_ID_BYTES),
		};
	};

	const getSession = (params: unknown): AcpServerSession => {
		const id = sessionIdOf(params);
		const session = sessions.get(id);
		if (!session) throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		return session;
	};
	const modeState = (session: AcpServerSession) => ({
		currentModeId: session.autonomy,
		availableModes: [
			{
				id: "default",
				name: "default",
				description: "Supervised workspace edits with ordinary confirmation prompts.",
			},
			{
				id: "yolo",
				name: "yolo",
				description: "Proceed without ordinary confirmation prompts. Hard blocks and damage-control asks remain active.",
			},
		],
	});
	const sessionThinking = (session: AcpServerSession, model = session.model) => {
		if (!options.providers || !session.target || !model) return null;
		const resolved = resolveRuntimeTarget(options.providers, {
			targetId: session.target,
			wireModelId: model,
			requestedThinkingLevel: session.thinkingLevel,
			use: "orchestrator",
		});
		return resolved.ok ? resolved.target.modelRuntime.thinking : null;
	};
	const configOptions = (session: AcpServerSession) => {
		const optionsList: Array<Record<string, unknown>> = [
			{
				id: "autonomy",
				name: "Autonomy",
				category: "mode",
				type: "select",
				currentValue: session.autonomy,
				options: modeState(session).availableModes.map((mode) => ({
					value: mode.id,
					name: mode.name,
					description: mode.description,
				})),
			},
		];
		if (options.providers && options.setSessionRouting) {
			optionsList.push({
				id: "target",
				name: "Target",
				category: "model",
				type: "select",
				currentValue: session.target,
				options: options.providers
					.list()
					.filter((status) => status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime))
					.map((status) => ({ value: status.target.id, name: status.target.id })),
			});
		}
		if (session.model !== null) {
			const status = options.providers?.list().find((item) => item.target.id === session.target);
			const models = status === undefined ? [] : safeTargetModels(status);
			if (!models.includes(session.model)) models.unshift(session.model);
			optionsList.push({
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: session.model,
				options: models.map((model) => {
					const thinking = sessionThinking(session, model);
					return { value: model, name: model, ...(thinking ? { thinkingLevels: thinking.supportedLevels } : {}) };
				}),
			});
		}
		const thinking = sessionThinking(session);
		optionsList.push({
			id: "thinkingLevel",
			name: "Thinking level",
			category: "thought_level",
			type: "select",
			currentValue: thinking?.effectiveLevel ?? session.thinkingLevel,
			...(thinking?.notice ? { notice: thinking.notice } : {}),
			options: (thinking?.supportedLevels ?? []).map((level) => ({
				value: level,
				name: thinking?.mechanism === "on-off" && level !== "off" ? "on" : level,
			})),
		});
		return optionsList;
	};
	const notifyConfigOptions = (session: AcpServerSession) => {
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) },
			_meta: { [ACP_SESSION_META_KEY]: { target: session.target } },
		});
	};
	const setAutonomy = (session: AcpServerSession, level: unknown): void => {
		if (!isAutonomyLevel(level)) throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change autonomy during an active prompt", { code: "prompt_active" });
		if (session.autonomy === level) return;
		session.autonomy = level;
		session.autonomySource = "session";
		options.transport.notify("session/update", {
			sessionId: session.id,
			update: { sessionUpdate: "current_mode_update", currentModeId: level },
		});
		notifyConfigOptions(session);
	};
	const sessionConfig = (session: AcpServerSession) => ({
		modes: modeState(session),
		configOptions: configOptions(session),
	});
	// The catalog is rebuilt from `commandReference()` on every call and a
	// palette legitimately re-reads it after a reload, so it is memoized against
	// a client that polls and against every prompt that checks for a typed
	// command. Availability is fixed by the host callbacks wired when this server
	// is created; session/route changes do not alter that wiring.
	let commandCatalog: AcpCommandCatalog | null = null;
	const catalog = () => {
		if (options.commands === undefined) return undefined;
		commandCatalog ??= options.commands.catalog();
		return commandCatalog;
	};
	const availableCommands = () =>
		catalog()
			?.commands.filter(
				(command) =>
					(command.injectsUserTurn !== true || options.chat.whenSettled !== undefined) &&
					(command.streams === undefined || command.injectsUserTurn === true || command.promptTurn === true),
			)
			.map((command) => ({
				name: command.name,
				description: command.summary,
				input: { hint: command.usage },
			})) ?? [];
	const announceCommands = (sessionId: string) => {
		if (options.commands === undefined) return;
		options.transport.notify("session/update", {
			sessionId,
			update: { sessionUpdate: "available_commands_update", availableCommands: availableCommands() },
		});
	};

	options.transport.onRequest("initialize", (params) => handshake.initialize(params));
	options.transport.onRequest("authenticate", (params) => handshake.authenticate(params));
	options.transport.onRequest("logout", (params) => handshake.logout(params));

	options.transport.onRequest("session/new", async (params) => {
		requireInitialized();
		requireAuthenticated();
		// The chat instance can bind only one session at a time. Closing that
		// session releases the slot; the next creation resets its conversation.
		if (sessionCreated) {
			throw new AcpRequestError(-32602, "this server hosts one session per process", { code: "session_limit" });
		}
		const request = assertParamKeys(params, new Set(["cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		const sessionCwd = canonicalSessionCwd(request.cwd);
		const clientMcpServers = parseClientMcpServers(request.mcpServers, false);
		const route = routingSnapshot();
		const createInput: { cwd: string; target?: string; model?: string } = { cwd: sessionCwd };
		if (route.target !== null) createInput.target = route.target;
		if (route.model !== null) createInput.model = route.model;
		await attachClientMcpServers(clientMcpServers);
		let meta: SessionMeta | undefined;
		try {
			meta = options.session?.create(createInput);
		} catch (error) {
			await options.mcpCapabilities?.detachClientServers();
			throw error;
		}
		const id = meta?.id ?? randomUUID();
		if (safeStoredIdentifier(id, ACP_MAX_SESSION_ID_BYTES) === null) {
			await options.mcpCapabilities?.detachClientServers();
			throw new AcpRequestError(-32603, "session creation failed", { code: "internal_error" });
		}
		options.chat.resetForSession?.(null);
		const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const boundTarget = safeConfiguredIdentifier(meta?.target ?? route.target, ACP_MAX_TARGET_ID_BYTES);
		const boundModel = safeConfiguredIdentifier(meta?.model ?? route.model, ACP_MAX_MODEL_ID_BYTES);
		const session: AcpServerSession = {
			id,
			cwd: sessionCwd,
			autonomy,
			autonomySource: "settings",
			target: boundTarget,
			model: boundModel,
			thinkingLevel: options.settings?.read().thinkingLevel ?? "off",
			createdAt: meta?.createdAt ?? new Date().toISOString(),
			activePrompt: null,
		};
		sessionCreated = true;
		sessions.set(id, session);
		boundSessionId = id;
		announceCommands(id);
		telemetry.bind(false);
		return {
			sessionId: id,
			...sessionConfig(session),
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(session, false),
				...(await workspaceResultMeta()),
				...trustResultMeta(session.cwd),
			},
		};
	});

	interface PreparedRestore {
		leafTurnId: string | null;
		replayMessages: ReadonlyArray<AgentMessage>;
		replay: PreparedAcpReplay | undefined;
	}
	/**
	 * Everything a restore reads, gathered before anything changes, so a read
	 * failure leaves the bound session exactly as it was. `session/load`, a
	 * fork, a /tree switch and a handoff all restore through here: one replay
	 * projection, one provider context builder.
	 */
	const prepareRestore = (
		id: string,
		leafTurnId: string | null,
		scope: "leaf" | "upto",
		replayToClient: boolean,
	): PreparedRestore => {
		if (options.readSessionEntries === undefined || options.buildReplayMessages === undefined) {
			throw new Error("session replay is not wired");
		}
		const entries = options.readSessionEntries(id);
		return {
			leafTurnId,
			replayMessages: options.buildReplayMessages(entries, leafTurnId, scope),
			replay: replayToClient ? prepareAcpReplay(entries, leafTurnId, id) : undefined,
		};
	};
	/**
	 * A reopened session's historical runs, replayed as the terminal dispatch
	 * frames a live client would have received, with the same receipt facts the
	 * TUI's replayed footers read (#ACP-02). A run the ledger still shows open
	 * in another process has no terminal frame yet, so it is skipped.
	 */
	const replayDispatchTerminals = (runs: ReadonlyArray<{ runId: string; agentId: string }>): void => {
		const seen = new Set<string>();
		for (const run of runs) {
			if (seen.has(run.runId)) continue;
			seen.add(run.runId);
			const identity = dispatchIdentity(run);
			if (identity === null) continue;
			const facts = readReceipt(identity.runId, true);
			if (facts?.stillRunning === true) continue;
			const outcome = facts === null ? null : safeStoredIdentifier(facts.outcome, 64);
			const common = {
				runId: identity.runId,
				agentId: identity.agentId,
				outcome,
				outcomeCode: safeStoredIdentifier(facts?.outcomeCode, 64),
				outcomeDetail: safeStoredString(facts?.failureMessage ?? facts?.abandonedDetail, 2048) || null,
				durationMs: safeCount(facts?.durationMs),
			};
			const replayMeta = { ...receiptMeta(identity.runId, facts), [ACP_REPLAY_META_KEY]: { run: true } };
			if (outcome === "succeeded") {
				forwardEvent("dispatch.completed", null, true, { ...common, tokenCount: safeCount(facts?.tokenCount) }, replayMeta);
			} else {
				forwardEvent("dispatch.failed", null, true, { ...common, reason: outcome }, replayMeta);
			}
		}
	};
	/** Bind `session` as the one this process hosts, then replay its branch to the client. */
	const bindRestored = (session: AcpServerSession, replay: PreparedAcpReplay | undefined): void => {
		sessions.set(session.id, session);
		boundSessionId = session.id;
		announceCommands(session.id);
		if (replay !== undefined) {
			for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
			replayDispatchTerminals(replay.runs);
		}
		telemetry.bind(replay !== undefined);
	};

	const restoreSession = async (params: unknown, replayToClient: boolean) => {
		requireInitialized();
		requireAuthenticated();
		if (sessionCreated) {
			throw new AcpRequestError(-32602, "this server hosts one session per process", { code: "session_limit" });
		}
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		const id = sessionIdOf(request);
		canonicalSessionCwd(request.cwd);
		const clientMcpServers = parseClientMcpServers(request.mcpServers, replayToClient);
		const stored = workspaceMeta(id);
		if (stored.endedAt === null) {
			throw new AcpRequestError(-32602, "session may already be open", { code: "session_open" });
		}
		const storedTarget = safeConfiguredIdentifier(stored.target, ACP_MAX_TARGET_ID_BYTES);
		const storedModel = safeConfiguredIdentifier(stored.model, ACP_MAX_MODEL_ID_BYTES);
		if (
			options.session === undefined ||
			options.readSessionEntries === undefined ||
			options.buildReplayMessages === undefined ||
			options.chat.resetForSession === undefined
		) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}

		// Read and validate the client replay before MCP or session ownership changes.
		let entries: ReadonlyArray<SessionEntry>;
		let replay: PreparedAcpReplay | undefined;
		try {
			entries = options.readSessionEntries(id);
			const leaf = options.session.tree(id).leafId;
			replay = replayToClient ? prepareAcpReplay(entries, leaf, id) : undefined;
		} catch {
			throw new AcpRequestError(-32603, "session could not be loaded", { code: "internal_error" });
		}
		await attachClientMcpServers(clientMcpServers);
		try {
			const restored = restoreControlledSession(
				{
					session: options.session,
					chat: { resetForSession: options.chat.resetForSession },
					readEntries: options.readSessionEntries,
					buildMessages: options.buildReplayMessages,
				},
				id,
			);
			replay = replayToClient ? prepareAcpReplay(restored.entries, restored.leafTurnId, id) : undefined;
		} catch {
			await options.mcpCapabilities?.detachClientServers();
			if (options.session.current()?.id === id) {
				try {
					await options.session.close();
				} catch {
					// Best effort: no replay has been emitted and the slot remains unused.
				}
			}
			throw new AcpRequestError(-32603, "session could not be loaded", { code: "internal_error" });
		}

		const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const session: AcpServerSession = {
			id,
			cwd: canonicalCwd,
			autonomy,
			autonomySource: "settings",
			target: storedTarget,
			model: storedModel,
			thinkingLevel: options.settings?.read().thinkingLevel ?? "off",
			createdAt: stored.createdAt,
			activePrompt: null,
		};
		sessionCreated = true;
		bindRestored(session, replay);
		return {
			...sessionConfig(session),
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					session,
					true,
					replay !== undefined ? { turns: replay.turns, truncated: replay.truncated } : undefined,
				),
				...(await workspaceResultMeta()),
				...trustResultMeta(session.cwd),
			},
		};
	};
	options.transport.onRequest("session/load", (params) => restoreSession(params, true));
	options.transport.onRequest("session/resume", (params) => restoreSession(params, false));

	options.transport.onRequest(ACP_SESSION_LIST_METHOD, (params): AcpSessionList => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["cwd", "cursor"]));
		if (options.session === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (request.cwd !== undefined && request.cwd !== null) {
			if (typeof request.cwd !== "string" || !isAbsolute(request.cwd))
				throw new AcpRequestError(-32602, "cwd must be an absolute path", { code: "invalid_params" });
			let filterCwd: string;
			try {
				filterCwd = realpathSync(request.cwd);
			} catch {
				return { sessions: [] };
			}
			if (filterCwd !== canonicalCwd) return { sessions: [] };
		}
		let start = 0;
		if (request.cursor !== undefined && request.cursor !== null) {
			if (typeof request.cursor !== "string" || request.cursor.length > 512)
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			let decoded: unknown;
			try {
				decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
			} catch {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			if (
				!isRecord(decoded) ||
				decoded.workspace !== workspaceInstanceId ||
				!Number.isSafeInteger(decoded.start) ||
				(decoded.start as number) < 0 ||
				Buffer.from(JSON.stringify(decoded)).toString("base64url") !== request.cursor
			) {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			start = decoded.start as number;
		}
		const history = workspaceHistory().filter((meta) => meta.hasModelTurn !== false);
		const projected: AcpSessionListRow[] = [];
		let budgetBytes = utf8Bytes(JSON.stringify({ sessions: [] }));
		for (const meta of history.slice(start, start + 50)) {
			const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
			const messageCount = safeCount(meta.messageCount);
			const item = {
				sessionId: meta.id,
				cwd: canonicalCwd,
				...(label.length > 0 ? { title: label } : {}),
				updatedAt: safeIso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
				_meta: {
					[ACP_SESSION_META_KEY]: {
						createdAt: safeIso(meta.createdAt),
						endedAt: meta.endedAt === null ? null : safeIso(meta.endedAt),
						target: safeConfiguredIdentifier(meta.target, ACP_MAX_TARGET_ID_BYTES),
						model: safeConfiguredIdentifier(meta.model, ACP_MAX_MODEL_ID_BYTES),
						...(meta.firstMessagePreview !== undefined
							? { firstMessagePreview: safeStoredString(meta.firstMessagePreview, ACP_MAX_LABEL_BYTES) }
							: {}),
						...(messageCount !== null ? { messageCount } : {}),
						...(meta.hasModelTurn !== undefined ? { hasModelTurn: meta.hasModelTurn } : {}),
						...(meta.lastActivityAt !== undefined ? { lastActivityAt: safeIso(meta.lastActivityAt) } : {}),
					},
				},
			};
			const itemBytes = utf8Bytes(JSON.stringify(item));
			const separatorBytes = projected.length > 0 ? 1 : 0;
			if (budgetBytes + separatorBytes + itemBytes > ACP_MAX_SESSION_LIST_RESULT_BYTES) {
				break;
			}
			projected.push(item);
			budgetBytes += separatorBytes + itemBytes;
		}
		return {
			sessions: projected,
			...(start + projected.length < history.length
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ workspace: workspaceInstanceId, start: start + projected.length }),
						).toString("base64url"),
					}
				: {}),
		};
	});

	options.transport.onRequest(ACP_BOARD_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		return projectSessionBoard(options.board());
	});

	const requireBranches = () => {
		const session = options.session;
		const resetForSession = options.chat.resetForSession;
		const readEntries = options.readSessionEntries;
		const buildMessages = options.buildReplayMessages;
		if (
			!branchesWired(options) ||
			session === undefined ||
			resetForSession === undefined ||
			readEntries === undefined ||
			buildMessages === undefined
		) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return { session, resetForSession: resetForSession.bind(options.chat), readEntries, buildMessages };
	};
	/** A branch change rewrites the context a running turn is reading, so it waits for the turn. */
	const requireIdle = (session: AcpServerSession, action: string): void => {
		if (
			contextCommandInFlight !== null ||
			session.activePrompt !== null ||
			activePromptState !== null ||
			options.chat.isStreaming()
		) {
			throw new AcpRequestError(-32602, `cannot ${action} during an active prompt`, { code: "prompt_active" });
		}
	};
	const selectableTurn = (contract: SessionContract, sessionId: string, value: unknown): string => {
		const turnId = requireBoundedClientString(value, "turnId", ACP_MAX_SESSION_ID_BYTES);
		let kind: string | undefined;
		try {
			kind = contract.tree(sessionId).nodesById[turnId]?.kind;
		} catch {
			throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
		}
		if (kind === undefined || !isSelectableTreeNode(kind)) {
			throw new AcpRequestError(-32602, "turn is not in this session", { code: "turn_unknown" });
		}
		return turnId;
	};

	options.transport.onRequest(ACP_SESSION_TREE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const { session } = requireBranches();
		const bound = getSession(request);
		try {
			return projectSessionTree(session.tree(bound.id));
		} catch {
			throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
		}
	});

	// Enter in /tree: the next request appends under the chosen turn, and the
	// conversation is replayed as that branch. Sibling branches stay on disk.
	options.transport.onRequest(ACP_SESSION_SWITCH_TURN_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "turnId"]));
		const { session, resetForSession } = requireBranches();
		const bound = getSession(request);
		requireIdle(bound, "switch branches");
		const turnId = selectableTurn(session, bound.id, request.turnId);
		let restore: PreparedRestore;
		try {
			restore = prepareRestore(bound.id, turnId, "upto", true);
		} catch {
			throw new AcpRequestError(-32603, "branch could not be read", { code: "internal_error" });
		}
		try {
			session.switchTurn(turnId);
		} catch (error) {
			options.diagnostics?.(`branch switch failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "branch switch failed", { code: "internal_error" });
		}
		resetForSession(turnId, restore.replayMessages);
		bindRestored(bound, restore.replay);
		const replay = restore.replay;
		return {
			sessionId: bound.id,
			leafId: turnId,
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					bound,
					true,
					replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
				),
			},
		};
	});

	// /fork: a new session carrying the branch up to the chosen turn. The
	// process follows the new session, as the terminal does, and the parent is
	// closed on disk. Workspace files are never rewound.
	options.transport.onRequest(ACP_SESSION_FORK_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "turnId"]));
		const { session, resetForSession, readEntries, buildMessages } = requireBranches();
		const bound = getSession(request);
		requireIdle(bound, "fork");
		const turnId = selectableTurn(session, bound.id, request.turnId);
		let meta: SessionMeta;
		try {
			meta = session.fork(turnId);
		} catch (error) {
			// The session domain keeps the parent current when a fork throws.
			options.diagnostics?.(`fork failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		if (
			meta.id === bound.id ||
			session.current()?.id !== meta.id ||
			safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null
		) {
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		// Route, autonomy and thinking are this process's, not the ledger's, so
		// the child keeps what the parent's conversation was using.
		const forked: AcpServerSession = {
			...bound,
			id: meta.id,
			createdAt: meta.createdAt,
			activePrompt: null,
		};
		sessions.delete(bound.id);
		let replay: PreparedAcpReplay | undefined;
		let replayFailed = false;
		let forkLeaf: string | null = turnId;
		try {
			const restored = replayCurrentSession(
				{
					session,
					chat: { resetForSession },
					readEntries,
					buildMessages,
				},
				meta.id,
				"leaf",
				undefined,
				turnId,
			);
			forkLeaf = restored.leafTurnId;
			replay = prepareAcpReplay(restored.entries, restored.leafTurnId, meta.id);
		} catch (error) {
			options.diagnostics?.(`fork replay failed: ${acpErrorMessage(error)}`);
			resetForSession(forkLeaf, []);
			replayFailed = true;
		}
		bindRestored(forked, replay);
		return {
			sessionId: forked.id,
			parentSessionId: bound.id,
			parentTurnId: turnId,
			...sessionConfig(forked),
			_meta: {
				[ACP_SESSION_META_KEY]: {
					...sessionResultMeta(
						forked,
						true,
						replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
					),
					...(replayFailed ? { replayFailed: true } : {}),
				},
			},
		};
	});

	const handoffRefusal = (level: "warn" | "error", code: string, reason: string) => ({
		status: "refused" as const,
		level,
		code,
		reason: boundString(reason, ACP_MAX_HANDOFF_REASON_BYTES),
	});
	const requireHandoff = () => {
		const control = options.handoff;
		const branches = requireBranches();
		if (control === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		return { control, ...branches };
	};
	/** Reviewed text keeps its line structure; any other control character is refused. */
	const handoffDocument = (value: unknown): string => {
		if (typeof value !== "string" || utf8Bytes(value) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
		}
		// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character other than a line break is the refusal.
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
			throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
		}
		return value;
	};

	// /handoff, first half: extract with one repair and render the document a
	// person reviews. Nothing is written; the draft waits here under an id.
	options.transport.onRequest(ACP_HANDOFF_PREPARE_METHOD, async (params): Promise<AcpHandoffPrepareResult> => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "goal"]));
		const { control } = requireHandoff();
		const bound = getSession(request);
		requireIdle(bound, "hand off");
		const goal = requireBoundedClientString(request.goal, "goal", ACP_MAX_HANDOFF_GOAL_BYTES, { allowEmpty: true });
		if (handoffPreparing) return handoffRefusal("warn", "busy", "a handoff document is already being drawn up");
		handoffPreparing = true;
		const serial = promptSerial;
		let outcome: Awaited<ReturnType<AcpHandoffControl["prepare"]>>;
		try {
			outcome = await control.prepare(goal);
		} catch (error) {
			options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(error)}`);
			return handoffRefusal("error", "extraction", "the extraction round failed");
		} finally {
			handoffPreparing = false;
		}
		if (!outcome.ok) {
			// A failed round carries the provider's own words; those stay on the stderr tail.
			if (outcome.code === "provider") {
				options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(outcome.reason)}`);
				return handoffRefusal(
					outcome.level,
					outcome.code,
					"the model round failed; the agent's diagnostics carry the provider's answer",
				);
			}
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		if (serial !== promptSerial || sessions.get(bound.id) !== bound) {
			return handoffRefusal("warn", "stale", "the conversation moved while the document was drawn; nothing was written");
		}
		if (utf8Bytes(outcome.draft.document) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			return handoffRefusal("error", "too_large", "the handoff document is larger than a client can review");
		}
		const handoffId = randomUUID();
		pendingHandoff = { handoffId, sessionId: bound.id, draft: outcome.draft };
		return {
			status: "ready" as const,
			handoffId,
			goal: outcome.draft.goal,
			fromSessionId: outcome.draft.fromSessionId,
			document: outcome.draft.document,
		};
	});

	// /handoff, second half: seed the successor with the reviewed document and
	// move the process binding to it, the same way a fork does.
	options.transport.onRequest(ACP_HANDOFF_COMMIT_METHOD, (params): AcpHandoffCommitResult => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId", "document"]));
		const { control, session, resetForSession } = requireHandoff();
		const bound = getSession(request);
		requireIdle(bound, "hand off");
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const document = handoffDocument(request.document);
		const pending = pendingHandoff;
		if (pending === null || pending.handoffId !== handoffId || pending.sessionId !== bound.id) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		const outcome = control.commit(pending.draft, document);
		if (!outcome.ok) {
			// An empty review is the reviewer's to fix; every other refusal ends the draft.
			if (outcome.code !== "empty") pendingHandoff = null;
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		pendingHandoff = null;
		const toSessionId = outcome.toSessionId;
		const current = session.current();
		if (current?.id !== toSessionId || safeStoredIdentifier(toSessionId, ACP_MAX_SESSION_ID_BYTES) === null) {
			throw new AcpRequestError(-32603, "handoff failed", { code: "internal_error" });
		}
		const successor: AcpServerSession = { ...bound, id: toSessionId, createdAt: current.createdAt, activePrompt: null };
		sessions.delete(bound.id);
		let replay: PreparedAcpReplay | undefined;
		try {
			const restore = prepareRestore(toSessionId, null, "leaf", true);
			resetForSession(null, restore.replayMessages);
			replay = restore.replay;
		} catch (error) {
			options.diagnostics?.(`handoff replay failed: ${acpErrorMessage(error)}`);
			resetForSession(null);
		}
		for (const warning of outcome.warnings) options.diagnostics?.(`handoff: ${warning}`);
		bindRestored(successor, replay);
		return {
			status: "committed" as const,
			sessionId: toSessionId,
			fromSessionId: bound.id,
			warnings: outcome.warnings.slice(0, 8).map((warning) => boundString(warning, ACP_MAX_HANDOFF_REASON_BYTES)),
			...sessionConfig(successor),
			_meta: { [ACP_SESSION_META_KEY]: sessionResultMeta(successor, false) },
		};
	});

	options.transport.onRequest(ACP_HANDOFF_CANCEL_METHOD, (params): AcpHandoffCancelResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId"]));
		requireHandoff();
		const bound = getSession(request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const cancelled = pendingHandoff?.handoffId === handoffId && pendingHandoff.sessionId === bound.id;
		if (cancelled) pendingHandoff = null;
		return { cancelled };
	});

	// /usage: the session's own accounting and each provider's quota. A quota
	// read that throws fails only the quota half; the session numbers still answer.
	options.transport.onRequest(ACP_USAGE_READ_METHOD, async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.usage === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		getSession(request);
		const session = projectSessionUsage(options.usage.session());
		let quota: ReturnType<typeof projectQuota> | { status: "failed"; reason: string };
		try {
			quota = projectQuota(await options.usage.quota());
		} catch (err) {
			quota = { status: "failed", reason: boundString(err instanceof Error ? err.message : String(err), 256) };
		}
		return { version: 1, session, quota };
	});

	// /btw and /draft: one round beside the session at a time, cancellable, and
	// never a turn. The chat loop refuses while a turn is in flight and says so;
	// that refusal is a reported outcome, not a protocol error.
	let asideRound: AbortController | null = null;
	const runAside = async <T>(round: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (asideRound !== null)
			throw new AcpRequestError(-32602, "a side question or draft is already running", { code: "aside_active" });
		const controller = new AbortController();
		asideRound = controller;
		try {
			return await round(controller.signal);
		} finally {
			if (asideRound === controller) asideRound = null;
		}
	};
	const requireAside = () => {
		if (options.aside === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		return options.aside;
	};
	const asideText = (value: unknown, field: string) => {
		const text = typeof value === "string" ? value.trim() : "";
		if (text.length === 0 || text.length > ACP_ASIDE_QUESTION_MAX_CHARS)
			throw new AcpRequestError(-32602, `${field} must be 1 to ${ACP_ASIDE_QUESTION_MAX_CHARS} characters`, {
				code: "invalid_params",
			});
		return text;
	};
	options.transport.onRequest(ACP_ASIDE_ASK_METHOD, async (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "question"]));
		const aside = requireAside();
		getSession(request);
		const question = asideText(request.question, "question");
		return projectAsideAnswer(await runAside((signal) => aside.ask(question, signal)), options.diagnostics);
	});
	options.transport.onRequest(ACP_ASIDE_DRAFT_METHOD, async (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "request", "count"]));
		const aside = requireAside();
		getSession(request);
		const text = asideText(request.request, "request");
		const count = request.count ?? ACP_ASIDE_DRAFT_COUNTS.default;
		if (
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count < ACP_ASIDE_DRAFT_COUNTS.min ||
			count > ACP_ASIDE_DRAFT_COUNTS.max
		)
			throw new AcpRequestError(-32602, `count must be ${ACP_ASIDE_DRAFT_COUNTS.min} to ${ACP_ASIDE_DRAFT_COUNTS.max}`, {
				code: "invalid_params",
			});
		return projectDraftOutcome(await runAside((signal) => aside.draft(text, count, signal)), options.diagnostics);
	});
	options.transport.onRequest(ACP_ASIDE_CANCEL_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		requireAside();
		getSession(request);
		const round = asideRound;
		round?.abort();
		return { cancelled: round !== null };
	});

	// The /extensions view: what this session loaded, never paths or provenance.
	options.transport.onRequest(ACP_EXTENSIONS_LIST_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		return projectExtensions(options.extensions.list());
	});

	// /extensions reload. Hooks and extension resources change together, so a
	// reload waits for a running turn rather than swapping them under it.
	options.transport.onRequest(ACP_EXTENSIONS_RELOAD_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		requireIdle(getSession(request), "reload extensions");
		return projectExtensionReload(options.extensions.reload());
	});

	// /library reload, so a library change made outside this session reaches it.
	// A failed reload is reported as failed; the previous resources stay live.
	options.transport.onRequest(ACP_LIBRARY_RELOAD_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.libraryReload === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		requireIdle(getSession(request), "reload the library");
		try {
			return { status: "refreshed" as const, ...options.libraryReload() };
		} catch (error) {
			options.diagnostics?.(`library reload failed: ${acpErrorMessage(error)}`);
			return { status: "failed" as const, error: boundString(acpErrorMessage(error), 1024) };
		}
	});

	options.transport.onRequest(ACP_CONTEXT_STATUS_METHOD, (params): ContextOperationStatus => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (!options.contextLedger) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		const session = getSession(request);
		if (session.id !== boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		const current =
			contextActivity?.operation?.sessionId === session.id && contextActivity.operation.cwd === canonicalCwd
				? contextActivity
				: null;
		const recorded = [...(options.readSessionEntries?.(session.id) ?? [])].reverse().flatMap((entry) => {
			if (entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE) return [];
			const operation = readContextOperation(entry.data);
			return operation?.outcome && operation.sessionId === session.id && operation.cwd === canonicalCwd ? [operation] : [];
		});
		return {
			version: 1,
			active: current && !current.operation?.outcome ? current : null,
			latest: current?.operation?.outcome ? current.operation : (recorded[0] ?? null),
		};
	});

	// The terminal's /context window view, read and never recomputed.
	options.transport.onRequest(ACP_CONTEXT_LEDGER_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.contextLedger === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		getSession(request);
		try {
			return projectContextLedger(options.contextLedger());
		} catch (error) {
			options.diagnostics?.(`context ledger failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "context ledger could not be read", { code: "internal_error" });
		}
	});

	// The terminal's /view artifacts, from the overlay's own providers.
	const artifactDeps = (request: Record<string, unknown>) => {
		requireInitialized();
		if (options.artifacts === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = getSession(request);
		const deps = options.artifacts.deps(session.id);
		if (deps === null) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		return deps;
	};
	const artifactFailure = (what: string, error: unknown): never => {
		if (error instanceof AcpRequestError) throw error;
		options.diagnostics?.(`artifact ${what} failed: ${acpErrorMessage(error)}`);
		throw new AcpRequestError(-32603, `artifacts could not be ${what === "list" ? "listed" : "read"}`, {
			code: "internal_error",
		});
	};
	options.transport.onRequest(ACP_ARTIFACTS_LIST_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "categories"]));
		const deps = artifactDeps(request);
		const categories = parseArtifactCategories(request.categories);
		try {
			return await listAcpArtifacts(deps, categories);
		} catch (error) {
			return artifactFailure("list", error);
		}
	});
	options.transport.onRequest(ACP_ARTIFACTS_READ_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "id", "offset", "limit", "details"]));
		const deps = artifactDeps(request);
		const read = parseArtifactReadRequest(request);
		try {
			return await readAcpArtifact(deps, read);
		} catch (error) {
			return artifactFailure("read", error);
		}
	});

	const requireFleet = (): AcpFleetControl => {
		if (options.fleet === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		return options.fleet;
	};
	/** A contract name is a file stem under the workspace's fleets, never a path. */
	const fleetName = (value: unknown): string => {
		const name = requireBoundedClientString(value, "name", 128);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name.includes("..")) {
			throw new AcpRequestError(-32602, "name is invalid", { code: "invalid_params" });
		}
		return name;
	};
	const fleetVars = (value: unknown): Record<string, string> => {
		if (value === undefined) return {};
		if (!isRecord(value) || Object.keys(value).length > 32) {
			throw new AcpRequestError(-32602, "vars must be an object of at most 32 strings", { code: "invalid_params" });
		}
		const vars: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value)) {
			if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)) {
				throw new AcpRequestError(-32602, "a variable name is invalid", { code: "invalid_params" });
			}
			vars[key] = requireBoundedClientString(entry, "vars", 4096, { allowEmpty: true });
		}
		return vars;
	};
	const compileFleet = (control: AcpFleetControl, name: string, vars: Record<string, string>) => {
		try {
			return control.preview(name, vars);
		} catch (error) {
			options.diagnostics?.(`fleet preview failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "fleet preview failed", { code: "internal_error" });
		}
	};

	// Compile a named fleet contract for review. Nothing is dispatched, reserved or written.
	options.transport.onRequest(ACP_FLEET_PREVIEW_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars"]));
		const control = requireFleet();
		getSession(request);
		return projectFleetPreview(compileFleet(control, fleetName(request.name), fleetVars(request.vars)));
	});

	// Start the plan the client approved, and only that plan: it is compiled
	// again here and refused before any dispatch when its hash moved.
	options.transport.onRequest(ACP_FLEET_RUN_METHOD, async (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "planHash"]));
		const control = requireFleet();
		const bound = getSession(request);
		// Refused, never queued: an approved plan describes the workspace as it
		// stands, and a turn still in flight is about to change it.
		requireIdle(bound, "start a fleet run");
		const name = fleetName(request.name);
		const vars = fleetVars(request.vars);
		if (typeof request.planHash !== "string" || !/^[0-9a-f]{64}$/u.test(request.planHash)) {
			throw new AcpRequestError(-32602, "planHash is invalid", { code: "invalid_params" });
		}
		const result = compileFleet(control, name, vars);
		if (!result.ok) return projectFleetPreview(result);
		if (result.preview.planHash !== request.planHash) {
			return {
				status: "changed" as const,
				name: projectFleetPreview(result).name,
				planHash: result.preview.planHash,
				reason: "the plan changed since it was previewed; review it again. Nothing was dispatched",
			};
		}
		let started: Awaited<ReturnType<AcpFleetControl["run"]>>;
		try {
			started = await control.run(result.preview);
		} catch (error) {
			options.diagnostics?.(`fleet run failed to start: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "fleet run failed to start", { code: "internal_error" });
		}
		const fleetRootId = boundString(started.fleetRootId, 128);
		if (started.status === "failed") {
			return {
				status: "failed" as const,
				name,
				planHash: result.preview.planHash,
				fleetRootId,
				reason: boundedFleetText(started.reason, ACP_FLEET_MAX_REASON_BYTES),
			};
		}
		return {
			status: "started" as const,
			name,
			planHash: result.preview.planHash,
			fleetRootId,
			stepCount: result.preview.plan.steps.length,
		};
	});

	const requireBoardActions = (): AcpBoardActions => {
		if (options.boardActions === undefined || options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return options.boardActions;
	};

	// The /decisions overlay's `s` and `c`. The record keeps the decision,
	// marked superseded; a correction's turn is returned for the client to send,
	// so it lands in the conversation as the terminal's does.
	options.transport.onRequest(ACP_DECISION_SUPERSEDE_METHOD, (params): AcpDecisionSupersedeResult => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "interviewId", "key", "correction"]));
		const actions = requireBoardActions();
		const bound = getSession(request);
		requireIdle(bound, "revise a decision");
		const interviewId = requireBoundedClientString(request.interviewId, "interviewId", 256);
		const key = requireBoundedClientString(request.key, "key", 1024);
		const correction =
			request.correction === undefined
				? undefined
				: requireBoundedClientString(request.correction, "correction", ACP_MAX_CORRECTION_BYTES).trim();
		if (correction !== undefined && correction.length === 0) {
			throw new AcpRequestError(-32602, "a correction needs the new direction", { code: "invalid_params" });
		}
		try {
			const outcome = actions.supersedeDecision(interviewId, key, correction);
			return {
				status: outcome.status,
				...(outcome.correctionTurn !== undefined ? { correctionTurn: boundString(outcome.correctionTurn, 4096) } : {}),
			};
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});

	// The /memory overlay's `p` and `g`. A proposal is a candidate for review,
	// never an approval; global scope broadens where a lesson applies, so it is
	// refused until the client says the operator acknowledged that.
	options.transport.onRequest(ACP_MEMORY_PROPOSE_METHOD, async (params): Promise<AcpMemoryProposeResult> => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "entryId", "scope", "acknowledgeGlobal"]));
		const actions = requireBoardActions();
		getSession(request);
		const entryId = requireBoundedClientString(request.entryId, "entryId", 256);
		if (request.scope !== "repo" && request.scope !== "global") {
			throw new AcpRequestError(-32602, "scope must be repo or global", { code: "invalid_params" });
		}
		if (request.scope === "global" && request.acknowledgeGlobal !== true) {
			return {
				status: "needs_acknowledgement" as const,
				reason: "global scope broadens where this lesson applies; acknowledge it to propose",
			};
		}
		try {
			const outcome = await actions.proposeMemory(entryId, request.scope);
			return { status: outcome.created ? ("proposed" as const) : ("existing" as const), recordId: outcome.recordId };
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});

	options.transport.onRequest(ACP_SESSION_LABEL_METHOD, (params): AcpEmptyResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "label"]));
		const id = sessionIdOf(request);
		workspaceMeta(id);
		const label = requireBoundedClientString(request.label, "label", ACP_MAX_LABEL_BYTES, { allowEmpty: true });
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.setName(label, id);
		} catch {
			throw new AcpRequestError(-32603, "session label could not be saved", { code: "internal_error" });
		}
		if (sessions.has(id)) {
			options.transport.notify("session/update", {
				sessionId: id,
				update: { sessionUpdate: "session_info_update", title: label.length > 0 ? label : null },
			});
		}
		return {};
	});

	options.transport.onRequest("session/delete", (params): AcpEmptyResult => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const id = sessionIdOf(request);
		const meta = workspaceMeta(id);
		if (sessions.has(id) || meta.endedAt === null) {
			throw new AcpRequestError(-32602, "session may already be open", { code: "session_open" });
		}
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.deleteSession(id);
		} catch {
			throw new AcpRequestError(-32603, "session could not be deleted", { code: "internal_error" });
		}
		return {};
	});

	options.transport.onRequest("session/set_mode", (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "modeId"]));
		const session = getSession(request);
		setAutonomy(session, request.modeId);
		return {};
	});

	options.transport.onRequest(ACP_SESSION_TRUST_METHOD, (params) => {
		requireInitialized();
		requireAuthenticated();
		const session = getSession(assertParamKeys(params, new Set(["sessionId"])));
		return { _meta: trustResultMeta(session.cwd) };
	});

	options.transport.onRequest("session/set_config_option", (params) => {
		requireInitialized();
		requireAuthenticated();
		const request = assertParamKeys(params, new Set(["sessionId", "configId", "value", "type"]));
		const session = getSession(request);
		if (session.activePrompt !== null)
			throw new AcpRequestError(-32602, "cannot change configuration during an active prompt", {
				code: "prompt_active",
			});
		if (request.type !== undefined && request.type !== "select")
			throw new AcpRequestError(-32602, "invalid configuration type", { code: "invalid_params" });
		const value = request.value;
		if (typeof value !== "string")
			throw new AcpRequestError(-32602, "invalid configuration value", { code: "invalid_params" });
		switch (request.configId) {
			case "autonomy":
				setAutonomy(session, value);
				break;
			case "target":
			case "model": {
				if (request.configId === "model" && options.providers === undefined) {
					const modelOption = configOptions(session).find((option) => option.id === "model");
					if (
						!modelOption ||
						!Array.isArray(modelOption.options) ||
						!modelOption.options.some((option) => isRecord(option) && option.value === value)
					)
						throw new AcpRequestError(-32602, "model is not available", { code: "invalid_params" });
					if (session.model !== value) {
						if (!options.setSessionRouting)
							throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
						options.setSessionRouting({ model: value });
						session.model = value;
						notifyConfigOptions(session);
					}
					break;
				}
				if (!options.setSessionRouting || !options.providers)
					throw new AcpRequestError(-32601, "model selection is unavailable", { code: "method_not_found" });
				const target = request.configId === "target" ? value : session.target;
				const status = options.providers.list().find((item) => item.target.id === target);
				if (!target || !status) throw new AcpRequestError(-32602, "target is not available", { code: "invalid_params" });
				const models = safeTargetModels(status);
				const model =
					request.configId === "model" ? value : session.model && models.includes(session.model) ? session.model : models[0];
				if (!model || (!models.includes(model) && !(target === session.target && model === session.model)))
					throw new AcpRequestError(-32602, "model is not available", { code: "invalid_params" });
				try {
					const selected = selectModel(
						options.providers,
						{ target, model, thinkingLevel: session.thinkingLevel },
						options.setSessionRouting,
					);
					session.target = selected.target;
					session.model = selected.model;
					session.thinkingLevel = selected.thinkingLevel;
				} catch {
					throw new AcpRequestError(-32602, "target cannot host this session model", { code: "invalid_params" });
				}
				notifyConfigOptions(session);
				break;
			}
			case "thinkingLevel":
				if (!ACP_THINKING_LEVEL_SET.has(value as AcpThinkingLevel))
					throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
				if (session.thinkingLevel !== value) {
					if (!options.setSessionRouting)
						throw new AcpRequestError(-32601, "thinking selection is unavailable", { code: "method_not_found" });
					const thinkingLevel = clampThinkingLevel(
						options.providers,
						session.target,
						session.model,
						value as AcpThinkingLevel,
					);
					options.setSessionRouting({ thinkingLevel });
					session.thinkingLevel = thinkingLevel;
					notifyConfigOptions(session);
				}
				break;
			default:
				throw new AcpRequestError(-32602, "unknown configuration option", { code: "invalid_params" });
		}
		return { configOptions: configOptions(session) };
	});

	options.transport.onRequest(ACP_SETTINGS_GET_SAFE_METHOD, (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return safeSettingsProjection(options.settings.read());
	});

	options.transport.onRequest(ACP_SETTINGS_PATCH_SAFE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["patch"]));
		if (!isRecord(request.patch)) {
			throw new AcpRequestError(-32602, "patch must be an object", { code: "invalid_params" });
		}
		if (activePromptState !== null) {
			throw new AcpRequestError(-32602, "cannot patch settings during an active prompt", { code: "prompt_active" });
		}
		if (options.settings === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const patch: AcpSafeSettingsPatch = {};
		for (const [key, value] of Object.entries(request.patch)) {
			if (!(ACP_SAFE_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
				throw new AcpRequestError(-32602, "patch contains an unknown setting", { code: "invalid_params" });
			}
			switch (key) {
				case "chat.target": {
					if (value === null) {
						patch[key] = null;
						break;
					}
					const target = requireBoundedClientString(value, key, ACP_MAX_TARGET_ID_BYTES);
					if (options.providers?.getTarget(target) === null || options.providers === undefined) {
						throw new AcpRequestError(-32602, "target is not configured", {
							code: "invalid_params",
							reason: "target-unknown",
						});
					}
					patch[key] = target;
					break;
				}
				case "chat.model":
					patch[key] = value === null ? null : requireBoundedClientString(value, key, ACP_MAX_MODEL_ID_BYTES);
					break;
				case "chat.thinkingLevel":
					if (typeof value !== "string" || !ACP_THINKING_LEVEL_SET.has(value as AcpThinkingLevel)) {
						throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
					}
					patch[key] = value as AcpThinkingLevel;
					break;
				case "safety.autonomy":
					if (!isAutonomyLevel(value)) {
						throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
					}
					patch[key] = value;
					break;
			}
		}
		const current = options.settings.read();
		const nextTarget = patch["chat.target"] === undefined ? current.target : patch["chat.target"];
		const nextModel = patch["chat.model"] === undefined ? current.model : patch["chat.model"];
		if (nextTarget === null && nextModel !== null) {
			throw new AcpRequestError(-32602, "model requires a configured target", { code: "invalid_params" });
		}
		try {
			const committed = options.settings.commit(patch);
			const session = boundSessionId === null ? undefined : sessions.get(boundSessionId);
			if (
				session &&
				(patch["chat.target"] !== undefined ||
					patch["chat.model"] !== undefined ||
					patch["chat.thinkingLevel"] !== undefined)
			) {
				session.target = committed.target;
				session.model = committed.model;
				session.thinkingLevel = committed.thinkingLevel;
				notifyConfigOptions(session);
			}
			return safeSettingsProjection(committed);
		} catch {
			throw new AcpRequestError(-32603, "safe settings could not be updated", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_COMMANDS_LIST_METHOD, (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		const listed = catalog();
		if (listed === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const prompts = options.commands?.promptNames?.();
		return prompts === undefined ? listed : { ...listed, prompts };
	});

	options.transport.onRequest(ACP_COMMANDS_INVOKE_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "argv"]));
		const session = getSession(request);
		if (request.command === "context" || request.command === "compact") requireIdle(session, "run a context operation");
		if (options.commands === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Four of the thirteen put a user turn into the session. Doing that while
		// a prompt is in flight is the steering path, not the submit path: the
		// turn already running owns the stopReason, and a second unrequested
		// submission folds content into it that the client never asked for. Those
		// four are refused here and the client is told to use
		// `_clio-coder/session/steer` instead; the other nine are unaffected.
		if (session.activePrompt !== null && options.commands.injectsUserTurn(request.command)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a prompt is active", {
				code: "prompt_active",
				reason: "steer-instead",
			});
		}
		if (activeShell !== null && options.commands.injectsUserTurn(request.command)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a shell line is running", {
				code: "shell_active",
			});
		}
		// A prompt-turn command asks for approvals that bind to a call on the
		// wire, and outside a prompt there is no turn to put that call in. It is
		// refused here with the path that works, rather than admitted and denied.
		if (options.commands.promptTurn?.(request.command, request.argv) === true) {
			throw new AcpRequestError(-32602, "this command runs as a conversation turn; send it as a prompt", {
				code: "prompt_turn_required",
			});
		}
		if (request.command !== "context" && request.command !== "compact")
			return options.commands.invoke({ command: request.command, argv: request.argv });
		if (session.id !== boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		if (activeShell !== null) throw new AcpRequestError(-32602, "a shell line is running", { code: "shell_active" });
		const command = Promise.resolve().then(() =>
			options.commands?.invoke({ command: request.command, argv: request.argv }),
		);
		contextCommandInFlight = command;
		return command.finally(() => {
			if (contextCommandInFlight === command) contextCommandInFlight = null;
		});
	});

	options.transport.onRequest(ACP_TARGETS_LIST_METHOD, (params): AcpTargetList => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.providers === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const targets: AcpSafeTargetProjection[] = [];
		let budgetExhausted = false;
		// Budget incrementally from the exact JSON representation. Re-serializing
		// the growing full result for every one of up to 4,096 model ids turns a
		// bounded config list into avoidable quadratic work.
		let budgetBytes = ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES;
		for (const status of options.providers.list()) {
			const projected = safeTargetProjection(status);
			if (projected === null) continue;
			const bounded: AcpSafeTargetProjection = { ...projected, models: [] };
			let boundedBytes = utf8Bytes(JSON.stringify(bounded));
			const targetSeparatorBytes = targets.length > 0 ? 1 : 0;
			if (budgetBytes + targetSeparatorBytes + boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
				budgetExhausted = true;
				break;
			}
			targets.push(bounded);
			budgetBytes += targetSeparatorBytes + boundedBytes;
			for (const model of projected.models) {
				const candidateModels = [...bounded.models, model];
				const resolved = resolveRuntimeTarget(options.providers, {
					targetId: projected.id,
					wireModelId: model,
					requestedThinkingLevel: "off",
					use: "orchestrator",
				});
				const thinkingLevels = {
					...bounded.thinkingLevels,
					...(resolved.ok ? { [model]: Array.from(resolved.target.modelRuntime.thinking.supportedLevels) } : {}),
				};
				const candidate = { ...bounded, models: candidateModels, thinkingLevels };
				const candidateBytes = utf8Bytes(JSON.stringify(candidate));
				if (budgetBytes + candidateBytes - boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
					budgetExhausted = true;
					bounded.modelsTruncated = true;
					break;
				}
				bounded.models.push(model);
				bounded.thinkingLevels = thinkingLevels;
				budgetBytes += candidateBytes - boundedBytes;
				boundedBytes = candidateBytes;
			}
			if (budgetExhausted) break;
			if (targets.length === ACP_MAX_TARGETS) break;
		}
		return {
			targets,
			...(budgetExhausted ? { _meta: { [ACP_TRUNCATED_META_KEY]: true } } : {}),
		};
	});

	options.transport.onRequest(ACP_TARGETS_PROBE_METHOD, async (params): Promise<AcpTargetProbe> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["targetId"]));
		const targetId = requireBoundedClientString(request.targetId, "targetId", ACP_MAX_TARGET_ID_BYTES);
		if (options.providers === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (options.providers.getTarget(targetId) === null) {
			throw new AcpRequestError(-32602, "target is not configured", {
				code: "invalid_params",
				reason: "target-unknown",
			});
		}
		try {
			const status = await options.providers.probeTarget(targetId, { reasoning: false });
			if (status === null) return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
			for (const session of sessions.values()) if (session.target === targetId) notifyConfigOptions(session);
			const reason = safeProbeReason(options.providers, status);
			const latencyMs =
				typeof status.health.latencyMs === "number" &&
				Number.isFinite(status.health.latencyMs) &&
				status.health.latencyMs >= 0
					? Math.round(status.health.latencyMs)
					: null;
			return { targetId, healthy: reason === null, latencyMs, reason };
		} catch {
			return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
		}
	});

	const cancelSession = (session: AcpServerSession, reason: string, operationId?: string): boolean => {
		if (operationId !== undefined) {
			if (session.id !== boundSessionId) return false;
			const operation = contextActivity?.operation;
			if (
				!operation ||
				operation.id !== operationId ||
				operation.sessionId !== session.id ||
				operation.cwd !== canonicalCwd ||
				operation.outcome !== undefined
			)
				return false;
			if (
				operation.kind === "context-init" ||
				operation.kind === "context-refresh" ||
				operation.kind === "context-clear"
			) {
				if (options.cancelContextOperation?.(session.id, canonicalCwd, operationId) !== true) return false;
			} else if (operation.kind !== "compaction" && operation.kind !== "context-recover") return false;
		} else if (session.id === boundSessionId) options.cancelContextOperation?.(session.id, canonicalCwd);
		// A shell line never runs beside a prompt, so this stops whichever of the two is running.
		if (activeShell?.sessionId === session.id) activeShell.abort.abort();
		if (activeSessionId === session.id || activeSessionId === null) permission.cancelPending(reason);
		if ((activeSessionId ?? boundSessionId) === session.id) options.interviews?.cancel();
		if (!session.activePrompt) {
			if ((contextCommandInFlight !== null || operationId !== undefined) && session.id === boundSessionId)
				options.chat.cancel();
			return true;
		}
		session.activePrompt.cancelled = true;
		options.chat.cancel();
		return true;
	};

	const contextCancellationId = (params: unknown): string | undefined => {
		if (!isRecord(params) || params._meta === undefined) return undefined;
		if (!isRecord(params._meta))
			throw new AcpRequestError(-32602, "cancel metadata must be an object", { code: "invalid_params" });
		if (!Object.hasOwn(params._meta, ACP_CONTEXT_META_KEY)) return undefined;
		const context = params._meta[ACP_CONTEXT_META_KEY];
		if (!isRecord(context))
			throw new AcpRequestError(-32602, "context cancellation requires operationId", { code: "invalid_params" });
		return requireBoundedClientString(context.operationId, "operationId", 128);
	};
	const cancel = (params: unknown): Record<string, unknown> => {
		requireInitialized();
		const operationId = contextCancellationId(params);
		const cancelled = cancelSession(getSession(params), "prompt cancelled", operationId);
		return operationId === undefined ? {} : { _meta: { [ACP_CONTEXT_META_KEY]: { operationId, cancelled } } };
	};
	options.transport.onRequest("session/cancel", cancel);
	options.transport.onNotification("session/cancel", (params) => {
		// A notification has no reply channel, so an ordering or identity error
		// has nowhere to go. Dropping it silently is the only conformant option.
		if (!handshake.initialized) return;
		const id = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
		const session = id === null ? undefined : sessions.get(id);
		if (session) {
			try {
				cancelSession(session, "prompt cancelled", contextCancellationId(params));
			} catch {
				/* Malformed scoped notifications have no reply channel and must never become generic cancels. */
			}
		}
	});

	/**
	 * Windows in which a steer must not be queued, or null when it may be.
	 *
	 * The engine resubmits a steer it never drained as a fresh prompt
	 * (`resubmitStrandedSteers`). In a terminal that is the right answer; here it
	 * is a prompt-shaped turn the client never requested, whose stop reason has
	 * no request to ride home on. The two windows where stranding is certain are
	 * knowable from the session, so the server refuses in them and says why,
	 * rather than accepting a steer that would come back as an unrequested turn.
	 */
	const steerRefusal = (session: AcpServerSession): string | null => {
		if (session.activePrompt === null) {
			return "no prompt is active on this session; send session/prompt instead of steering";
		}
		if (session.activePrompt.cancelled) {
			return "this prompt is cancelled and its queues are being cleared; prompt again once it returns";
		}
		if (!options.chat.isStreaming()) {
			return "the run is not streaming, so the engine has no slot to drain this steer into";
		}
		return null;
	};

	options.transport.onRequest(ACP_SESSION_STEER_METHOD, async (params): Promise<AcpSteerResult> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "text", "mode"]));
		const session = getSession(request);
		const text = requireSteerText(request.text, "text", ACP_MAX_STEER_TEXT_BYTES);
		if (
			request.mode !== undefined &&
			(typeof request.mode !== "string" || !(ACP_STEERING_MODES as ReadonlyArray<string>).includes(request.mode))
		) {
			throw new AcpRequestError(-32602, "invalid steering mode", { code: "invalid_params" });
		}
		const mode = (request.mode ?? "next-slot") as AcpSteeringMode;
		const queue = mode === "next-slot" ? "steer" : "follow-up";
		const enqueue = mode === "next-slot" ? options.chat.steer : options.chat.queueFollowUp;
		if (enqueue === undefined) {
			return { accepted: false, queue, refusal: "this agent build does not expose the engine steering queues" };
		}
		const refusal = steerRefusal(session);
		if (refusal !== null) return { accepted: false, queue, refusal };
		if (options.chat.discoverOperatorEgg && (await options.chat.discoverOperatorEgg(text)))
			return { accepted: true, queue };
		// The engine's own admission is the last word: it refuses a steer whose
		// run stopped streaming between the check above and this call.
		if (!enqueue.call(options.chat, text)) {
			return { accepted: false, queue, refusal: "the engine refused the message; the run is no longer accepting input" };
		}
		return { accepted: true, queue };
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_METHOD, (params): AcpQueueResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		getSession(request);
		// An empty pair of lists is a fact about the queues, so a build that
		// cannot read them refuses instead of reporting one it did not observe.
		if (options.chat.queuedMessages === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const queued = options.chat.queuedMessages();
		return {
			steer: boundedQueueTexts(queued.steer),
			followUp: boundedQueueTexts(queued.followUp),
			...(options.chat.queueEntries !== undefined ? { entries: projectQueueEntries(options.chat.queueEntries()) } : {}),
		};
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_CLEAR_METHOD, (params): AcpQueueClearResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		getSession(request);
		if (options.chat.clearQueuedFollowUps === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Both queues drain together, exactly as Alt+Q does in the terminal: the
		// returned texts are what the client now owns and must re-send to deliver.
		return { restored: boundedQueueTexts(options.chat.clearQueuedFollowUps()) };
	});

	/** The chat loop's per-entry queue operations, bound, or a refusal when this build has none. */
	const queueControl = () => {
		const chat = options.chat;
		if (
			chat.queueEntries === undefined ||
			chat.removeQueuedEntry === undefined ||
			chat.moveQueuedEntry === undefined ||
			chat.setQueuedEntryKind === undefined
		) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		return {
			entries: chat.queueEntries.bind(chat),
			remove: chat.removeQueuedEntry.bind(chat),
			move: chat.moveQueuedEntry.bind(chat),
			setKind: chat.setQueuedEntryKind.bind(chat),
		};
	};

	options.transport.onRequest(ACP_QUEUE_EDIT_METHOD, (params): AcpQueueEditResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "id", "op", "delta", "kind"]));
		const session = getSession(request);
		const queue = queueControl();
		const id = requireBoundedClientString(request.id, "id", ACP_MAX_QUEUE_ENTRY_ID_BYTES);
		if (typeof request.op !== "string" || !(ACP_QUEUE_EDIT_OPS as ReadonlyArray<string>).includes(request.op)) {
			throw new AcpRequestError(-32602, `op must be one of ${ACP_QUEUE_EDIT_OPS.join(", ")}`, {
				code: "invalid_params",
			});
		}
		const op = request.op as AcpQueueEditOp;
		// Each operand belongs to one op. Accepting it on another would promise
		// an effect that op never has.
		if (
			(request.delta !== undefined) !== (op === "move") ||
			(op === "move" && request.delta !== -1 && request.delta !== 1)
		) {
			throw new AcpRequestError(-32602, "move takes delta -1 or 1, and no other op takes delta", {
				code: "invalid_params",
			});
		}
		if (
			(request.kind !== undefined) !== (op === "set_kind") ||
			(op === "set_kind" && request.kind !== "steer" && request.kind !== "follow-up")
		) {
			throw new AcpRequestError(-32602, "set_kind takes kind steer or follow-up, and no other op takes kind", {
				code: "invalid_params",
			});
		}
		// Every answer carries the queue as it now stands, so a client redraws
		// from the reply and never from its own guess at what the op did.
		const answer = (fields: Omit<AcpQueueEditResult, "entries">): AcpQueueEditResult => ({
			...fields,
			entries: projectQueueEntries(queue.entries()),
		});
		const stale = () => answer({ applied: false, reason: "stale-entry" });
		if (!queue.entries().some((entry) => entry.id === id)) return stale();
		switch (op) {
			case "remove":
				return queue.remove(id, "removed") === null ? stale() : answer({ applied: true });
			case "restore": {
				// The terminal's `e`: the entry leaves the queue and its text is the client's draft again.
				const taken = queue.remove(id, "to-editor");
				return taken === null
					? stale()
					: answer({ applied: true, text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES) });
			}
			case "move":
				return queue.move(id, request.delta as -1 | 1)
					? answer({ applied: true })
					: answer({ applied: false, reason: "at-edge" });
			case "set_kind":
				return queue.setKind(id, request.kind as AcpQueuedEntryKind) ? answer({ applied: true }) : stale();
			case "send_now": {
				const active = session.activePrompt;
				if (active === null) return answer({ applied: false, reason: "no-active-prompt" });
				if (active.cancelled || !active.acceptsContinuation) return answer({ applied: false, reason: "prompt-ending" });
				if (!options.chat.isStreaming()) return answer({ applied: false, reason: "not-streaming" });
				const refusal = options.chat.interruptRefusal?.() ?? null;
				const taken = queue.remove(id, "sent-now");
				if (taken === null) return stale();
				// The navigator's Enter: the entry leaves the queue and is resubmitted
				// as an interrupt. The chat loop cancels the run, holds the rest of the
				// queue for the fresh prompt and starts it. When it refuses the
				// interrupt (an attached dispatch, a parked permission ask) it puts the
				// text at the head of the steering queue instead, with a notice.
				const run = options.chat.submit(taken.text, {
					steering: "interrupt",
					...(taken.display !== undefined ? { display: taken.display } : {}),
					...(taken.referencedPaths !== undefined && taken.referencedPaths.length > 0
						? { workingContextPaths: [...taken.referencedPaths] }
						: {}),
				});
				// Observed here so a rejection that lands before the prompt handler
				// reaches its continuation is not reported as unhandled; the handler
				// still awaits `run` and records the failure on the turn.
				run.catch(() => {});
				const previous = active.continuation;
				active.continuation = previous === null ? run : Promise.all([previous, run]).then(() => {});
				return answer({
					applied: true,
					delivery: refusal === null ? "interrupt" : "next-slot",
					text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES),
					...(refusal !== null ? { refusal } : {}),
				});
			}
		}
	});

	options.transport.onRequest(ACP_SESSION_SHELL_METHOD, async (params): Promise<AcpShellResult> => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "excludeFromContext"]));
		const session = getSession(request);
		const label = options.labelOperatorCommand;
		const durable = options.session;
		const resetForSession = options.chat.resetForSession;
		if (label === undefined || durable === undefined || resetForSession === undefined || !branchesWired(options)) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const command = requireShellCommand(request.command);
		if (request.excludeFromContext !== undefined && typeof request.excludeFromContext !== "boolean") {
			throw new AcpRequestError(-32602, "excludeFromContext must be a boolean", { code: "invalid_params" });
		}
		const excludeFromContext = request.excludeFromContext === true;
		if (closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		// The terminal's two admission guards. A turn's context would change
		// underneath it when the line's entry lands, and one line runs at a time.
		if (session.activePrompt !== null || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "a turn is running; cancel it before running a shell line", {
				code: "prompt_active",
			});
		}
		if (contextCommandInFlight !== null || activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is already running; cancel it first", { code: "shell_active" });
		}
		if (durable.current()?.id !== session.id) durable.resume(session.id);
		const abort = new AbortController();
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		activeShell = { sessionId: session.id, abort, settled };
		// The line is the operator's, not the agent's: its frames carry this key
		// instead of agent attribution, and the same call shape a `bash` row has.
		const meta = { [ACP_SHELL_META_KEY]: { version: 1, excludeFromContext } };
		const toolCallId = `shell_${randomUUID()}`;
		const title = boundString(command, ACP_MAX_TOOL_TITLE_BYTES);
		const notify = (update: Record<string, unknown>): void => {
			try {
				options.transport.notify("session/update", { sessionId: session.id, update, _meta: meta });
			} catch {
				options.diagnostics?.("failed to send a shell line update");
			}
		};
		// The tool-progress opt-in and its bounds, applied to the line's cumulative output tail.
		let frames = 0;
		let lastSentAt = Number.NEGATIVE_INFINITY;
		let lastText = "";
		const onUpdate = (progress: BashCommandProgress): void => {
			const text = shellOutputTail(combineBashOutput(progress));
			const sentAt = now();
			if (
				text.length === 0 ||
				text === lastText ||
				frames >= ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL ||
				sentAt - lastSentAt < ACP_MIN_TOOL_PROGRESS_INTERVAL_MS
			) {
				return;
			}
			frames += 1;
			lastSentAt = sentAt;
			lastText = text;
			notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content: toolCallContent(text) });
		};
		try {
			const parentTurnId = durable.tree().leafId ?? null;
			notify({
				sessionUpdate: "tool_call",
				toolCallId,
				name: "shell",
				title,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolCallStatus,
				rawInput: { command, excludeFromContext },
			});
			let entry: SessionEntry;
			let run: Awaited<ReturnType<typeof runOperatorShellLine>>;
			try {
				run = await runOperatorShellLine({
					command,
					cwd: session.cwd,
					excludeFromContext,
					parentTurnId,
					signal: abort.signal,
					label,
					...(handshake.toolProgressEnabled ? { onUpdate } : {}),
				});
				if (run.unlabeled !== null) options.diagnostics?.(`shell output kept out of context: ${run.unlabeled}`);
				entry = durable.appendEntry(run.entry);
				// As in the terminal: the entry stays anchored where the line started,
				// and the context is rebuilt from the leaf the session has now.
				const leafTurnId = durable.tree().leafId ?? parentTurnId;
				resetForSession.call(
					options.chat,
					leafTurnId,
					prepareRestore(session.id, leafTurnId, "leaf", false).replayMessages,
				);
			} catch (err) {
				options.diagnostics?.(`shell line failed: ${acpErrorMessage(err instanceof Error ? err.message : String(err))}`);
				notify({ sessionUpdate: "tool_call_update", toolCallId, title, kind: "execute", status: "failed" });
				throw new AcpRequestError(-32603, "the shell line could not be run or recorded", { code: "shell_failed" });
			}
			const output = shellOutputTail(entry.kind === "bashExecution" ? entry.output : run.entry.output);
			const { result } = run;
			const settledResult = {
				exitCode: result.exitCode,
				cancelled: result.aborted,
				timedOut: result.timedOut,
				truncated: run.entry.truncated,
				excludedFromContext: run.entry.excludeFromContext === true,
				...(run.unlabeled !== null ? { unlabeled: true } : {}),
			};
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: (result.exitCode === 0 && !result.aborted && !result.timedOut
					? "completed"
					: "failed") satisfies AcpToolCallStatus,
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: settledResult,
			});
			return { turnId: entry.turnId, ...settledResult, output, outputBytes: result.outputBytes };
		} finally {
			if (activeShell?.abort === abort) activeShell = null;
			settle();
		}
	});

	options.transport.onRequest(ACP_SESSION_INTERRUPT_METHOD, (params): AcpInterruptResult => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "reason"]));
		const session = getSession(request);
		const reason =
			request.reason === undefined
				? null
				: requireBoundedClientString(request.reason, "reason", ACP_MAX_INTERRUPT_REASON_BYTES);
		if (session.activePrompt === null) {
			return { cancelled: false, refusal: "no prompt is active on this session" };
		}
		// An attached dispatch or a parked permission ask refuses the interrupt in
		// the terminal too. Honour that here instead of cancelling anyway: the
		// client gets the reason to show, and `session/cancel` remains the
		// unconditional stop for a client that means to pay the cost.
		const refusal = options.chat.interruptRefusal?.() ?? null;
		if (refusal !== null) return { cancelled: false, refusal };
		// Cancel only. The outstanding `session/prompt` returns
		// `stopReason: "cancelled"`, and the next prompt is the client's to send;
		// a server-side resubmit would start a turn with no request to answer.
		cancelSession(session, reason === null ? "prompt interrupted by client" : `client interrupt: ${reason}`);
		return { cancelled: true };
	});

	options.transport.onRequest(ACP_DISPATCH_STEER_METHOD, (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "runId", "action", "message"]));
		getSession(request);
		const runId = requireBoundedClientString(request.runId, "runId", ACP_MAX_DISPATCH_ID_BYTES);
		if (request.action !== "guide" && request.action !== "cancel") {
			throw new AcpRequestError(-32602, "action must be guide or cancel", { code: "invalid_params" });
		}
		if (request.action === "cancel" && request.message !== undefined) {
			// An abort carries no operator text anywhere in dispatch, so accepting
			// one here would promise the worker a message it never receives.
			throw new AcpRequestError(-32602, "cancel carries no message", { code: "invalid_params" });
		}
		const dispatch = options.dispatch;
		if (dispatch === undefined) return { accepted: false, reason: "dispatch-unavailable" };
		if (request.action === "cancel") {
			// `abort` reports nothing, so the fact has to be established before it
			// is claimed: an abort against an id this fleet never ran would poison
			// that control root for a future attempt and still answer "accepted".
			let live = false;
			try {
				const snapshot = dispatch.snapshot();
				live = snapshot.running.some((run) => run.runId === runId) || snapshot.retrying.some((run) => run.runId === runId);
			} catch {
				return { accepted: false, reason: "fleet-unavailable" };
			}
			if (!live) return { accepted: false, reason: "run-not-active" };
			try {
				dispatch.abort(runId);
			} catch {
				return { accepted: false, reason: "cancel-failed" };
			}
			return { accepted: true };
		}
		const message = requireSteerText(request.message, "message", ACP_MAX_STEER_TEXT_BYTES);
		try {
			dispatch.steer(runId, message);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			options.diagnostics?.(`dispatch steer refused: ${acpErrorMessage(detail)}`);
			return { accepted: false, reason: dispatchSteerReason(detail) };
		}
		// Queued, not delivered. The frame is on the worker's stdin; the worker
		// acknowledges acceptance later with `clio_coder_steer_received`, and that
		// ack's `sequence` never returns through this contract, so no sequence is
		// reported rather than a guessed one.
		return { accepted: true };
	});

	options.transport.onRequest("session/close", (params) => {
		requireInitialized();
		const id = sessionIdOf(params);
		// Idempotent: a client tearing down cannot always know whether the server
		// already dropped the session, and a second close is not an error.
		if (!sessions.has(id) && closedSessionIds.has(id)) return {};
		const inFlightClose = closingSessions.get(id);
		if (inFlightClose) return inFlightClose;
		const session = getSession(params);
		const close = (async (): Promise<Record<string, never>> => {
			// The prompt writer must settle before the durable session is closed.
			cancelSession(session, "session closed");
			if (session.activePrompt) {
				if (promptSettled) await promptSettled;
			}
			if (contextCommandInFlight !== null && session.id === boundSessionId)
				await contextCommandInFlight.catch(() => undefined);
			// The aborted line still appends its entry; the ledger must outlive that write.
			if (activeShell?.sessionId === session.id) await activeShell.settled;
			if (options.session?.current()?.id === session.id) await options.session.close();
			await options.mcpCapabilities?.detachClientServers();
			sessions.delete(session.id);
			if (boundSessionId === session.id) boundSessionId = null;
			sessionCreated = false;
			closedSessionIds.add(session.id);
			return {};
		})();
		closingSessions.set(id, close);
		void close.then(
			() => closingSessions.delete(id),
			() => closingSessions.delete(id),
		);
		return close;
	});

	options.transport.onRequest("session/prompt", async (params): Promise<AcpPromptResponse> => {
		requireInitialized();
		requireAuthenticated();
		const session = getSession(params);
		if (contextCommandInFlight !== null || session.activePrompt || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "this session already has an active prompt", { code: "prompt_active" });
		}
		// The line rebuilds the chat's context when it settles, which aborts a
		// run in flight, so a turn waits for it exactly as it waits for a turn.
		if (contextCommandInFlight !== null || activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is running; wait for it or cancel it first", {
				code: "shell_active",
			});
		}
		const text = promptText(params);
		const resources = promptResources(params);
		if (text.length === 0 && resources.names.length === 0)
			throw new AcpRequestError(-32602, "prompt text is required", { code: "invalid_params" });
		const images = promptImages(params);
		// A line that names an admitted command is invoked below; anything else
		// that looks like one is screened before it can reach the model.
		const typed = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/u.exec(text.trim())?.[1];
		const screened =
			text.length === 0 || (typed !== undefined && availableCommands().some((entry) => entry.name === typed))
				? undefined
				: options.commands?.screenPrompt?.(text);
		if (screened?.kind === "refuse") throw new AcpRequestError(-32602, screened.message, { code: screened.code });
		const sentText = screened?.kind === "send" ? screened.text : text;
		if (images.length > 0 && options.expandPrompt === undefined)
			throw new AcpRequestError(-32602, "this agent does not accept image blocks", { code: "invalid_params" });
		// Check the same credential authority as the runtime, without resolving or
		// echoing a secret. Desktop services do not inherit a terminal's API keys.
		const targetId = routingSnapshot().target;
		const target = targetId ? options.providers?.getTarget(targetId) : undefined;
		const runtime = target ? options.providers?.getRuntime(target.runtime) : undefined;
		if (target && runtime && options.providers && !options.providers.auth.statusForTarget(target, runtime).available) {
			throw new AcpRequestError(-32000, "credentials for the selected target are unavailable", {
				code: "prompt_not_admitted",
				reason: "authentication-required",
			});
		}
		if (options.session?.current()?.id !== session.id && options.session) options.session.resume(session.id);
		// A reviewed document describes the conversation as it stood; a new request moves it.
		pendingHandoff = null;
		promptSerial++;
		const active = createActivePromptState({ enabled: handshake.toolProgressEnabled, now });
		session.activePrompt = active;
		activePromptState = active;
		activeSessionId = session.id;
		// Transport close waits on this so the session store never stops while the
		// chat loop is still persisting an aborted turn.
		let settle: () => void = () => {};
		promptSettled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		telemetry.turnStarted(active.usage);
		const onTurnEvent = (event: AcpServerEvent) => {
			handleChatEvent(event, options.transport, session.id, active, canonicalCwd, options.diagnostics, () => {
				permission.cancelPending("tool call limit exceeded");
				options.toolRegistry?.cancelParkedCalls("tool call limit exceeded");
				options.chat.cancel();
			});
			observeTelemetry(telemetry, event, active);
		};
		const unsubscribeChat = options.chat.onEvent(onTurnEvent);
		const unsubscribeHost = options.hostToolEvents?.onEvent(onTurnEvent);
		const unsubscribe = () => {
			unsubscribeChat();
			unsubscribeHost?.();
		};
		try {
			const trimmed = text.trim();
			const commandMatch = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/u.exec(trimmed);
			const command = commandMatch?.[1];
			if (screened?.kind === "reference") {
				// A display-only template is for the operator: no turn, no session entry, no tokens.
				sendTextChunks(options.transport, session.id, active, "agent_message_chunk", screened.lines.join("\n"));
				active.sawTurnEnd = true;
			} else if (
				command !== undefined &&
				resources.names.length === 0 &&
				availableCommands().some((entry) => entry.name === command)
			) {
				const argv = commandMatch?.[2]?.trim().split(/\s+/u) ?? [];
				const result = await options.commands?.invoke({ command, argv });
				if (options.commands?.injectsUserTurn(command)) await options.chat.whenSettled?.();
				if (result !== undefined)
					sendTextChunks(
						options.transport,
						session.id,
						active,
						"agent_message_chunk",
						`${active.sentAssistantChars > 0 ? "\n\n" : ""}${result.lines.join("\n")}`,
					);
				if (result?.level === "error" && options.commands?.injectsUserTurn(command)) {
					active.errored = true;
					active.errorMessage = result.lines.join("\n");
				}
				active.sawTurnEnd = true;
			} else if (options.chat.discoverOperatorEgg && (await options.chat.discoverOperatorEgg(promptText(params, false)))) {
				active.sawTurnEnd = true;
			} else if (options.expandPrompt === undefined) {
				await options.chat.submit(withResources(sentText, resources));
			} else {
				let expansion: AcpPromptExpansion;
				try {
					expansion = await options.expandPrompt(sentText, images);
				} catch (err) {
					throw new AcpRequestError(-32602, err instanceof Error ? err.message : String(err), {
						code: "invalid_params",
					});
				}
				// The transcript paints what the operator typed and names attached files, not their bodies.
				if (resources.names.length > 0) {
					const attached = `attached ${resources.names.length} ${resources.names.length === 1 ? "file" : "files"}: ${resources.names.join(", ")}`;
					expansion = {
						...expansion,
						text: withResources(expansion.text, resources),
						display: {
							text: expansion.display?.text ?? sentText,
							note: expansion.display?.note ? `${expansion.display.note}; ${attached}` : attached,
						},
					};
				}
				await options.chat.submit(expansion.text, {
					...(expansion.images.length > 0 ? { images: expansion.images } : {}),
					...(expansion.workingContextPaths.length > 0 ? { workingContextPaths: expansion.workingContextPaths } : {}),
					...(expansion.pendingSkillRequests.length > 0 ? { pendingSkillRequests: expansion.pendingSkillRequests } : {}),
					...(expansion.display ? { display: expansion.display } : {}),
				});
			}
			// A queue send-now interrupted the run this request started and
			// resubmitted the entry. This request carries that run to its end, so
			// it is never a turn with no request to report its stop reason on.
			while (active.continuation !== null) {
				const next = active.continuation;
				active.continuation = null;
				await next;
			}
		} catch (err) {
			if (err instanceof AcpRequestError) throw err;
			active.errored = true;
			active.errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			active.acceptsContinuation = false;
			unsubscribe();
			// The last meter and plan frames precede the response they total.
			await telemetry.turnSettled();
			if (session.activePrompt === active) session.activePrompt = null;
			if (activePromptState === active) activePromptState = null;
			if (activeSessionId === session.id) {
				activeSessionId = null;
				options.onActiveSessionAutonomyChange?.(null);
			}
			promptSettled = null;
			settle();
		}
		// Expiry is not a delayed denial or an operator cancellation. It aborts
		// the run and fails the prompt so the model cannot react to/retry it.
		if (active.permissionExpired) {
			settleOpenToolCalls(options.transport, session.id, active, "permission approval expired");
			throw new AcpRequestError(-32800, "permission approval expired", { code: "permission_expired" });
		}
		// W001-A1: a peer that holds bounded per-turn state must never see a
		// 129th tool start. This is a normal ACP agent-side request ceiling, not a
		// provider failure or an operator cancellation.
		if (active.toolCallLimitReached) {
			settleOpenToolCalls(options.transport, session.id, active, "tool call limit exceeded");
			return promptResponse("max_turn_requests", active);
		}
		// Operator cancellation takes precedence over ordinary turn outcomes.
		if (active.cancelled) {
			settleOpenToolCalls(options.transport, session.id, active, "cancelled");
			return promptResponse("cancelled", active);
		}
		// The empty-success defect: Clio refused to start the turn, the notice
		// carrying the reason has no ACP equivalent, and nothing else in the turn
		// distinguishes the refusal from a model that chose to say nothing. The
		// reason travels as a code; the notice text carries the settings path and
		// stays off the wire.
		if (active.admissionReason !== undefined && !active.sawTurnEnd && active.updatesSent === 0) {
			throw new AcpRequestError(
				active.admissionReason === "authentication-required" ? -32000 : -32603,
				`Clio could not admit this prompt: ${active.admissionReason}`,
				{
					code: "prompt_not_admitted",
					reason: active.admissionReason,
				},
			);
		}
		// ACP has no error StopReason: a failed turn is signalled by failing the
		// session/prompt request itself.
		if (active.errored) {
			settleOpenToolCalls(options.transport, session.id, active, "turn failed");
			// Provider prose never reaches the wire. Bounding it was not enough: a
			// provider error body legitimately quotes a request URL, a filesystem
			// path, or the credential it was rejected for, and a bounded copy of a
			// secret is still the secret. The client gets host-authored text plus
			// the `turn_failed` code; the original goes to the stderr tail.
			if (active.errorMessage !== undefined) {
				options.diagnostics?.(`turn failed: ${acpErrorMessage(active.errorMessage)}`);
			}
			throw new AcpRequestError(-32603, ACP_TURN_FAILED_MESSAGE, { code: "turn_failed" });
		}
		return promptResponse(active.stopReason, active);
	});

	const detachInterviews = options.interviews?.attach({
		transport: options.transport,
		sessionId: () => activeSessionId ?? boundSessionId,
		enabled: () => handshake.initialized && handshake.interviewsEnabled,
		timeoutMs: permissionTimeoutMs,
		...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
	});
	options.onReady?.();
	return await new Promise<number>((resolve) => {
		options.transport.onClose(() => {
			telemetry.dispose();
			detachInterviews?.();
			permission.unregister();
			unsubscribeEventStream();
			permission.cancelPending("ACP transport closed");
			unsubscribeQueueEvents();
			for (const session of sessions.values()) cancelSession(session, "ACP transport closed");
			const settling = [promptSettled, activeShell?.settled ?? null].filter(
				(pending): pending is Promise<void> => pending !== null,
			);
			if (settling.length === 0) {
				resolve(0);
				return;
			}
			const inFlight = Promise.all(settling);
			// The prompt handler owns the chat loop's settlement; resolving the
			// serve promise before it returns lets the orchestrator stop domains
			// under a live writer. The bound keeps a wedged turn from holding the
			// process open forever.
			const timer = setTimeout(() => resolve(0), ACP_PROMPT_SETTLE_BOUND_MS);
			timer.unref?.();
			void inFlight.then(() => {
				clearTimeout(timer);
				resolve(0);
			});
		});
	});
}

/** PromptResponse is `{ stopReason, _meta? }`; usage is not an ACP v1 field. */
function promptResponse(stopReason: string, active: ActivePrompt): AcpPromptResponse {
	return {
		stopReason,
		_meta: {
			[ACP_USAGE_META_KEY]: turnUsageMeta(active.usage),
			[ACP_TURN_META_KEY]: {
				...(active.model ? { model: active.model } : {}),
				...(active.ttftMs !== undefined ? { ttftMs: active.ttftMs } : {}),
				...(active.generationMs && active.timedOutputTokens
					? { outputTokensPerSecond: active.timedOutputTokens / (active.generationMs / 1000) }
					: {}),
			},
		},
	};
}

export type AcpPromptContent = AcpContentBlock[];
