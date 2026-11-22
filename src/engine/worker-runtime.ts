import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
	AnthropicMessagesCompat,
	Context,
	OpenAIResponsesCompat,
	SystemMessage,
	Tool,
} from "@earendil-works/pi-ai";
import { getToolStateChanges } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { assistantMessageNeverSent } from "../core/assistant-model.js";
import { classifyCallFailure, trackCallFetch } from "../core/call-failure.js";
import { createHostPolicyMessage } from "../core/host-policy-message.js";
import { snapshotModelInfo } from "../core/model-tier.js";
import { isProviderAuthRejection } from "../core/provider-auth-error.js";
import { EXPLORATION_TOOL_NAMES } from "../core/read-only-calls.js";
import { systemReminderBlock } from "../core/reminder-framing.js";
import { requestedThinking } from "../core/telemetry/call-effort.js";
import type { WorkerTelemetryContext } from "../core/telemetry/context.js";
import { observedToolCallOrigin, withTelemetryContext } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { hasTokenUsageCounts, normalizeTokenUsage } from "../core/token-split.js";
import type { WorkerContextSeed } from "../domains/context/worker/contract.js";
import { createWorkerContextGuard, WorkerContextExhaustedError } from "../domains/context/worker/pressure.js";
import { createWorkerObservationStore } from "../domains/context/worker/recall.js";
import { compactionBudget, resolveEffectivePricing } from "../domains/providers/catalog.js";
import { confirmationRuleOf } from "../domains/safety/decision-events.js";
import type { WorkerFlowPolicyInput } from "../domains/safety/information-flow.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import { abortReasonCause } from "../domains/telemetry/call-facts.js";
import { seededWorkerMessages, seedRecallLineage } from "../worker/context-seed.js";
import { engineStreamSimple } from "./api-registry.js";
import { workerCacheFamilyId } from "./apis/cache-family.js";
import { anchorContextAtInputTokens, requestOutputReserve } from "./apis/output-budget.js";
import { normalizeContext, resolvedRequestContext } from "./context.js";
import { disableCopilotConversationResume } from "./copilot/session-fs.js";
import { retryStreamOnceOnAuthRejection } from "./oauth-retry-stream.js";
import { retryStreamOnceOnOverflow } from "./overflow-retry-stream.js";
import { boundWorkerResponse } from "./worker-response-stream.js";
/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved TargetDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. HTTP/native
 * runtimes stay pi-agent-backed; sanctioned external runtimes branch to their
 * own worker runners before pi-agent model synthesis.
 */

import path from "node:path";
import { Type } from "typebox";
import {
	configureGuardrails,
	guardrailValuesFromSettings,
	isWorkerToolCallCapExceededReason,
	isWorkerToolCallCapSynthesisReason,
} from "../core/guardrails.js";
import { parseJsonObjectPayload } from "../core/json-payload.js";
import {
	isResponseSchemaRejection,
	responseFormatFor,
	responseSchemaDialectFor,
	runtimeSpeaksResponseSchemaDialect,
} from "../core/response-schema.js";
import { workerSandboxReadableRoots } from "../core/sandbox/worker-process.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { agentSkillToolPolicy } from "../core/skill-activation.js";
import { isMcpToolName, type ToolName, ToolNames } from "../core/tool-names.js";
import {
	gateCitationViolation,
	internalHelperResultSchema,
	type ObservedReadRanges,
	type ObservedRunEffects,
	parseWorkerResultContract,
	RESULT_CONTRACT_REPAIR_LIMIT,
	RESULT_CONTRACT_REPAIR_TOOL,
	type ResultContract,
	resultContractEvidenceShortfall,
	resultContractReminder,
	resultContractRepairMessages,
	resultContractRepairUserMessage,
	resultContractResponseSchema,
	resultContractShape,
	type StructuredHelperResult,
	unobservedExplorerReportReason,
	validateResultContract,
	validateStructuredHelperResult,
} from "../domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../domains/agents/result-contract-filesystem.js";
import type { AgentProduct } from "../domains/agents/spec.js";
import { HANDBACK_CONTEXT_SHARE, HANDBACK_NOTE_SHARE, WALL_HANDBACK_SHARE } from "../domains/dispatch/handback.js";
import type { RunRole } from "../domains/dispatch/obligation.js";
import type { RunLimits } from "../domains/dispatch/run-limits.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import { createMiddlewareToolChoiceControl, createReadStreakRegistration } from "../domains/middleware/index.js";
import { shouldRequestStalledTurnContinuation } from "../domains/middleware/stalled-turn.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import type { AuthResolution } from "../domains/providers/auth/storage.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import type {
	CapabilityFlags,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import { applyModelCapabilityPatch, resolveModelRuntimeCapabilitiesForModel } from "../domains/providers/index.js";
import { createProfileKnowledgeBase } from "../domains/providers/profile-knowledge.js";
import type { KnowledgeBase } from "../domains/providers/types/knowledge-base.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { ApprovalAuthority } from "../domains/safety/admission.js";
import { describeCallTarget, WORKER_CALL_TARGET_MAX_CHARS } from "../domains/safety/call-target.js";
import { describeBashCallConsequences } from "../domains/safety/command-consequence.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { grantEffectDescriptor, grantEffectDigest } from "../domains/safety/grant-effect.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	flowTransferRefusal,
	mergeFlowRestrictions,
	resolveModelDestination,
} from "../domains/safety/information-flow.js";
import { setValidationWrappers } from "../domains/safety/protected-artifacts.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import {
	createRunEffectsRecorder,
	recordToolExecutionEffects,
	sessionChangesTree,
} from "../domains/safety/run-effects.js";
import type {
	WorkerGitAllowance,
	WorkerMcpAttestation,
	WorkerPermitAllowance,
} from "../domains/safety/worker-permit.js";
import { resolveAgentTools, type ToolTelemetry } from "../tools/agent-tools.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../tools/gateway/index.js";
import { createWorkerGitContext } from "../tools/git-exec.js";
import { runObservationPool } from "../tools/observation.js";
import { CODE_NAV_TASK_STEERING, codeNavTaskSteering, type ToolProfileName } from "../tools/profiles.js";
import type { GrantExecutionEvent, RegistryDeps } from "../tools/registry.js";
import {
	CHAIN_OUTPUT_TRUNCATED_MARKER,
	effectiveToolCall,
	type GatewayChainReceipt,
	gatewayChainReceipts,
} from "../tools/surface.js";
import type { TaskWorktree } from "../tools/task-worktree.js";
import {
	clearTaskGates,
	configureWorkerTaskGates,
	contractDeclaresTaskGates,
	isTaskGateCall,
} from "../tools/verify/task-gates.js";
import {
	type AgentLedgerPort,
	canonicalJson,
	permissionHoldBackstopAt,
	type WorkerExtensionHook,
	type WorkerGrantRequestFrame,
} from "../worker/protocol.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	WORKER_EXIT_PERMISSION_REQUIRED,
	WORKER_PROVIDER_HTTP_STATUS_MARKER,
	WORKER_REFUSAL_LIMIT,
	type WorkerBudget,
	type WorkerEscalationConfig,
	type WorkerPromptMessage,
	type WorkerProtectedArtifactState,
} from "../worker/spec-contract.js";
import type { WorkerDecisionBinding } from "../worker/stdin-demux.js";
import { createEngineAgent, type EngineAgentOptions } from "./agent.js";
import { registerFauxFromEnv } from "./ai.js";
import { registerClioApiProviders, setGlobalDefaultMaxOutputTokens } from "./apis/index.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { observeExternalWorkerRun } from "./external-call-telemetry.js";
import { startExternalCliWorkerRun } from "./external-cli/connectors.js";
import {
	callRepeatsAsRead,
	createLoopGuardRegistration,
	isLockedSynthesisFallbackOnly,
	isLoopGuardSynthesisBackstopReason,
	lockedSynthesisDirective,
	lockedSynthesisFallbackText,
	lockedSynthesisRepromptMessages,
	resolveDeliveryTools,
	sanitizeLockedSynthesisMessage,
	withLockedSynthesisDirective,
	withRequestTailDirective,
	workerLoopBlockBudget,
} from "./loop-guard.js";
import { registerClioOAuthProviders } from "./oauth.js";
import {
	applyToolRounds,
	deterministicSampling,
	streamToolRound,
	supportsNamedToolChoice,
} from "./provider-payload.js";
import { createRunPhase, type HandbackTrigger } from "./run-phase.js";
import type { AgentEvent, AgentMessage, EngineModel } from "./types.js";
import { createWorkerCallTelemetry } from "./worker-call-telemetry.js";
import type { ClioWorkerEvent } from "./worker-events.js";
import { createWorkerExtensionHookRegistrations, type WorkerHookTransport } from "./worker-extension-hooks.js";
import type { WorkerRefusal } from "./worker-refusals.js";
import {
	describeWorkerRefusal,
	formatWorkerRefusal,
	outsideWorkspaceHint,
	WORKER_REFUSAL_REPORT_BLOCK,
	workerRefusalLimitReason,
	workerRefusalReportDirective,
} from "./worker-refusals.js";
import { createThrashOutcome } from "./worker-thrash-outcome.js";
import { createWorkerSafety, createWorkerToolRegistry, INTERNAL_HELPER_RESULT_TOOL } from "./worker-tools.js";

/** Room left for the frame envelope under the 16 KiB control-lane bound, counted in the UTF-8 bytes the host limit counts. */
const GRANT_REQUEST_FRAME_BUDGET_BYTES = 14 * 1024;

/** Exact call and enforced permission conditions; never reuse an answer across asking axes. */
/** Bound on the description a grant frame carries; the judge reads fewer characters still. */
const GRANT_MCP_DESCRIPTION_CHARS = 1000;
/**
 * Characters of a refused terminal result sent to the parent, well past the
 * feed's own bound so the parent redacts before anything it keeps is cut.
 */
const REJECTED_HELPER_RESULT_MAX_CHARS = 16 * 1024;

/**
 * APIs whose request renders the reasoning effort ahead of the input, so a locked round there keeps the run's level.
 * On copilot-sdk a changed effort is a setModel on the live session, after which Copilot read none of its cached
 * prefix (M-20).
 */
const REASONING_PREFIX_APIS: ReadonlySet<string> = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"copilot-sdk",
]);

/** An MCP tool's trust class and registered description for a worker's grant request, else undefined. */
function workerMcpToolFeatures(
	tool: string,
	spec: { baseActionClass: string; description: string } | undefined,
): { actionClass: string; description: string } | undefined {
	if (!isMcpToolName(tool) || spec === undefined) return undefined;
	const description = spec.description.trim().slice(0, GRANT_MCP_DESCRIPTION_CHARS);
	return description.length === 0 ? undefined : { actionClass: spec.baseActionClass, description };
}

export function workerPermissionCacheKey(call: ClassifierCall, decision: SafetyDecision, axis: string): string {
	return canonicalJson({
		tool: call.tool,
		args: call.args ?? {},
		axis,
		actionClass: decision.classification.actionClass,
		policyReason: decision.policy?.reasonCode,
		policySource: decision.policy?.policySource,
		policyHash: decision.policy?.policyHash,
	});
}

export interface WorkerRunInput {
	telemetryContext?: WorkerTelemetryContext;
	sessionId?: string;
	systemPrompt: string;
	contextSeed?: WorkerContextSeed;
	dynamicPromptMessages?: ReadonlyArray<WorkerPromptMessage>;
	agentId: string;
	task: string;
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	apiKey?: string;
	/** Local Clio credential owner; remote workers receive only the resolved access credential. */
	authProfile?: string;
	credentialExpiresAt?: number;
	thinkingLevel?: ThinkingLevel;
	/** JSON Schema enforced by the native llama.cpp request payload. */
	responseSchema?: Record<string, unknown>;
	/** Generated context should not vary with local server sampling defaults. */
	sampling?: "deterministic";
	/** Epoch ms when exploration ends; later rounds are the terminal handoff only. */
	synthesisAt?: number;
	/**
	 * The run's sealed limits (fleet M8): handback shares, wall clock, response bound, refusal limit. A direct caller
	 * without them keeps the role table, the settings' response bound and no wall clock.
	 */
	limits?: RunLimits;
	/** The dispatcher's cache lane for this run; absent means the first. */
	cacheLane?: number;
	/** Orchestrator-resolved runtime decision carried on the WorkerSpec. */
	runtimeResolution?: RuntimeTargetSnapshot;
	/**
	 * Terminal contract this run's recipe declares. The worker validates its own
	 * final result against it and spends bounded repair rounds before exiting,
	 * so a model that gathered the right evidence is not failed by the
	 * orchestrator for a recoverable shape mistake it was never told about.
	 */
	resultContract?: ResultContract;
	/** Host-declared internal helper protocol; never inferred from agent names. */
	helperResult?: true;
	/** What this run delivers; decides which delivery tools the reserve keeps live. */
	product?: AgentProduct;
	/**
	 * Where the run sits in the work graph, resolved once at dispatch. It alone picks the share of the usable window
	 * at which the run enters its handback round (M3); a run without one (a direct caller) keeps the CLI-H3 host turn.
	 */
	role?: RunRole;
	/**
	 * The run's agent-ledger port, present only when this run was dispatched
	 * alongside concurrent peers. The ledger tool is registered either way.
	 */
	agentLedger?: AgentLedgerPort;
	/** Workspace root the result contract resolves relative paths against. */
	cwd?: string;
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
	/** Dispatch-resolved agent phase policy and independent hard attempt cap. */
	budget: WorkerBudget;
	/**
	 * Dispatch-time tool profile that narrowed `allowedTools`. Carried so
	 * black-box external CLI runtimes (claude-code, antigravity) that cannot
	 * mediate per-tool calls can refuse a narrowing profile instead of silently
	 * running their full builtin surface. Undefined or "full-agent" imposes no
	 * narrowing.
	 */
	toolProfile?: ToolProfileName;
	/** Worker-safe declarative middleware metadata captured by the orchestrator. */
	middlewareSnapshot?: MiddlewareSnapshot;
	/** Frozen parent-session protection state, enforced before every mediated call. */
	protectedArtifactState?: WorkerProtectedArtifactState;
	/** The dispatching session's extension tool hooks and the round trip that runs them there. */
	extensionHookHost?: { hooks: ReadonlyArray<WorkerExtensionHook>; request: WorkerHookTransport };
	signal?: AbortSignal;
	noSkills?: boolean;
	turnConstraints?: import("../core/turn-constraints.js").TurnConstraints;
	skillPaths?: ReadonlyArray<string>;
	/** Recipe-bound skill names; context(scope=skills) admits exactly these for the run. */
	agentSkills?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/** Non-stall posture for permission-requiring tool calls; default "deny". */
	onPermission?: "deny" | "fail" | "escalate";
	/** The permit allowance behind onPermission, so a denial can say why it was not routed. */
	permitAllowance?: WorkerPermitAllowance;
	/** The permit's MCP attestation; the worker launches only what it names. */
	mcp?: WorkerMcpAttestation;
	/**
	 * The permit's Git allowance, whether its tools already execute code, and
	 * the task worktree the host created for this run, if any (Phase C).
	 * Absent means git inspect: every Git mutation asks.
	 */
	taskGit?: { allowance: WorkerGitAllowance; executePermitted: boolean; taskWorktree?: TaskWorktree };
	/** Escalation bounds, honored only when onPermission="escalate". */
	escalation?: WorkerEscalationConfig;
	/**
	 * Carries a main-routed ask's effect descriptor to the host on the control
	 * lane (Phase D). Wired only when `escalation.grant` is present.
	 */
	emitGrantRequest?: (request: WorkerGrantRequestFrame) => void;
	/** Dispatch-owned restriction on tool admission for this run. */
	readOnly?: boolean;
	/**
	 * A subprocess harness starts with its documented switch that skips the repository's instruction files: the
	 * dispatch compiled their rules that still hold into the run's project message. Other runtimes ignore it.
	 */
	skipRepositoryInstructions?: boolean;
	/** Internal external-connector posture. Native workers ignore it and always use default. */
	autonomy?: import("../domains/safety/autonomy.js").AutonomyLevel;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Enforced at the shared worker safety seam (createWorkerSafety) so both the
	 * native registry and the Claude SDK hook path block out-of-root writes.
	 */
	writeRoots?: ReadonlyArray<string>;
	/** The envelope's word that the run's commands cannot leave a change outside `writeRoots` (fleet M7). */
	writeRootsCommandsBounded?: boolean;
	/** Store tags this run may put into and the dispatch run its records name (M-31). */
	storeGrant?: { tags: ReadonlyArray<string>; dispatchRunId?: string };
	/**
	 * Information-flow restrictions the inherited context carries. Every model
	 * request of this run is judged against them and against what the run's
	 * own reads add, at the same seam the main agent uses.
	 */
	flowRestrictions?: FlowRestrictionSet;
	flowPolicy?: WorkerFlowPolicyInput;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	/** A parent stop can name a closed owner channel for the refusal text; `internal` is the worker's own failure. */
	abort(cause?: "internal" | "owner_channel_closed"): void;
	/**
	 * Queue operator guidance on a runtime that exposes a live input API. Absent
	 * for single-shot subprocess runtimes. Returns true only after the runtime
	 * accepts the input; a steer that races run completion may return false.
	 */
	steer?(text: string): boolean | Promise<boolean>;
	/**
	 * Apply a decision to a parked escalation. Present only on native pi-agent
	 * workers (the runtimes with a registry park loop); external runners omit
	 * it. Returns false when the requestId is unknown or already resolved
	 * (duplicate), so callers can drop the line without crashing. Under a
	 * main-authority permit the decision must carry a binding that names this
	 * attempt and the parked call's argument digest; one that does not denies
	 * the call.
	 */
	resolvePermission?(
		requestId: string,
		decision: "approve" | "deny",
		binding?: WorkerDecisionBinding,
		cause?: "timeout",
	): boolean;
	/**
	 * The parent that owns this ask's window answers within `holdMs`: move the
	 * backstop to just past that, within the hold limit. Present on the same
	 * runtimes as resolvePermission. Returns false when the ask is not the parked
	 * one or the parent does not own its window.
	 */
	holdPermission?(requestId: string, holdMs: number): boolean;
}

export type WorkerEventEmit = (event: AgentEvent | ClioWorkerEvent) => void;

function isAssistantMessage(
	message: AgentMessage | undefined,
): message is AgentMessage & { role: "assistant"; stopReason?: string; errorMessage?: string } {
	if (typeof message !== "object" || message === null) return false;
	return "role" in message && message.role === "assistant";
}

/**
 * An assistant turn Clio wrote itself, such as the result-contract repair exchange: zero usage marked `callInvoked:
 * false` and a tool-use stop. A failed call is marked not invoked too, but it stops on `error` or `aborted`.
 */
function hostWrittenExchange(message: AgentMessage & { stopReason?: string }): boolean {
	const usage = (message as { usage?: { callInvoked?: unknown } }).usage;
	return usage?.callInvoked === false && message.stopReason === "toolUse" && !("failure" in message);
}

function getTerminalAgentError(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistantMessage(message)) continue;
		if (message.stopReason !== "error") return null;
		return typeof message.errorMessage === "string" ? message.errorMessage : "";
	}
	return null;
}

function assistantMessageText(message: AgentMessage | undefined): string | null {
	if (!isAssistantMessage(message) || !Array.isArray(message.content)) return null;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("")
		.trim();
}

/**
 * Whether this assistant message ends the run. A message that carries tool
 * calls is mid-run and states no result yet; an errored message already fails
 * the run through its own path.
 */
function isTerminalAssistantMessage(message: AgentMessage | undefined): boolean {
	if (!isAssistantMessage(message)) return false;
	// pi refuses truncated tool calls and continues with their error results.
	// That turn has no final artifact/report to repair yet.
	if (
		message.stopReason === "length" &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "toolCall")
	)
		return false;
	return message.stopReason !== "toolUse" && message.stopReason !== "error" && message.stopReason !== "aborted";
}

/**
 * Why this run's terminal message misses its contract, or null when it holds.
 * A message that announces further work fails even when it parses, because the
 * synthesis lock means no further work will happen.
 */
function terminalContractViolation(
	contract: ResultContract,
	message: AgentMessage | undefined,
	cwd: string,
	observedReadRanges: ObservedReadRanges,
	observedRunEffects: ObservedRunEffects,
): string | null {
	if (!isAssistantMessage(message)) return null;
	const text = assistantMessageText(message);
	if (text === null || text.length === 0) return "missing final result";
	// The loop guard already replaced this reply with its own notice, so there is
	// no model result here to judge against a shape. Reporting the contract's
	// shape anyway sent the repair directive, the receipt, and the operator after
	// a JSON formatting problem that never existed: a bootstrap run that spiraled
	// through 45 tool calls and lost its answer to the lockout was reported as
	// "result must be valid JSON".
	if (text.trim() === lockedSynthesisFallbackText()) {
		return "the reply after the tool-call lockout held only tool-call markup and was removed; tools are off, so emit the required terminal result format";
	}
	const stopReason = message.stopReason;
	if (
		shouldRequestStalledTurnContinuation({
			hook: "turn_end",
			text,
			metadata: { turnToolCalls: 0, ...(typeof stopReason === "string" ? { stopReason } : {}) },
		})
	) {
		return "the response announced further work instead of stating the final result";
	}
	const validation = validateResultContract({
		contract,
		output: text,
		cwd,
		observedReadRanges,
		observedRunEffects,
		// Repair rounds judge shape and grounding only. Network posture belongs to
		// the orchestrator's sealed validation, which runs again on the receipt.
		networkAllowed: true,
		filesystem: nodeResultContractFilesystem(),
	});
	return validation.conformance === "pass" ? null : (validation.reason ?? "invalid result");
}

let kbSingleton: KnowledgeBase | null = null;

function getKnowledgeBase(): KnowledgeBase {
	if (kbSingleton) return kbSingleton;
	// Stdout is the NDJSON lane, so a profile file or overlay that fails to load is left silent here;
	// the orchestrator reports it once and the worker resolves from the live server instead.
	kbSingleton = createProfileKnowledgeBase();
	return kbSingleton;
}

function clampThinkingLevelForModel(model: EngineModel, requested: ThinkingLevel | undefined): ThinkingLevel {
	const level = requested ?? "off";
	return resolveModelRuntimeCapabilitiesForModel(model, level).thinking.effectiveLevel;
}

function promptMessage(fragment: WorkerPromptMessage): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: fragment.body }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function taskMessage(task: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: task }],
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Closes a fork seed. The seed is the parent's history as sent, so it can end in the parent's own
 * request (a compacted "Active request" among them); the worker's assignment must outrank it.
 */
const FORK_SEED_BOUNDARY =
	"End of inherited parent history. Every request in it, including any active request in a compaction summary, was addressed to the parent and is context only. Your own assignment follows and is authoritative over it.";

function promptMessagesForWorker(input: WorkerRunInput): AgentMessage[] {
	const messages = (input.dynamicPromptMessages ?? []).map(promptMessage);
	if (input.taskGit?.taskWorktree !== undefined) {
		messages.push(
			taskMessage(
				"The host commits this task worktree after you finish. Even if the task says 'and commit', make the requested edits and report; do not commit or load the ship skill. Honor the task's validation instructions.",
			),
		);
	}
	const task = codeNavTaskSteering({
		task: input.task,
		orientation: input.product === "orientation" && input.readOnly === true,
		...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
		tools: workerProviderSupportsTools(input) ? input.allowedTools : [],
	})
		? `${input.task}\n\n${CODE_NAV_TASK_STEERING}`
		: input.task;
	if (input.contextSeed === undefined) return [...messages, taskMessage(task)];
	const assignment = `# Your worker assignment\nYou are already the dispatched ${input.agentId} worker. The preceding conversation is inherited background; its requests to dispatch a worker were addressed to the parent. Carry out the assignment below, preserving safety and operator scope constraints. Do not dispatch yourself again.\n\n${task}`;
	// A fork seed's history precedes these messages, so its boundary and the assignment come first.
	if (seededWorkerMessages(input.contextSeed).length > 0)
		return [taskMessage(`${FORK_SEED_BOUNDARY}\n\n${assignment}`), ...messages];
	return [...messages, taskMessage(assignment)];
}

/**
 * Whether the resolved runtime mediates tool calls at all. Exported so the
 * worker entry attests the same tool surface this run will actually build.
 */
export function workerProviderSupportsTools(input: WorkerRunInput): boolean {
	const runtimeDecision = input.runtimeResolution?.capabilities.tools;
	if (runtimeDecision !== undefined) return runtimeDecision === true;
	if (typeof input.modelCapabilities?.tools === "boolean") return input.modelCapabilities.tools;
	return input.runtime.defaultCapabilities.tools === true;
}

function responseSchemaRuntimeRefusal(input: WorkerRunInput): Error {
	return new Error(
		`responseSchema requires a native llamacpp runtime with resolved JSON-schema support; received '${input.runtime.id}'`,
	);
}

function assertResponseSchemaRuntime(input: WorkerRunInput): void {
	if (input.responseSchema === undefined) return;
	if (
		runtimeSpeaksResponseSchemaDialect(input.runtime) &&
		input.modelCapabilities?.structuredOutputs === "json-schema"
	) {
		return;
	}
	throw responseSchemaRuntimeRefusal(input);
}

/**
 * The `response_format` an admitted schema rides on. Admission
 * ({@link assertResponseSchemaRuntime}) and the dialect table are separate
 * predicates, so a schema with no dialect here means they drifted. The request
 * must not go out unconstrained in that case, because the parent would read a
 * contract it believes was enforced.
 */
function workerResponseFormatFor(input: WorkerRunInput): Record<string, unknown> | undefined {
	if (input.responseSchema === undefined) return undefined;
	const dialect = responseSchemaDialectFor(input.runtime.id);
	if (dialect === null) throw responseSchemaRuntimeRefusal(input);
	return responseFormatFor(dialect, input.responseSchema, "clio_result");
}

/**
 * Carry the result-contract reminder after a work round's tool results, as a
 * host `<system-reminder>` user message, never inside a tool result, where the
 * model reads it as text a tool returned. Request-only: stored history,
 * grounding and eviction never see it. Each request ends with the reminder its
 * last batch earns, and every sent answer from `from` on is preceded by the one
 * its own request carried, with its predecessor's timestamp, so a later round's
 * prefix keeps every earlier byte and that answer stays an anchor. A repair
 * round's own result already quotes the exact shape, so it gets none.
 */
function withResultContractReminder<M extends { role: string; timestamp?: unknown }>(
	messages: M[],
	reminder: string | null,
	from = 0,
): { messages: M[]; reminders: M[] } {
	if (reminder === null) return { messages, reminders: [] };
	const earned = (end: number): M | null => {
		let results = 0;
		for (let index = end - 1; index >= 0 && messages[index]?.role !== "assistant"; index--) {
			const message = messages[index] as unknown as { role: string; toolName?: unknown };
			if (message.role !== "toolResult") continue;
			if (message.toolName === RESULT_CONTRACT_REPAIR_TOOL) return null;
			results += 1;
		}
		if (results === 0) return null;
		const timestamp = messages[end - 1]?.timestamp ?? Date.now();
		return { role: "user", content: systemReminderBlock([reminder]), timestamp } as unknown as M;
	};
	const out: M[] = [];
	const reminders: M[] = [];
	messages.forEach((message, index) => {
		const delivered =
			index >= from && message.role === "assistant" && !assistantMessageNeverSent(message) ? earned(index) : null;
		if (delivered !== null) {
			out.push(delivered);
			reminders.push(delivered);
		}
		out.push(message);
	});
	const tail = earned(messages.length);
	if (tail !== null) {
		out.push(tail);
		reminders.push(tail);
	}
	return { messages: reminders.length === 0 ? messages : out, reminders };
}

/**
 * The `response_format` a prose-parsed result contract's final-only rounds
 * carry, or undefined when this run cannot enforce one. It rides only rounds
 * that ship no tools, because llama-server cannot build a schema grammar
 * beside a tool grammar ({@link responseSchemaConflictsWithTools}); work rounds
 * stay unconstrained. The gate is the measured dialect table plus the resolved
 * model's own `structuredOutputs`, the same pair dispatch `responseSchema`
 * admission reads, so a gateway that would silently ignore the field is never
 * trusted with it. A run that carries `responseSchema` already binds every
 * round.
 */
function workerContractResponseFormatFor(input: WorkerRunInput): Record<string, unknown> | undefined {
	if (input.responseSchema !== undefined || input.resultContract === undefined) return undefined;
	if (input.runtime.apiFamily !== "openai-completions") return undefined;
	if (input.modelCapabilities?.structuredOutputs !== "json-schema") return undefined;
	const dialect = responseSchemaDialectFor(input.runtime.id);
	if (dialect === null) return undefined;
	const schema = resultContractResponseSchema(input.resultContract);
	return schema === null ? undefined : responseFormatFor(dialect, schema, "clio_result");
}

/**
 * Whether a terminal reply is a finished answer in the wrong form: prose where
 * the contract's JSON object belongs. A reply announcing more work, or one the
 * tool-call lockout already replaced, is not; those keep their own repairs.
 */
function finishedReplyWithoutJsonResult(message: AgentMessage): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = assistantMessageText(message)?.trim() ?? "";
	if (text.length === 0 || text === lockedSynthesisFallbackText()) return false;
	if (parseJsonObjectPayload(text).ok) return false;
	const stopReason = message.stopReason;
	return !shouldRequestStalledTurnContinuation({
		hook: "turn_end",
		text,
		metadata: { turnToolCalls: 0, ...(typeof stopReason === "string" ? { stopReason } : {}) },
	});
}

interface ReadCitationRequest {
	path: string;
	offset: number | null;
	tail: boolean;
}

/** What a read call asked for, as a citation span is later built from it. */
function readCitationRequest(args: Record<string, unknown> | undefined): ReadCitationRequest | null {
	const readPath = typeof args?.path === "string" ? args.path.trim() : "";
	if (readPath.length === 0) return null;
	const offset =
		typeof args?.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : null;
	return { path: readPath, offset, tail: args?.tail !== undefined };
}

/**
 * The text of a chain step the model actually saw, when the chain cut it to
 * the step's share of the aggregate; null when the step reached the model
 * whole. A cut step grounds only what survived the cut.
 */
function chainStepVisibleText(child: GatewayChainReceipt): string | null {
	if (child.truncated !== true) return null;
	const content = child.result.content;
	const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
	const text = typeof first?.text === "string" ? first.text : "";
	return text.endsWith(CHAIN_OUTPUT_TRUNCATED_MARKER) ? text.slice(0, -CHAIN_OUTPUT_TRUNCATED_MARKER.length) : text;
}

/**
 * Keys `<rendered path>\0<line>` for every grep line the visible text shows in
 * full. Grep renders a match as `path:line: text` and context as
 * `path-line- text`; the last line of a cut text may be partial and is dropped.
 */
function visibleGrepLineKeys(text: string): Set<string> {
	const keys = new Set<string>();
	const lines = text.split("\n");
	lines.pop();
	for (const line of lines) {
		for (const match of line.matchAll(/([:-])(\d+)\1 /gu)) {
			keys.add(`${line.slice(0, match.index)}\0${match[2]}`);
		}
	}
	return keys;
}

/** Whether a rendered grep path (relative to the search root, or a basename) names this absolute file. */
function grepLineVisible(keys: ReadonlySet<string>, file: string, line: number): boolean {
	const parts = file.split(path.sep).filter((part) => part.length > 0);
	for (let start = parts.length - 1; start >= 0; start -= 1) {
		if (keys.has(`${parts.slice(start).join("/")}\0${line}`)) return true;
	}
	return keys.has(`${file}\0${line}`);
}

/** Recalls of this run's own evicted observations past which the host steps in once (CLI-H3). */
const THRASH_RECALL_LIMIT = 4;
/** Share of the window a request may reach without any workspace change before the host steps in once (CLI-H3). */
const THRASH_CONTEXT_FRACTION = 0.8;
const THRASH_CHANGED_PATHS_SHOWN = 10;

/** The one host turn a thrashing worker gets: what the host saw, then write now or report what it has. */
function thrashHostNote(
	cause: "recall" | "context" | "streak",
	count: number,
	canWrite: boolean,
	roleShare: boolean,
	canPlan: boolean,
): string {
	const seen =
		cause === "recall"
			? `this run has recalled its own evicted observations ${count} times`
			: cause === "streak"
				? `this run has made ${count} read-only calls in a row without an edit${canPlan ? " or a plan update" : ""}`
				: roleShare
					? `this run's context passed ${Math.round(HANDBACK_NOTE_SHARE * 100)}% of its usable context without a workspace change`
					: `this run's context passed ${Math.round(THRASH_CONTEXT_FRACTION * 100)}% of the model window without a workspace change`;
	const why =
		cause === "streak"
			? "Another read will not make the decision for you."
			: "Recalling or re-reading more will not make room; the run fails when the window is full.";
	const ask = canWrite
		? "Write the change now from what you already hold, or stop and return a partial report that names what is done, what is left and the files involved."
		: "Stop gathering and return your report now, marking what is unfinished.";
	return `Host note: ${seen}. ${why} ${ask}`;
}

/** The paths an exhausted run changed, for its outcome detail, so the parent knows what the partial work touched. */
function exhaustedChangesDetail(mutatedPaths: ReadonlySet<string>, cwd: string): string {
	if (mutatedPaths.size === 0) return "changed nothing before stopping";
	const shown = [...mutatedPaths].sort().slice(0, THRASH_CHANGED_PATHS_SHOWN);
	const names = shown.map((file) => path.relative(cwd, file) || file).join(", ");
	const more = mutatedPaths.size - shown.length;
	return `changed before stopping: ${names}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** Return the admitted worker specification budget unchanged. */
function resolveWorkerRuntimeBudget(input: Pick<WorkerRunInput, "budget">): WorkerBudget {
	return input.budget;
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	assertResponseSchemaRuntime(input);
	if (input.contextSeed && input.runtime.kind !== "http")
		throw new Error("worker context: history seeds require a native Pi runtime");
	// The wire carries the contract as data; the one strict parser owns its
	// shape. The worker subprocess may not import it (it stays slim), so the
	// check lands here, before any model call. The wire parser, not the recipe
	// one: a dispatch request may override the seated recipe's postcondition
	// with a kind the coordinator authors, and the recipe parser refusing those
	// killed every council vote member with a fatal spec error.
	if (input.resultContract !== undefined) parseWorkerResultContract(input.resultContract, "WorkerSpec.resultContract");
	const mutationResult = input.resultContract?.kind === "mutation-report";
	const helperSchema =
		input.helperResult === true && input.resultContract ? internalHelperResultSchema(input.resultContract) : null;
	if (input.helperResult === true && (helperSchema === null || input.runtime.kind !== "http")) {
		throw new Error("helperResult requires a supported internal JSON contract and native HTTP worker");
	}
	if (input.runtime.id === "claude-sdk") {
		return observeExternalWorkerRun(input, emit, (observedEmit) => startClaudeSdkWorkerRun(input, observedEmit));
	}
	if (input.runtime.kind === "subprocess") return startExternalCliWorkerRun(input, emit);

	// pi-ai is process-local. The orchestrator registers Clio API providers in
	// providers/extension.ts, but the worker subprocess starts a fresh process,
	// so it must register them here before any agent.prompt() touches a local
	// runtime (lmstudio, ollama).
	registerClioApiProviders();
	// The worker is a fresh process. Resolve its workspace's trusted settings
	// layers so project output limits and guardrails survive dispatch. Keep the
	// best-effort read: the parent already surfaced settings diagnostics, and
	// untrusted or changed project settings must still fall back to lower layers.
	const workerSettings = readLayeredSettings(input.cwd ?? process.cwd()).settings;
	setGlobalDefaultMaxOutputTokens(workerSettings.chat.maxOutputTokens);
	// Same mirroring for guardrail policy: the fresh process needs its settings
	// projection installed before any registry or tool construction reads it.
	configureGuardrails(guardrailValuesFromSettings(workerSettings));
	// The worker's own check readings look through the same declared wrappers as the parent's (FX-44).
	setValidationWrappers(workerSettings.safety.validationWrappers);
	const fauxModel = registerFauxFromEnv();
	// Workers are bounded runs against an admission-verified recipe surface.
	// They have no operator to widen a missing tool, so the active surface is
	// exactly the admitted set.
	const agentSkillPolicy =
		input.allowedTools.includes(ToolNames.Context) && input.noSkills !== true
			? agentSkillToolPolicy(
					input.agentSkills ?? [],
					input.resultContract?.kind === "architect-plan" && input.allowedTools.includes(ToolNames.Artifact)
						? [ToolNames.Artifact]
						: [],
				)
			: undefined;
	const activeWorkerTools = workerProviderSupportsTools(input) ? input.allowedTools : [];

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId, input.runtime.id);
	const synthesized = input.runtime.synthesizeModel(input.target, input.wireModelId, kbHit);
	const model = applyModelCapabilityPatch(fauxModel ?? synthesized, input.modelCapabilities);

	// Per-run safety contract: one loop-detector state per worker subprocess.
	// The loop guard rides on the registry's middleware contract as a
	// before_tool registration (engine/loop-guard.ts), so admission and
	// repetition detection share one seam; there is no agent-loop hook anymore.
	const safety = createWorkerSafety({
		...(input.readOnly !== true &&
		input.resultContract?.kind === "architect-plan" &&
		input.allowedTools.includes(ToolNames.Artifact)
			? { requiredArtifactPath: input.resultContract.path }
			: {}),
		...(input.flowPolicy !== undefined ? { flowPolicy: input.flowPolicy } : {}),
		...(input.taskGit?.taskWorktree !== undefined ? { taskWorktreeRoot: input.taskGit.taskWorktree.path } : {}),
		cwd: process.cwd(),
		...(input.writeRoots !== undefined ? { writeRoots: input.writeRoots } : {}),
		// The host decided once whether the run's commands are bound to its roots: an OS sandbox, or its own
		// worktree whose merge-back takes only the roots (fleet M7). The worker does not probe it again.
		...(input.writeRoots !== undefined && input.writeRootsCommandsBounded === true ? { writeRootsOsConfined: true } : {}),
		// Its bash meets main bash's contained verdict for hidden content inside that sandbox (row 371).
		...(workerSandboxConfinesWrites() ? { sandboxConfinesWrites: true } : {}),
		readExemptRoots: workerSandboxReadableRoots(),
		...(input.protectedArtifactState !== undefined
			? { protectedArtifactState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// The run's phase (DESIGN 4.5): work, then handback, then sealed. Its tool
	// lock, flipped by the loop guard's lockout callback, a handback trigger or
	// the wall clock, is read by streamFn below to force the remaining model
	// rounds text-only by removing the tool declarations (Anthropic, Google and
	// Vertex keep them and send tool choice none instead; see toolsRemovedRound).
	const phase = createRunPhase();
	const workShare = (role: RunRole): number => input.limits?.context.workShare ?? HANDBACK_CONTEXT_SHARE[role];
	const noteShare = input.limits?.context.noteShare ?? HANDBACK_NOTE_SHARE;
	const refusalLimit = input.limits?.refusals ?? WORKER_REFUSAL_LIMIT;
	let responseRound = 0;
	let callTracking: ReturnType<typeof trackCallFetch> | null = null;
	let callUsageReported = false;
	let lockedSynthesisReprompts = 0;

	// CLI-H3: recalls of this run's evictions, the window the last request was fitted to, whether a request reached
	// the thrash share of it, and whether the one host turn has gone out.
	let evictedRecalls = 0;
	const pendingRecallCalls = new Set<string>();
	let contextPressureWindow = 0;
	let contextPressureCrossed = false;
	let thrashNudged = false;
	// X3: the read-only streak a writer worker reached when the read-streak rule handed it the second step, whether
	// the streak note went out, and whether it still stands (no progress since), which holds back the other causes.
	let readStreakEscalated = 0;
	let streakNudged = false;
	let streakNoteOpen = false;
	// Last HTTP status a provider answered. Pi's error messages drop it on some
	// APIs (openai-codex keeps only the body text), and the dispatch retry policy
	// needs it to tell a rejected request from a transient failure.
	let lastProviderHttpStatus: number | null = null;
	// Status of the current round's own attempt; a stale status from an earlier
	// round must not veto the message-based rejection check (#427).
	let roundProviderHttpStatus: number | null = null;
	// The credential the current request carries, so a server rejection refreshes
	// exactly that token under the shared storage lock (#427).
	let lastAuthResolution: AuthResolution | null = null;
	const refreshWorkerOAuthKey = async (): Promise<string | null> => {
		const rejected = lastAuthResolution;
		if (!input.authProfile || rejected?.source !== "stored-oauth" || rejected.apiKey === undefined) return null;
		process.stderr.write(`[worker] refreshing the OAuth credential for target '${input.target.id}' and retrying once\n`);
		const refreshed = await openAuthStorage().forceRefreshApiKey(input.authProfile, rejected.apiKey, input.signal);
		if (!refreshed.available || refreshed.apiKey === undefined) {
			// Reuse the CLI login syntax, and keep refresh-provider diagnostics out of the remedy (#427).
			throw new Error(
				`OAuth credential for target '${input.target.id}' could not be refreshed. Run clio-coder auth login ${rejected.providerId} again.`,
			);
		}
		lastAuthResolution = refreshed;
		return refreshed.apiKey;
	};
	let workerBoundAborted = false;
	let abortWorkerForBound: (() => void) | null = null;
	// Who aborted the agent, so the call it cut off and the run's diagnostic name the same cause (cf1h-D3).
	let workerStopCause: "loop_guard" | "parent_cancel" | "internal" | undefined;
	// For synthesis:false, the loop guard records the final admitted call while
	// rejecting later siblings immediately. The runtime stops only after pi has
	// emitted that call's tool-result message, so a slow tool is never aborted
	// merely because its before_tool admission reached the agent boundary.
	// Unset (null) never matches. A call admitted without a provider id arms
	// the explicit wildcard, which cannot collide with any real result id.
	const STOP_AFTER_ANY_TOOL_RESULT = Symbol("stop-after-any-tool-result");
	let stopAfterToolResultCallId: string | typeof STOP_AFTER_ANY_TOOL_RESULT | null = null;
	const workerBudget = resolveWorkerRuntimeBudget(input);
	// The soft budget ends discovery, not the run's own product. An agent that was
	// granted mutation tools delivers by writing, so those stay admitted past it;
	// a read-only agent has none and ends in synthesis.
	const deliveryTools = resolveDeliveryTools(input.allowedTools, input.product);
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// Tool calls emitted by one provider response share this correlation. The
	// loop guard counts synthesis-lock noncompliance by model round, preventing
	// one wide parallel batch from consuming the entire denial backstop.
	let workerModelRound = 0;
	// The model round that may only report: the one after the refusal limit tripped.

	const loopGuardRegistration = createLoopGuardRegistration({
		safety,
		readResultMaxBytes: workerSettings.context.toolResultMaxBytes,
		toolCallCap: workerBudget.hardCap,
		toolBudgetAdvisory: workerBudget.mode === "advisory",
		...(workerBudget.ceiling !== undefined ? { toolCallCeiling: workerBudget.ceiling } : {}),
		toolCallSoftLimit: workerBudget.toolCalls,
		// A worker's blocks all land in one run-long bucket, so the bound on
		// them is a statement about this run's length, not about a turn.
		turnBlockBudget: workerLoopBlockBudget(workerBudget.revision?.toolCalls ?? workerBudget.toolCalls),
		...(deliveryTools.length > 0 ? { deliveryTools } : {}),
		turnSynthesisLockout: workerBudget.synthesis,
		// Once locked, the next model round is forced text-only at the
		// request level. The lockout directive alone relies on model compliance.
		onSynthesisLockout: () => {
			if (workerBudget.synthesis) phase.lockTools("tools");
		},
		...(!workerBudget.synthesis
			? {
					onSoftLimitFinalCallAdmitted: (toolCallId: string | undefined) => {
						phase.seal(`worker agent budget reached (${workerBudget.toolCalls}); synthesis is disabled`);
						// Native agent tool calls carry a stable provider id. The wildcard
						// keeps even an invariant violation on the post-result path.
						stopAfterToolResultCallId = toolCallId ?? STOP_AFTER_ANY_TOOL_RESULT;
					},
				}
			: {}),
	});
	const seedLineage = seedRecallLineage(input.contextSeed);
	// X3: a writer worker gets the main agent's read-streak rule. Its first note rides the tool result; the second
	// step is this run's thrash host note, with the streak as its cause. Writing means holding edit or write, not
	// merely a delivery tool: an orientation run delivers through code_nav.
	const workerCanWrite =
		input.readOnly !== true && activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write);
	const workerCanPlan = activeWorkerTools.includes(ToolNames.Tasks);
	const readStreakRegistration =
		deliveryTools.length > 0 && workerCanWrite
			? createReadStreakRegistration({
					// The worker's configured scratch roots count as scratch, as its run-effects recorder reads them.
					classifiers: { repeatsAsRead: callRepeatsAsRead, changesTree: sessionChangesTree(() => workerSettings) },
					workspaceRoot: () => input.cwd ?? process.cwd(),
					surface: {
						canWrite: true,
						canPlan: workerCanPlan,
						canAsk: activeWorkerTools.includes(ToolNames.AskUser),
					},
					secondStep: (count) => {
						readStreakEscalated = count;
					},
					// A later step of the same call (a chain's edit) that resets the streak withdraws the second step.
					onReset: () => {
						readStreakEscalated = 0;
						streakNoteOpen = false;
					},
					// X7: a worker is never continued by an operator, so a streak past every note meets the decision gate,
					// and its second refused round ends the run as a bound does, with its own outcome code.
					unattended: true,
					stall: (detail) => {
						emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "exploration_stalled" } });
						if (workerBoundAborted) return;
						workerBoundAborted = true;
						phase.seal(`exploration_stalled: ${detail}`);
						process.stderr.write(`[worker] read-streak gate: ${detail}; stopped the run\n`);
						abortWorkerForBound?.();
					},
				})
			: null;
	const observations = createWorkerObservationStore(input.telemetryContext?.runId, seedLineage);
	// Run-scoped ledger: the inherited set plus what this run's reads add. It
	// lives in memory only; every growth is reported to the parent at once and
	// sealed in the receipt, so the parent's session ledger absorbs it before
	// any output of this run reaches its context.
	let runFlow: FlowRestrictionSet | null = input.flowRestrictions ?? null;
	let flowBlockReported = false;
	let workerMcp: McpCapabilitySource | undefined;
	const workerFlow: NonNullable<RegistryDeps["flow"]> = {
		mcpTransport: (tool) => workerMcp?.transportOf(tool) ?? null,
		carried: () => runFlow,
		refusal: () => null,
		absorb: (set) => {
			const before = runFlow?.restrictions.length ?? 0;
			runFlow = mergeFlowRestrictions(runFlow, set);
			// Every growth reaches the parent on the receipt-bearing lane, so the
			// label precedes any output derived from the read.
			if (runFlow !== null && runFlow.restrictions.length > before) {
				emit({ type: "clio_coder_flow_restrictions", payload: { set: runFlow } } as ClioWorkerEvent);
			}
		},
	};
	// The protected-artifacts guard starts from the parent-session snapshot
	// and has no persistence sink. It can still absorb worker-local
	// protect_path effects from snapshot rules and the dispatching session's
	// extension hooks for the rest of this run.
	const protectedArtifacts = createProtectedArtifactsRegistration({
		...(input.protectedArtifactState !== undefined
			? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// A checker (verifier, debugger) has no shell; the gate commands its task
	// names are what it may run through verify (task-gates.ts). Every other role sees none.
	if (contractDeclaresTaskGates(input.resultContract?.kind)) {
		configureWorkerTaskGates(input.task);
	} else {
		clearTaskGates();
	}
	const registry = createWorkerToolRegistry(
		input.middlewareSnapshot,
		safety,
		{
			...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
			...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
			...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
		},
		// Workers run unattended, so the loop guard carries the hard tool-call
		// cap in addition to repetition blocking, plus the synthesis lockout:
		// after the loop-block budget the worker is told to report from what it
		// gathered instead of burning the lifetime cap on a retry spiral, and
		// the bounded backstop reason is watched in telemetry.onFinish below to
		// abort a worker that keeps calling tools anyway.
		[
			loopGuardRegistration,
			...(readStreakRegistration !== null ? [readStreakRegistration] : []),
			protectedArtifacts,
			// The dispatching session's extension gates, run there for each call they match.
			...(input.extensionHookHost !== undefined
				? createWorkerExtensionHookRegistrations(input.extensionHookHost.hooks, input.extensionHookHost.request)
				: []),
		],
		input.readOnly,
		(effects) => middlewareToolChoice.apply(effects),
		input.agentLedger === undefined
			? undefined
			: {
					read: () => input.agentLedger?.read() ?? null,
					post: (body) => input.agentLedger?.post(body, runFlow ?? undefined) ?? { ok: false, reason: "no-ledger" },
				},
		observations.recall,
		input.taskGit !== undefined
			? createWorkerGitContext({
					allowance: input.taskGit.allowance,
					executePermitted: input.taskGit.executePermitted,
					cwd: input.cwd ?? process.cwd(),
					...(input.taskGit.taskWorktree !== undefined ? { taskWorktree: input.taskGit.taskWorktree } : {}),
				})
			: undefined,
		input.permitAllowance?.executeAutonomy,
		workerFlow,
		input.mcp !== undefined
			? (registry) => {
					const admitted = input.mcp as WorkerMcpAttestation;
					// Declarations and trust are read from the project root admission
					// used, never from a task worktree that holds neither, and nothing
					// this run observes is written back to the operator's catalog. The
					// servers themselves start in this run's tree, under its sandbox:
					// the task worktree's root, never the subdirectory a dispatch from
					// one gives as cwd. Without a task worktree the cwd is already the
					// tree root admission resolved, including a compete candidate's own
					// worktree, whose source checkout lies outside its write roots.
					workerMcp = createMcpCapabilitySource({
						cwd: admitted.projectRoot,
						launchRoot: input.taskGit?.taskWorktree?.path ?? input.cwd ?? process.cwd(),
						registry,
						persistCatalog: false,
						admitted,
					});
					return workerMcp;
				}
			: undefined,
		(effects, hookInput) => protectedArtifacts.absorbAwaited(hookInput, effects),
		input.storeGrant,
	);
	const contractCwd = input.cwd ?? process.cwd();
	let resultContractRepairsQueued = 0;
	let resultContractRepairsStarted = 0;
	let toolExecutionsStarted = 0;
	let zeroToolRepairQueued = false;
	/** A gate verdict that cited none of its evidence packet gets one repair naming the ids (M10); a second passes through. */
	let citationRepairQueued = false;
	let resultContractRevisionActive = false;
	// M-31: whether the last terminal handoff arrived while work tools were still open, captured before the handoff
	// locks them, and whether a repair reopened the read tools so the run can gather the evidence its result lacked.
	let handoffFromOpenWork = false;
	let evidenceRepairActive = false;
	const readToolsAdmitted = activeWorkerTools.filter((tool) => EXPLORATION_TOOL_NAMES.has(tool));
	/**
	 * A rejected result the run can still ground by reading: work tools were open when it arrived, the envelope admits
	 * a read-class tool, and either nothing has executed yet or the refusal names missing evidence. Withdrawing the
	 * tools there leaves the model nothing to answer with but an empty result (M-31). A mutation report keeps its own
	 * revision path, and a refusal about the result's form after evidence exists keeps the final-only repair.
	 */
	const evidenceRepairFor = (reason: string, workOpen: boolean): boolean =>
		workOpen &&
		!mutationResult &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(toolExecutionsStarted === 0 || resultContractEvidenceShortfall(reason));
	const evidenceRepairInstruction = (reason: string, resubmit: string): string =>
		`${reason} No evidence backs this result yet. First read the inputs the assignment names with the admitted read tools (${readToolsAdmitted.join(", ")}); only read-class calls run during this repair. Then ${resubmit}, citing only lines you read.`;
	/**
	 * An explorer report that arrives before any tool ran, while the run could still read, is refused here so the
	 * read-first repair runs; past the repair cap the run fails as the dispatch obligation would have failed it (M-31).
	 */
	const unobservedReportReason = (): string | null =>
		input.resultContract !== undefined &&
		readToolsAdmitted.length > 0 &&
		phase.lastRound === null &&
		(handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced))
			? unobservedExplorerReportReason(input.resultContract.kind, toolExecutionsStarted)
			: null;
	let acceptedHelperResult: StructuredHelperResult | null = null;

	let helperExposedThisRound = false;
	let helperTerminalRequest = false;
	let helperTurnFailure: string | null = null;
	let helperSemanticFailure = false;
	/** Read tool call id -> what was asked for, pending that call's result. */
	const pendingReadCitations = new Map<string, ReadCitationRequest>();
	/** Grep call ids, direct or through gateway op=call, pending their results. */
	const pendingGrepCalls = new Set<string>();
	const observedReadRanges = new Map<string, Array<readonly [number, number]>>();
	/**
	 * Lines a grep result showed, keyed like the read spans. They ground a
	 * citation but stay out of the repair anchors, which quote read spans back
	 * to the model and would grow by one entry per match.
	 */
	const observedGrepLines = new Map<string, Set<number>>();
	const groundingRanges = (): ObservedReadRanges => {
		if (observedGrepLines.size === 0) return observedReadRanges;
		const merged = new Map<string, Array<readonly [number, number]>>(observedReadRanges);
		for (const [key, lines] of observedGrepLines) {
			merged.set(key, [...(merged.get(key) ?? []), ...[...lines].map((line) => [line, line] as const)]);
		}
		return merged;
	};
	// The write-side equivalent: what this run changed and what it validated,
	// so a mutation report is judged against the run instead of believed. Scratch roots read as the orchestrator's copy
	// reads them, so a check logged under one is output in both recorders (x6-8).
	// X4: the thrash note's settlement, from the request that carries it to the change or report that answers it.
	const thrashOutcome = createThrashOutcome({ context: input.telemetryContext });
	const runEffects = createRunEffectsRecorder(contractCwd, {
		scratchRoots: workerSettings.safety.scratchRoots,
		onWorkspaceChange: (toolCallId) => thrashOutcome.changed(toolCallId),
	});
	const acceptHelperResult = (data: unknown): string | null => {
		if (!input.resultContract) return "missing helper result contract";
		const validationInput = {
			contract: input.resultContract,
			data,
			cwd: contractCwd,
			observedReadRanges: groundingRanges(),
			networkAllowed: true,
			filesystem: nodeResultContractFilesystem(),
		};
		const checked = validateStructuredHelperResult({ ...validationInput, observedRunEffects: runEffects.snapshot() });
		if (checked.structured === null) {
			helperSemanticFailure = mutationResult && validateStructuredHelperResult(validationInput).structured !== null;
			return checked.validation.reason ?? "invalid helper result";
		}
		const unobserved = unobservedReportReason();
		if (unobserved !== null) return unobserved;
		acceptedHelperResult = checked.structured;
		emit({ type: "clio_coder_helper_result", payload: checked.structured });
		return null;
	};
	// The refusal reason alone cannot show what the model actually submitted.
	const reportRejectedHelperResult = (submitted: unknown, reason: string): void => {
		let text: string;
		try {
			text = JSON.stringify(submitted) ?? String(submitted);
		} catch {
			text = String(submitted);
		}
		emit({
			type: "clio_coder_helper_result_rejected",
			payload: { reason, submitted: text.slice(0, REJECTED_HELPER_RESULT_MAX_CHARS) },
		});
	};

	/**
	 * Fold one successful read into the observed spans. The request says where
	 * the model aimed; the result says how many lines it actually received.
	 * Only their combination is an honest span, because a byte-capped or
	 * end-of-file read returns less than the window that was asked for.
	 */
	const recordObservedRead = (
		request: ReadCitationRequest,
		result: unknown,
		visibleText: string | null = null,
	): void => {
		const observation = (result as { details?: { observation?: Record<string, unknown> } } | null)?.details?.observation;
		if (!observation) return;
		const returned = observation.shownCount;
		const total = observation.totalCount;
		if (typeof returned !== "number" || !Number.isFinite(returned) || returned <= 0) return;
		// A chain that cut the step showed the model its first complete lines
		// only: one output line per file line, so the newlines before the cut
		// count them, and a partial last line is not seen.
		const shown = visibleText === null ? returned : Math.min(returned, visibleText.split("\n").length - 1);
		if (shown <= 0) return;
		// A tail read lands at the end of the file, so it can only be placed once
		// the total line count is known; without it the span is dropped rather
		// than guessed, which costs a citation but never invents grounding.
		let start: number;
		if (request.tail) {
			if (typeof total !== "number" || !Number.isFinite(total)) return;
			start = Math.max(1, Math.floor(total) - returned + 1);
		} else {
			start = request.offset ?? 1;
		}
		const key = path.resolve(contractCwd, request.path);
		const spans = observedReadRanges.get(key) ?? [];
		spans.push([start, start + shown - 1] as const);
		observedReadRanges.set(key, spans);
	};

	/**
	 * Fold the lines a grep result showed into the grounding set. `visibleText`
	 * is the part of a chain-cut step the model saw; only lines shown there in
	 * full count.
	 */
	const recordObservedGrep = (details: unknown, visibleText: string | null = null): void => {
		const shown = (details as { observedLines?: unknown } | null)?.observedLines;
		if (shown === null || typeof shown !== "object" || Array.isArray(shown)) return;
		const visible = visibleText === null ? null : visibleGrepLineKeys(visibleText);
		for (const [file, lines] of Object.entries(shown as Record<string, unknown>)) {
			if (!Array.isArray(lines) || !path.isAbsolute(file)) continue;
			const bucket = observedGrepLines.get(file) ?? new Set<number>();
			for (const line of lines) {
				if (!Number.isInteger(line) || line <= 0) continue;
				if (visible !== null && !grepLineVisible(visible, file, line)) continue;
				bucket.add(line);
			}
			if (bucket.size > 0) observedGrepLines.set(file, bucket);
		}
	};

	/**
	 * The settled children of a chain, folded exactly as the direct calls
	 * would have been. Only a child its own admission ran to success grounds
	 * anything; a child refused by a run bound seals that bound. Pending and
	 * unresolved steps never ran and are never in the receipt list.
	 */
	const observeChainChildren = (toolName: string, result: unknown): void => {
		for (const child of gatewayChainReceipts(toolName, result)) {
			if (child.admission.outcome === "blocked") {
				if (child.admission.blockReason !== undefined) observeBoundReason(child.admission.blockReason);
				continue;
			}
			if (child.admission.outcome !== "ok") continue;
			const visibleText = chainStepVisibleText(child);
			if (child.capability === ToolNames.Read) {
				const request = readCitationRequest(child.args);
				if (request !== null) recordObservedRead(request, child.result, visibleText);
			} else if (child.capability === ToolNames.Grep || child.capability === ToolNames.Bash) {
				recordObservedGrep(child.result.details, visibleText);
			}
		}
	};

	/** Spans quoted back to the model, as `path:start-end`. */
	const observedReadAnchors = (): string[] =>
		[...observedReadRanges.entries()].flatMap(([key, spans]) =>
			spans.map(([start, end]) => `${path.relative(contractCwd, key) || key}:${start}-${end}`),
		);
	/** The run's next round is its handback round; the bound that triggered it is journaled as its kind (M3). */
	const enterHandback = (bound: HandbackTrigger): void => {
		phase.lockTools(bound);
		process.stderr.write(
			`[worker] handback: ${bound} reached the ${input.role ?? "run"}'s share; the next round reports\n`,
		);
		if (input.telemetryContext)
			telemetryHub().emit(
				"middleware.fired",
				{
					hook: "turn_start",
					phase: "sync",
					ruleId: "worker.handback",
					effects: ["lock_tools"],
					severity: "info",
					evidence: `bound:${bound}@worker`,
				},
				input.telemetryContext,
			);
	};
	/**
	 * A refusal whose reason is a run bound. Direct calls reach this through
	 * their blocked finish; a chain child the bound refused reaches it through
	 * the chain's receipt, because the aggregate settles as an ordinary error
	 * and its own finish cannot carry the child's verdict.
	 */
	const observeBoundReason = (reason: string): void => {
		// Lifetime-cap lockout ends tool use before the final report. Writers
		// retain the exhausted outcome; reporting workers can seal their synthesis.
		if (isWorkerToolCallCapSynthesisReason(reason)) {
			if (workerBudget.synthesis && deliveryTools.length === 0) {
				// DF-10: a reporting recipe's cap ends tool use; its sealed synthesis is the product.
				phase.lockTools("tools");
				process.stderr.write(`[worker] ${reason}\n`);
				return;
			}
			emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "worker_tool_call_cap_exhausted" } });
			if (phase.sealedBy === null) {
				phase.seal(reason);
				process.stderr.write(`[worker] ${reason}\n`);
			}
			return;
		}
		// Hard bounds: the legacy immediate cap abort (lockout not wired) and
		// the synthesis backstop for a model that keeps emitting tool calls
		// after the lock. Both end the run; the first recorded bound wins the
		// receipt diagnostic.
		if (isWorkerToolCallCapExceededReason(reason) || isLoopGuardSynthesisBackstopReason(reason)) {
			emit({
				type: "clio_coder_run_outcome",
				payload: {
					outcomeCode: isLoopGuardSynthesisBackstopReason(reason)
						? "loop_guard_tools_disabled_exhausted"
						: "worker_tool_call_cap_exhausted",
				},
			});
			if (workerBoundAborted) return;
			workerBoundAborted = true;
			phase.seal(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			abortWorkerForBound?.();
		}
	};
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "clio_coder_tool_start", payload: event });
		},
		onFinish(event) {
			if (event.toolCallId !== undefined) runEffects.checkOutcome(event.toolCallId, event.outcome, event.unresolved);
			emit({ type: "clio_coder_tool_finish", payload: event });
			if (event.outcome !== "blocked" || typeof event.reason !== "string") return;
			observeBoundReason(event.reason);
		},
	};
	const tools = resolveAgentTools({
		registry,
		...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
		telemetry,
		envelopeTools: activeWorkerTools,
		agentId: input.agentId,
		includeInteractiveTools: false,
		invokeOptions: (toolCallId) => ({
			...observedToolCallOrigin(agent.state.messages, toolCallId),
			...(input.telemetryContext === undefined
				? {}
				: {
						runId: input.telemetryContext.runId,
						...(input.telemetryContext.sessionId === null ? {} : { sessionId: input.telemetryContext.sessionId }),
						...(input.telemetryContext.turnId === undefined ? {} : { turnId: input.telemetryContext.turnId }),
					}),
			...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
			correlationId: `worker-model-round-${workerModelRound}`,
			toolResultMaxBytes: workerSettings.context.toolResultMaxBytes,
			// DESIGN 4.5: the run's own observation pool, sized from the usable window the last round measured.
			...(runObservationWindow !== undefined && input.telemetryContext !== undefined
				? { observationRunPool: runObservationPool(runObservationWindow) }
				: {}),
			// The worker's own model, resolved by the orchestrator, so hooks judge the worker by it.
			...(input.runtimeResolution !== undefined ? { model: snapshotModelInfo(input.runtimeResolution) } : {}),
			supportsImages: acceptsImageInput({
				runtimeId: input.runtime.id,
				vision: input.modelCapabilities?.vision,
				modelInput: model.input,
			}),
			// The admitted capability list, so the gateway calls only what the
			// recipe declared: the same bound the attached schemas already honor.
			allowedTools: input.allowedTools,
			...(agentSkillPolicy ? { pendingSkillPolicy: agentSkillPolicy } : {}),
		}),
	});
	const helperToolAvailable = helperSchema !== null && workerProviderSupportsTools(input);
	const helperForcedChoiceAvailable = helperToolAvailable && supportsNamedToolChoice(model.api);
	// Resolved snapshots lose the tool-addition boundaries; retain them so the
	// terminal handoff can reuse the work phase's cached prefix (#423).
	let nativeHelperContext:
		| {
				initial: SystemMessage;
				tools: Tool[];
				protocol: string;
				updates: Array<{ at: number; message: SystemMessage }>;
		  }
		| undefined;
	// Whether the first round's system prompt carried the helper protocol. Off native routes every later round keeps that
	// prompt byte for byte, so the prefix cache survives the handoff; phase notes ride the request tail (FL-16).
	let helperProtocolInPrefix: boolean | undefined;
	// The terminal handoff names its tool in the request, so it keeps the tool
	// surface that a synthesis lock would otherwise remove.
	const terminalHandoffActive = (api: string): boolean =>
		helperToolAvailable && (phase.toolsLocked || phase.resultForced) && supportsNamedToolChoice(api);
	if (helperToolAvailable) {
		tools.push({
			name: INTERNAL_HELPER_RESULT_TOOL,
			label: "Submit helper result",
			description:
				"Submit the final internal result as this tool's arguments. Call alone, after gathering evidence. A validated submission finishes the run; no prose response follows.",
			parameters: Type.Unsafe<Record<string, unknown>>(helperSchema),
			async execute(_id, args) {
				if (acceptedHelperResult !== null || phase.sealedBy !== null) {
					return {
						content: [{ type: "text", text: "The terminal result is already sealed." }],
						details: { kind: "error" },
						isError: true,
						terminate: true,
					};
				}
				phase.forceResult("result");
				phase.lockTools("result");
				helperTurnFailure = acceptHelperResult(args);
				if (helperTurnFailure !== null) {
					return { content: [{ type: "text", text: helperTurnFailure }], details: { kind: "error" }, isError: true };
				}
				return { content: [{ type: "text", text: "Internal result accepted." }], details: { kind: "ok" }, terminate: true };
			},
		});
	}
	if (tools.length === 0 && activeWorkerTools.length > 0) {
		process.stderr.write(`[worker] warning: no tools resolved for allowed=[${activeWorkerTools.join(",")}]\n`);
	}
	const effectiveThinkingLevel = clampThinkingLevelForModel(
		model,
		input.runtimeResolution?.effectiveThinkingLevel ?? input.thinkingLevel,
	);

	const inheritedMessages = seededWorkerMessages(input.contextSeed);
	/** What the run's observation pool is sized from, measured each round; tools a round calls read the latest. */
	let runObservationWindow: { usableTokens: number; workShare: number; inputTokens: number } | undefined;
	const contextGuard = createWorkerContextGuard(observations.archive, {
		aliasFloor: seedLineage.aliasFloor,
		archivePath: observations.archivePath,
		route: {
			...(input.runtimeResolution?.modelTier !== undefined ? { modelTier: input.runtimeResolution.modelTier } : {}),
			...(input.runtimeResolution?.promptCaching !== undefined
				? { promptCaching: input.runtimeResolution.promptCaching }
				: {}),
		},
		// Every fold decision is journaled under the run and forwarded on its receipt-bearing telemetry frame.
		onDecision: (decision) => {
			if (contextPressureWindow > 0 && decision.tokensBefore >= contextPressureWindow * THRASH_CONTEXT_FRACTION)
				contextPressureCrossed = true;
			if (input.telemetryContext) telemetryHub().emit("context.fold", decision, input.telemetryContext);
			// A committed fold removed results the loop guard's read coverage counts as shown (X5).
			if (decision.cause === "working_set_evict")
				loopGuardRegistration.evaluate({ hook: "on_compaction", metadata: { stage: "working_set_evict" } });
		},
	});
	// The constraint rides samplingParams, which the completions adapter merges
	// into the body after every named field.
	const workerResponseFormat = workerResponseFormatFor(input);
	// Cleared for the rest of the run when the server refuses the field, so a
	// contract round falls back to its prompt rather than failing.
	let contractResponseFormat = workerContractResponseFormatFor(input);
	// The helper protocol names its own terminal tool, so only a prose-parsed contract carries the reminder.
	const contractReminder =
		input.resultContract !== undefined && !helperToolAvailable ? resultContractReminder(input.resultContract) : null;
	const options: EngineAgentOptions = {
		// The run's restrictions are judged against the target as configured for
		// this run before each request, the same verdict the parent would reach.
		beforeStreamRequest: () => {
			workerTelemetry?.stage("admission", "start");
			const reason = flowTransferRefusal(
				safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
				runFlow,
				resolveModelDestination({
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					url: input.target.url ?? null,
					model: input.wireModelId,
				}),
			);
			workerTelemetry?.stage("admission", "end");
			if (reason === null) return { block: false };
			// A retry or failover on this target carries the same labels and meets
			// the same refusal, so the parent must not spend another attempt on it.
			if (!flowBlockReported) {
				flowBlockReported = true;
				emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "information_flow_blocked", detail: reason } });
			}
			return { block: true, reason };
		},
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (phase.lastRound !== null && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL)
				return { block: true, reason: WORKER_REFUSAL_REPORT_BLOCK };
			// The evidence repair reopened reading, not the whole work surface (M-31).
			if (
				evidenceRepairActive &&
				toolCall.name !== INTERNAL_HELPER_RESULT_TOOL &&
				!callRepeatsAsRead(toolCall.name, toolCall.arguments, () => undefined)
			)
				return {
					block: true,
					reason: "Only read-class tools run during this evidence repair. Read the inputs, then submit the result.",
				};
			if (helperSchema === null) return undefined;
			if (acceptedHelperResult !== null || phase.sealedBy !== null)
				return { block: true, reason: "The helper result is sealed.", terminate: true };
			if (mutationResult && toolCall.name === INTERNAL_HELPER_RESULT_TOOL && !helperExposedThisRound) {
				helperTurnFailure = "The terminal handoff is unavailable during work. Finish the work phase first.";
				return { block: true, reason: helperTurnFailure };
			}
			const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL) && calls.length !== 1) {
				helperTurnFailure =
					"Submit exactly one terminal handoff, alone; mixed or duplicate handoff batches are rejected without executing work.";
				return { block: true, reason: helperTurnFailure };
			}
			if ((phase.resultForced || phase.toolsLocked) && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL) {
				helperTurnFailure = "Work tools are disabled. Submit only the internal terminal result.";
				return { block: true, reason: helperTurnFailure };
			}
			return undefined;
		},
		// Pi decides the turn boundary here, before `turn_end` is emitted, so a
		// terminal-handoff repair that exhausts its budget must run here too.
		// Run from a `turn_end` subscriber, the exhausted bound arrived after the
		// decision and cost one extra provider request.
		finishTurn: ({ message, toolResults }) => {
			if (phase.lastRound !== null && workerModelRound >= phase.lastRound) return { action: "end" };
			if (
				helperSchema !== null &&
				acceptedHelperResult === null &&
				toolResults.length > 0 &&
				(toolResults.some((result) => result.toolName === INTERNAL_HELPER_RESULT_TOOL) ||
					(helperTerminalRequest && helperTurnFailure !== null)) &&
				(phase.resultForced || phase.toolsLocked)
			) {
				const error = toolResults.find((result) => result.isError);
				const reason =
					helperTurnFailure ??
					error?.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n") ??
					"The terminal handoff was not accepted.";
				// Every refused handoff, whether the contract, the tool schema or the batch rule refused it.
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === INTERNAL_HELPER_RESULT_TOOL)
						reportRejectedHelperResult(block.arguments, reason);
				}
				repairHelperResult(reason);
			}
			return helperSchema !== null && (acceptedHelperResult !== null || phase.sealedBy !== null)
				? { action: "end" }
				: undefined;
		},
		// Each round sends through engineStreamSimple, whose guard sees the evicted request.
		delegateGuardsToolArguments: true,
		streamFn: (currentModel, transcript, streamOptions) => {
			if (resultContractRepairsQueued > resultContractRepairsStarted) {
				resultContractRepairsStarted += 1;
				emit({ type: "clio_coder_repair_rounds_started", payload: { started: resultContractRepairsStarted } });
			}
			const round = ++responseRound;
			const resolvedContext = resolvedRequestContext(transcript);
			const anthropicCompat =
				currentModel.api === "anthropic-messages"
					? (currentModel.compat as AnthropicMessagesCompat | undefined)
					: undefined;
			const codexCompat =
				currentModel.api === "openai-codex-responses"
					? (currentModel.compat as OpenAIResponsesCompat | undefined)
					: undefined;
			const codexToolChanges =
				helperToolAvailable &&
				codexCompat?.supportsMidConvoSystemMessages === true &&
				codexCompat.supportsAdditionalTools === true;
			// Pi needs an active initial tool to anchor native additions (#423).
			const nativeToolChanges =
				(codexToolChanges && (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)) ||
				(anthropicCompat?.supportsMidConvoSystemMessages === true &&
					anthropicCompat.supportsMidConvoToolChanges === true &&
					(!mutationResult || (resolvedContext.tools ?? []).some((tool) => tool.name !== INTERNAL_HELPER_RESULT_TOOL)));
			const helperDeclaredFromStart =
				helperToolAvailable && currentModel.api === "anthropic-messages" && !nativeToolChanges;
			const helperProtocol = `Return the result by calling ${INTERNAL_HELPER_RESULT_TOOL} alone with the result object as arguments. Successful submission ends the run; no narrative report is needed.`;
			const withProtocol = (note: string) =>
				`${resolvedContext.systemPrompt ?? ""}\n\n# Internal helper protocol\n${helperProtocol}${note ? ` ${note}` : ""}`;
			// The lock decides the round's tool surface, prompt, tail and directive. A context handback flips the lock after
			// the guard, so the round is shaped again then and the crossing request carries the handoff helper or the
			// locked-synthesis directive like any locked round (M3).
			const shapeRound = () => {
				helperTerminalRequest = phase.toolsLocked || phase.resultForced;
				helperExposedThisRound =
					helperToolAvailable &&
					((!mutationResult && !codexToolChanges) || phase.toolsLocked || phase.resultForced) &&
					(!(phase.toolsLocked || phase.resultForced) || helperForcedChoiceAvailable);
				// Native additions hide the helper until handoff without rewriting the
				// initial schemas. Older Anthropic models declare it early; the host
				// still rejects premature submission during the work phase (#423).
				// A locked round that cannot name the helper keeps it declared when the work phase declared it: the
				// Copilot SDK keeps a locked round's tools, so dropping it alone changed the session's tool set and missed
				// the cached prefix (M-31). An API that can name it already exposes it here, so only such rounds change.
				const helperDeclaredInWork = helperToolAvailable && !mutationResult && !codexToolChanges;
				const currentContext = {
					...resolvedContext,
					tools: (resolvedContext.tools ?? []).filter(
						(tool) =>
							tool.name !== INTERNAL_HELPER_RESULT_TOOL ||
							helperExposedThisRound ||
							helperDeclaredFromStart ||
							helperDeclaredInWork,
					),
				};
				const helperOnRequest = helperExposedThisRound || helperDeclaredFromStart;
				const helperLockedNote =
					!helperDeclaredFromStart && (phase.toolsLocked || phase.resultForced)
						? "Work tools are disabled. Earlier tool-use instructions apply only to the completed work phase; only the terminal handoff remains available. Do not invent missing evidence."
						: "";
				helperProtocolInPrefix ??= helperOnRequest;
				// Native routes slice the protocol back out of this prompt into a mid-conversation section below; every other
				// route keeps the first round's prompt and carries a protocol or note that arrived later on the tail.
				const systemPrompt = nativeToolChanges
					? helperOnRequest
						? withProtocol(helperLockedNote)
						: currentContext.systemPrompt
					: helperProtocolInPrefix
						? withProtocol("")
						: currentContext.systemPrompt;
				const helperTail =
					nativeToolChanges || !helperOnRequest
						? ""
						: [helperProtocolInPrefix ? "" : `Internal helper protocol: ${helperProtocol}`, helperLockedNote]
								.filter((part) => part.length > 0)
								.join(" ");
				// A synthesis lock without the helper handoff carries its directive on the
				// request tail, so the system prompt keeps the work phase's bytes and a
				// prefix cache survives the lock.
				const synthesisDirective =
					phase.toolsLocked && !helperOnRequest
						? { requiredResult: input.resultContract ? resultContractShape(input.resultContract) : undefined }
						: undefined;
				// Priced with the tail directive the round will carry; only the estimate sees it here.
				const pricedSystemPrompt =
					synthesisDirective !== undefined
						? `${systemPrompt ?? ""}\n\n${lockedSynthesisDirective(synthesisDirective.requiredResult)}`
						: helperTail
							? `${systemPrompt ?? ""}\n\n${helperTail}`
							: (systemPrompt ?? "");
				return { currentContext, systemPrompt, helperTail, synthesisDirective, pricedSystemPrompt };
			};
			let shape = shapeRound();
			const window = input.runtimeResolution?.capabilities.contextWindow ?? currentModel.contextWindow;
			const { reminders } = withResultContractReminder(
				resolvedContext.messages,
				contractReminder,
				inheritedMessages.length,
			);
			const pressureFor = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) => ({
				messages: currentContext.messages,
				overheadTokens: reminders.reduce((sum, reminder) => sum + estimateAgentMessageTokens(reminder as AgentMessage), 0),
				systemPrompt: pricedSystemPrompt,
				tools: currentContext.tools ?? [],
				contextWindow: window,
				threshold: compactionBudget(
					window,
					workerSettings.context.compaction.threshold,
					workerSettings.context.compaction.maxTokens,
					currentModel,
				).threshold,
				target: workerSettings.context.workingSet.target,
				rearmFraction: workerSettings.context.workingSet.rearmFraction,
				autoEvict: workerSettings.context.compaction.auto && workerSettings.context.workingSet.enabled,
				outputReserve: (inputTokens: number) =>
					requestOutputReserve(currentModel, currentModel.maxTokens, window, inputTokens),
				unanchoredInputTokens: (history: ReadonlyArray<AgentMessage>) => {
					const context = normalizeContext({
						systemPrompt: pricedSystemPrompt,
						...(currentContext.tools !== undefined ? { tools: currentContext.tools } : {}),
						messages: withResultContractReminder([...history], contractReminder, inheritedMessages.length)
							.messages as Context["messages"],
					});
					// The same anchor rule `request` re-pins through: with one, Pi reads the guard's own count.
					return anchorContextAtInputTokens(context, 1) === context ? estimateContextTokens(context).tokens : 0;
				},
			});
			let pressure = pressureFor(shape);
			let messages: AgentMessage[];
			contextPressureWindow = window;
			try {
				messages = contextGuard(pressure);
			} catch (error) {
				if (error instanceof WorkerContextExhaustedError) {
					phase.sealOver(error.message);
					// The parent seals this with the run's last narration, so a run that dies at the wall still hands back
					// what it changed (CLI-H3).
					emit({
						type: "clio_coder_run_outcome",
						payload: {
							outcomeCode: "worker_context_exhausted",
							detail: exhaustedChangesDetail(runEffects.snapshot().mutatedPaths, contractCwd),
						},
					});
				}
				throw error;
			}
			// A request admitted without a fold reports no decision, so the thrash share reads the admitted count too.
			if (window > 0 && contextGuard.inputTokens >= window * THRASH_CONTEXT_FRACTION) contextPressureCrossed = true;
			let handbackSurfaceTokens = 0;
			if (window > 0) {
				runObservationWindow = {
					usableTokens:
						window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens),
					workShare: input.role !== undefined ? workShare(input.role) : (input.limits?.context.workShare ?? 1),
					inputTokens: contextGuard.inputTokens,
				};
			}
			// M3: a run with a role hands back at its role's share of the usable window instead of dying at the wall.
			if (window > 0 && input.role !== undefined && !phase.toolsLocked) {
				const usable =
					window - requestOutputReserve(currentModel, currentModel.maxTokens, window, contextGuard.inputTokens);
				if (contextGuard.inputTokens >= usable * noteShare) contextPressureCrossed = true;
				if (contextGuard.inputTokens >= usable * workShare(input.role)) {
					enterHandback("context");
					const surfaceTokens = ({ currentContext, pricedSystemPrompt }: ReturnType<typeof shapeRound>) =>
						estimateContextTokens(
							normalizeContext({ systemPrompt: pricedSystemPrompt, tools: currentContext.tools ?? [], messages: [] }),
						).tokens;
					const unlocked = shape;
					shape = shapeRound();
					pressure = pressureFor(shape);
					// The guard admitted the history under the work phase's surface; the handoff's helper and directive add to it.
					handbackSurfaceTokens = Math.max(0, surfaceTokens(shape) - surfaceTokens(unlocked));
				}
			}
			const { currentContext, systemPrompt, helperTail, synthesisDirective } = shape;
			// Stable sampling applies to every context-generation round, terminal
			// repairs included. It merges over the caller's options so it beats quirk
			// profiles and run overrides, which the adapters apply underneath.
			const sampling =
				input.sampling === "deterministic" ? deterministicSampling(currentModel, input.runtime.id) : undefined;
			// A final-only round (synthesis lock or final-only repair) ships no tools,
			// so a contract's schema can bind it without meeting a tool grammar.
			const contractFormat =
				contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable
					? contractResponseFormat
					: undefined;
			const optionsWith = (responseFormat: Record<string, unknown> | undefined) =>
				sampling === undefined && responseFormat === undefined
					? streamOptions
					: {
							...streamOptions,
							...sampling,
							samplingParams: {
								...streamOptions?.samplingParams,
								...sampling?.samplingParams,
								...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
							},
						};
			let requestOptions = optionsWith(workerResponseFormat ?? contractFormat);
			// Routed per attempt: the lock and the middleware choice can flip between
			// the first call and the overflow retry. The terminal handoff comes first
			// because it names its tool and keeps the surface a lock would remove. A
			// locked round has no declarations left, so neither middleware round
			// applies to it.
			// A refreshed credential replaces the one Pi resolved for this round; the
			// next round resolves its own through getApiKey (#427).
			let roundApiKey: string | undefined;
			// `inputTokens` is the count the guard admitted `history` at; admission and the clamp size it from that.
			const request = (history: AgentMessage[], inputTokens: number) => {
				const projected = withResultContractReminder(history, contractReminder, inheritedMessages.length).messages;
				const middlewareChoice = middlewareToolChoice.current();
				// Codex retains the work phase's parallel setting for WS deltas;
				// beforeToolCall still rejects mixed or duplicate handoffs (#423).
				const controlled = applyToolRounds(
					currentModel,
					{
						...currentContext,
						...(systemPrompt !== undefined ? { systemPrompt } : {}),
						messages: projected as typeof currentContext.messages,
					},
					roundApiKey === undefined ? requestOptions : { ...requestOptions, apiKey: roundApiKey },
					[
						terminalHandoffActive(currentModel.api)
							? { kind: "required", toolName: INTERNAL_HELPER_RESULT_TOOL, handoff: !codexToolChanges }
							: undefined,
						phase.toolsLocked ? { kind: "tools-removed" } : undefined,
						middlewareChoice.kind === "none" && !phase.toolsLocked ? { kind: "text-only" } : undefined,
						middlewareChoice.kind === "required" && !phase.toolsLocked
							? { kind: "required", toolName: middlewareChoice.toolName }
							: undefined,
					],
					input.target.id,
				);
				let requestContext: Context = controlled.context;
				if (helperToolAvailable && nativeToolChanges) {
					const basePrompt = currentContext.systemPrompt ?? "";
					// A semantic repair may spend the existing authorized revision
					// allowance. Reopen that phase by policy, never by erasing history (#423).
					const protocol =
						codexToolChanges && resultContractRevisionActive && !helperTerminalRequest
							? "The host-authorized bounded revision phase is active. Work tools may run within its remaining allowance. Earlier work-closed instructions resume when the terminal handoff begins again."
							: codexToolChanges && evidenceRepairActive && !helperTerminalRequest
								? "The host reopened the read-class tools for an evidence repair. Read the inputs the assignment names, then begin the terminal handoff again."
								: (systemPrompt ?? "").slice(basePrompt.length);
					// Codex can append declarations but cannot replay removals without
					// collapsing them into the leading item. Execution remains gated by
					// beforeToolCall even though the work declarations stay in history (#423).
					const requestTools = codexToolChanges
						? [
								...new Map(
									[...(nativeHelperContext?.tools ?? []), ...(currentContext.tools ?? [])].map((tool) => [tool.name, tool]),
								).values(),
							]
						: (resolvedRequestContext(controlled.context).tools ?? []);
					if (nativeHelperContext === undefined || nativeHelperContext.initial.content !== basePrompt) {
						nativeHelperContext = {
							initial: {
								role: "system",
								content: basePrompt,
								sections: { helper: protocol },
								toolsAdded: requestTools,
								timestamp: 0,
							},
							tools: requestTools,
							protocol,
							updates: [],
						};
					} else {
						const changes = getToolStateChanges(nativeHelperContext.tools, requestTools);
						if (
							changes.toolsAdded.length > 0 ||
							changes.toolsRemoved.length > 0 ||
							nativeHelperContext.protocol !== protocol
						) {
							const policy = codexToolChanges
								? (createHostPolicyMessage(
										`worker-handoff-${nativeHelperContext.updates.length}`,
										protocol,
										0,
									) as SystemMessage)
								: { role: "system" as const, content: "", sections: { helper: protocol }, timestamp: 0 };
							nativeHelperContext.updates.push({
								at: projected.length,
								message: { ...policy, ...changes },
							});
							nativeHelperContext.tools = requestTools;
							nativeHelperContext.protocol = protocol;
						}
					}
					const nativeMessages: Context["messages"] = [nativeHelperContext.initial];
					let start = 0;
					for (const update of nativeHelperContext.updates) {
						nativeMessages.push(...projected.slice(start, update.at), update.message);
						start = update.at;
					}
					nativeMessages.push(...projected.slice(start));
					requestContext = { messages: nativeMessages };
				}
				// Pi's SDK adapters report onResponse only for a 2xx answer, so the
				// status is read at the fetch boundary every adapter routes through.
				return streamToolRound(
					currentModel,
					{ ...controlled, context: requestContext },
					(attempt) => {
						const roundKind = attempt.toolRounds?.[0]?.kind ?? "normal";
						const choice = attempt.options?.toolChoice;
						const toolName = attempt.toolRounds?.[0]?.toolName;
						workerTelemetry?.attempt({
							roundKind,
							toolChoice: choice === "auto" || choice === "none" ? choice : toolName ? { name: toolName } : "auto",
							...(attempt.options?.samplingParams?.response_format !== undefined
								? { responseFormat: "json-schema" as const }
								: {}),
							...requestedThinking(effectiveThinkingLevel),
						});
						// Every attempt of a locked round carries the same tail directive, as does the "auto" form of a
						// middleware text lock; the system prompt and earlier messages keep their bytes.
						// The guard projected this history without invalidating the usage Pi anchors on, so the
						// provider-bound copy is re-anchored at the guard's count (A2c).
						const attemptContext = anchorContextAtInputTokens(
							synthesisDirective !== undefined
								? withLockedSynthesisDirective(attempt.context, synthesisDirective.requiredResult)
								: helperTail
									? withRequestTailDirective(attempt.context, helperTail)
									: middlewareChoice.kind === "none" && attempt.options?.toolChoice === "auto"
										? withLockedSynthesisDirective(attempt.context)
										: attempt.context,
							inputTokens,
						);
						const fetchImpl = attempt.options?.fetch ?? ((url, init) => globalThis.fetch(url, init));
						const tracking = trackCallFetch(fetchImpl);
						callTracking = tracking;
						callUsageReported = false;
						roundProviderHttpStatus = null;
						tracking.start(currentModel.api, attempt.options?.transport);
						const lockedRound = phase.toolsLocked || phase.resultForced;
						const attemptOptions = { ...attempt.options, clioInputTokens: inputTokens };
						const { reasoning: _reasoning, thinkingBudgets: _thinkingBudgets, ...thinkingOffOptions } = attemptOptions;
						// Responses APIs render the reasoning effort ahead of the whole input, and Pi sends the model's off effort
						// (and no encrypted reasoning) when the level is dropped, so a locked round there keeps the run's level:
						// dropping it made a Codex round miss every cached token and turned thinking off mid-run (FL-16). On copilot-sdk
						// the dropped level became a setModel on the live session, which read none of its cached prefix (M-20).
						const source = boundWorkerResponse(
							currentModel,
							attemptContext,
							lockedRound && !REASONING_PREFIX_APIS.has(currentModel.api) ? thinkingOffOptions : attemptOptions,
							{
								locked: lockedRound,
								responseSeconds:
									input.limits !== undefined
										? input.limits.time.responseMs / 1000
										: workerSettings.safety.limits.workerResponseSeconds,
								round,
								onLimit: (outcomeCode, detail) => {
									phase.seal(detail);
									emit({ type: "clio_coder_run_outcome", payload: { outcomeCode, detail } });
								},
							},
							(boundedOptions) =>
								engineStreamSimple(currentModel, attemptContext, {
									...boundedOptions,
									fetch: async (url, init) => {
										const response = await tracking.fetch(url, init);
										lastProviderHttpStatus = response.status;
										roundProviderHttpStatus = response.status;
										// Pi retries a retryable status inside one attempt; the response that opens the stream is
										// the first byte (#434).
										if (response.ok) workerTelemetry?.mark("firstByte");
										return response;
									},
									onProviderStreamEvent: async (data, eventModel) => {
										// Wire-field presence distinguishes reported zero from SDK placeholders (#434).
										if (data !== null && typeof data === "object") {
											const frame = data as Record<string, unknown>;
											for (const value of [frame, frame.message, frame.response]) {
												if (value === null || typeof value !== "object") continue;
												const usage = (value as Record<string, unknown>).usage;
												if (usage === null || typeof usage !== "object") continue;
												callUsageReported ||= hasTokenUsageCounts(usage as Record<string, unknown>);
											}
										}
										await boundedOptions?.onProviderStreamEvent?.(data, eventModel);
									},
								}),
						);
						return (
							workerTelemetry?.observe(source, (message) => {
								const aborted = input.signal?.aborted || (message as { stopReason?: unknown } | null)?.stopReason === "aborted";
								const failure = tracking.failure(message, aborted, callUsageReported);
								const harness = aborted
									? (workerStopCause ?? (input.signal?.aborted ? "parent_cancel" : undefined))
									: undefined;
								return harness ? { ...failure, stage: "harness", errorClass: harness } : failure;
							}) ?? source
						);
					},
					input.target.id,
				);
			};
			// A token the server rejects as expired earns one locked refresh and one
			// retry of the same request, as the main turn does; a failed refresh ends
			// the round with the login remedy (#427).
			const admitted = contextGuard.inputTokens + handbackSurfaceTokens;
			const authRetried = retryStreamOnceOnAuthRejection(
				request(messages, admitted),
				(error) => isProviderAuthRejection(error.errorMessage, roundProviderHttpStatus ?? undefined),
				async () => {
					const apiKey = await refreshWorkerOAuthKey();
					if (apiKey === null) return null;
					roundApiKey = apiKey;
					return request(messages, admitted);
				},
			);
			// A server that refuses the contract's schema before answering gets the
			// same round once without it; the prompt and validator still hold the
			// contract, and later rounds stop sending the field.
			const first =
				contractFormat === undefined
					? authRetried
					: retryStreamOnceOnAuthRejection(
							authRetried,
							(error) => isResponseSchemaRejection(error.errorMessage),
							async () => {
								contractResponseFormat = undefined;
								requestOptions = optionsWith(workerResponseFormat);
								return request(messages, admitted);
							},
						);
			// The server is the authority on its own limit. An unreported window, a
			// window that changed since it was resolved, or a server tokenizer that
			// counts above Clio's estimate all surface as a server overflow. It earns
			// one reversible eviction and one retry; a second overflow is final.
			return retryStreamOnceOnOverflow(first, () => {
				const projected = contextGuard.recover(pressure);
				return projected ? request(projected, contextGuard.inputTokens) : null;
			});
		},
		initialState: {
			systemPrompt: input.systemPrompt,
			model,
			thinkingLevel: effectiveThinkingLevel,
			tools,
			messages: inheritedMessages,
		},
		getApiKey: async () => {
			workerTelemetry?.stage("transform", "end");
			// A key the parent handed over needs no resolution, so the call has no auth stage (#434).
			if (!input.authProfile) return input.apiKey;
			workerTelemetry?.stage("auth", "start");
			let refreshed: boolean | undefined;
			try {
				registerClioOAuthProviders();
				const resolved = await openAuthStorage().resolveApiKey(input.authProfile, {
					includeFallback: false,
					...(input.signal ? { signal: input.signal } : {}),
				});
				refreshed = resolved.refreshed;
				if (!resolved.available || !resolved.apiKey) {
					throw new Error(resolved.detail ?? `Credential '${input.authProfile}' is unavailable. Log in again.`);
				}
				lastAuthResolution = resolved;
				return resolved.apiKey;
			} finally {
				workerTelemetry?.stage("auth", "end", refreshed === undefined ? {} : { refreshed });
			}
		},
	};
	// Providers derive prompt-cache affinity (openai-codex prompt_cache_key,
	// session headers) from the session ID. Without one every worker call
	// landed cold: captured Luna workers read 48% of input from cache against
	// the main agent's 89%. One opaque ID per invocation keeps it out of the
	// prompt, so prompt and tool attestation hashes are unchanged. Where the
	// backend routes to its cache by that ID, workers with one stable head and
	// cache lane take the same one, so a later worker reads the head an earlier
	// one wrote (FL-17).
	options.sessionId =
		input.sessionId ||
		workerCacheFamilyId({
			api: model.api,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: effectiveThinkingLevel,
			systemPrompt: input.systemPrompt,
			tools,
			lane: input.cacheLane ?? 0,
		}) ||
		randomUUID();
	// That id may be the parent's: a worker leaves the parent's resumable Copilot conversation alone (bt-10).
	disableCopilotConversationResume();

	const { agent } = createEngineAgent(options);
	// Pi adds a leading prompt/tool declaration; exclude the entire inherited baseline.
	const inheritedCount = agent.state.messages.length;
	// The result-contract repair queues a call/result pair that must land in
	// one drain, or the provider sees a lone assistant tool call. Operator
	// steers batch the same way the main agent's do: all at the next slot.
	agent.followUpMode = "all";
	agent.steeringMode = "all";
	abortWorkerForBound = () => {
		workerStopCause ??= "loop_guard";
		agent.abort();
	};
	// Qwopus 3.8 explored context init's whole 240 s ceiling one read at a time and was
	// aborted before submitting. A host deadline ends exploration while the terminal round fits.
	const synthesisTimer =
		input.synthesisAt === undefined
			? undefined
			: setTimeout(
					() => {
						phase.lockTools("synthesis");
					},
					Math.max(0, input.synthesisAt - Date.now()),
				);
	synthesisTimer?.unref();
	// DESIGN 4.5: at 85% of the wall clock the next round is the handback round, and the host stops the run at the
	// wall. A run the wall clock moved to handback seals timed_out with what it reports (fleet M8).
	const wallLimits = input.limits?.time;
	const wallTimer =
		wallLimits === undefined
			? undefined
			: setTimeout(
					() => {
						if (phase.sealedBy !== null) return;
						enterHandback("time");
						emit({
							type: "clio_coder_run_outcome",
							payload: {
								outcomeCode: "worker_run_timeout",
								detail: `worker_run_timeout: the run reached ${Math.round(WALL_HANDBACK_SHARE * 100)}% of its ${Math.round(wallLimits.wallMs / 1000)} s wall clock; its tools are withdrawn and its next round is its report`,
							},
						});
					},
					Math.max(0, wallLimits.handbackAt - Date.now()),
				);
	wallTimer?.unref();
	const repairHelperResult = (reason: string): void => {
		const workOpen = handoffFromOpenWork || (!phase.toolsLocked && !phase.resultForced);
		handoffFromOpenWork = false;
		if (!input.resultContract || acceptedHelperResult !== null || phase.sealedBy !== null) return;
		if (phase.lastRound !== null) return;
		phase.forceResult("result");
		phase.lockTools("result");
		if (resultContractRepairsStarted >= RESULT_CONTRACT_REPAIR_LIMIT) {
			phase.sealOver(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${reason}`);
			emit({
				type: "clio_coder_run_outcome",
				payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
			});
			return;
		}
		// #425: rejected sibling handoffs share one repair request; queuing it is not running it.
		if (resultContractRepairsQueued > resultContractRepairsStarted) return;
		resultContractRepairsQueued += 1;
		// M-31: a result rejected for missing evidence, or before anything ran, is repaired by reading. The round keeps
		// the work phase's declarations and request shape, so the cached prefix survives; admission narrows it to reads.
		const readFirst = evidenceRepairFor(reason, workOpen);
		if (readFirst) {
			evidenceRepairActive = true;
			phase.releaseResult();
			phase.unlockTools();
		}
		// Only semantic failures may spend the preauthorized revision allowance after terminal lock.
		if (helperSemanticFailure && !resultContractRevisionActive && workerBudget.revision !== undefined) {
			resultContractRevisionActive = loopGuardRegistration.extendWorkerToolCallPhase(workerBudget.revision);
			if (resultContractRevisionActive) {
				phase.releaseResult();
				phase.unlockTools();
				middlewareToolChoice.reset();
				stopAfterToolResultCallId = null;
			}
		}
		const revisionToolsAvailable = !phase.toolsLocked;
		const instruction = readFirst
			? evidenceRepairInstruction(reason, `submit the result again with ${INTERNAL_HELPER_RESULT_TOOL}`)
			: helperForcedChoiceAvailable && !revisionToolsAvailable
				? `${reason} Work tools remain disabled. Repair the result by calling ${INTERNAL_HELPER_RESULT_TOOL} exactly once, alone, with the complete result object. Do not emit prose.`
				: reason;
		for (const message of resultContractRepairMessages(
			{
				contract: input.resultContract,
				reason: instruction,
				attempt: resultContractRepairsQueued,
				anchors: observedReadAnchors(),
				toolsAvailable: revisionToolsAvailable,
			},
			{ provider: model.provider, api: model.api, model: model.id },
		)) {
			const repairMessage =
				helperForcedChoiceAvailable && !mutationResult && !revisionToolsAvailable && message.role === "toolResult"
					? {
							...message,
							content: [
								{
									type: "text" as const,
									text: `${instruction}\nRequired arguments schema: ${JSON.stringify(helperSchema)}\nObserved read ranges: ${observedReadAnchors().join(", ") || "none"}`,
								},
							],
						}
					: message;
			// A reopened round continues on the rejected handoff's tool result, so its instruction rides the steering
			// queue, which lands before that request; a follow-up would wait for the run to stop (M-31).
			if (readFirst) agent.steer(repairMessage as unknown as AgentMessage);
			else agent.followUp(repairMessage as unknown as AgentMessage);
		}
	};
	const unsubscribe = agent.subscribe(async (event) => {
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			!phase.toolsLocked &&
			phase.sealedBy === null &&
			phase.lastRound === null
		) {
			const reminder = middlewareToolChoice.completeRound(event.message);
			if (reminder !== null) {
				if (!hostWrittenExchange(event.message)) workerTelemetry?.settle(event.message);
				// This answer is a request the thrash note may have ridden, though the round ends here.
				thrashOutcome.observe(event);
				// The middleware round must run before this answer can seal a terminal result (#423).
				const tail: AgentMessage = { role: "user", content: reminder, timestamp: Date.now() };
				if (event.message.content.some((block) => block.type === "toolCall")) agent.steer(tail);
				else agent.followUp(tail);
				emit(event);
				return;
			}
		}
		if (event.type === "turn_start") {
			const choice = middlewareToolChoice.current();
			const handoff = terminalHandoffActive(model.api);
			workerTelemetry?.begin({
				roundKind: handoff
					? "required"
					: phase.toolsLocked
						? "tools-removed"
						: choice.kind === "none"
							? "text-only"
							: choice.kind === "required"
								? "required"
								: "normal",
				toolChoice: handoff
					? { name: INTERNAL_HELPER_RESULT_TOOL }
					: phase.toolsLocked || choice.kind === "none"
						? "none"
						: choice.kind === "required"
							? { name: choice.toolName }
							: "auto",
				// The same predicate streamFn applies to this round's request.
				...(workerResponseFormat !== undefined ||
				(contractResponseFormat !== undefined && phase.toolsLocked && !helperToolAvailable)
					? { responseFormat: "json-schema" as const }
					: {}),
				...requestedThinking(effectiveThinkingLevel),
			});
			callTracking = null;
			callUsageReported = false;
			workerModelRound += 1;
			helperTurnFailure = null;
			helperSemanticFailure = false;
		}
		if (
			event.type === "message_end" &&
			isAssistantMessage(event.message) &&
			(event.message.usage as unknown as Record<string, unknown>).callInvoked !== false
		) {
			const message = event.message as unknown as Record<string, unknown>;
			const usage = event.message.usage as unknown as Record<string, unknown>;
			const reported = callUsageReported || normalizeTokenUsage(usage).observed;
			const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
			const failure = failed
				? (callTracking?.failure(event.message, event.message.stopReason === "aborted", reported) ??
					classifyCallFailure(event.message, { invoked: false }))
				: undefined;
			if (failure !== undefined) message.failure = failure;
			usage.callInvoked = failure?.invoked ?? true;
			usage.usageReported = reported;
		}
		// A repair exchange Clio wrote into the conversation reached no provider: the round's attempt belongs to the request
		// that follows it, so it settles no attempt of its own (C-28).
		if (event.type === "message_end" && isAssistantMessage(event.message) && !hostWrittenExchange(event.message))
			workerTelemetry?.settle(event.message);
		// Detect the whole terminal batch before any call is prepared/executed.
		// beforeToolCall rejects every sibling, regardless of ordering or parallelism.
		if (helperSchema !== null && event.type === "message_end" && isAssistantMessage(event.message)) {
			const calls = event.message.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL)) {
				handoffFromOpenWork = !phase.toolsLocked && !phase.resultForced;
				phase.forceResult("result");
				phase.lockTools("result");
				if (calls.length !== 1)
					helperTurnFailure = "Submit exactly one terminal handoff, alone; mixed or duplicate batches cannot execute work.";
			}
		}
		if (event.type === "tool_execution_start" && event.toolName !== INTERNAL_HELPER_RESULT_TOOL) {
			toolExecutionsStarted += 1;
			middlewareToolChoice.toolStarted(event.toolName, event.args);
		}
		// Read spans this run actually observed. They ground the terminal result
		// (a cited line has to fall inside one) and they are handed back verbatim
		// in a repair round, so re-emitting findings never invites invention.
		// Effects and grounding come from the capability operations that
		// settled: a gateway op=call as the capability it ran, a chain as each
		// admitted child, once each. Provider replay keeps the wire records.
		// The result submission is this run's handoff, never a workspace call, so it opens no write record (C-14).
		if (
			(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
			!(helperToolAvailable && event.toolName === INTERNAL_HELPER_RESULT_TOOL)
		) {
			recordToolExecutionEffects(runEffects, event);
		}
		// After the effects, so a call that changed the workspace has settled the note under its own id first.
		thrashOutcome.observe(event);
		if (event.type === "tool_execution_start") {
			const call = effectiveToolCall(event.toolName, event.args);
			if (call.toolName === ToolNames.Read) {
				const request = readCitationRequest(call.args);
				if (request !== null) pendingReadCitations.set(event.toolCallId, request);
			} else if (call.toolName === ToolNames.Grep || call.toolName === ToolNames.Bash) {
				// A bash `grep -n` reports the lines it printed as observedLines, as the grep tool does (FL-12).
				pendingGrepCalls.add(event.toolCallId);
			} else if (
				call.toolName === ToolNames.Context &&
				call.args?.scope === "recall" &&
				typeof call.args.ref === "string"
			) {
				pendingRecallCalls.add(event.toolCallId);
			}
		}
		if (event.type === "tool_execution_end") {
			const request = pendingReadCitations.get(event.toolCallId);
			pendingReadCitations.delete(event.toolCallId);
			const grepped = pendingGrepCalls.delete(event.toolCallId);
			if (event.isError !== true) {
				if (request !== undefined) recordObservedRead(request, event.result);
				if (grepped) recordObservedGrep((event.result as { details?: unknown } | null)?.details);
			}
			observeChainChildren(event.toolName, event.result);
			// Only a recall that returned an archived observation brings evicted content back.
			if (pendingRecallCalls.delete(event.toolCallId) && event.isError !== true) evictedRecalls += 1;
			// One recall or context host turn per run and one streak turn per run, delivered after this tool batch, never
			// once the run is answering or bound. A standing streak note holds back the other causes until progress.
			const thrashCause =
				evictedRecalls > THRASH_RECALL_LIMIT
					? ("recall" as const)
					: contextPressureCrossed && runEffects.snapshot().mutatedPaths.size === 0
						? ("context" as const)
						: null;
			const cause =
				thrashCause !== null && !thrashNudged && !streakNoteOpen
					? thrashCause
					: readStreakEscalated > 0 && !streakNudged && !thrashNudged
						? ("streak" as const)
						: null;
			if (
				cause !== null &&
				!phase.toolsLocked &&
				!phase.resultForced &&
				phase.sealedBy === null &&
				phase.lastRound === null
			) {
				if (cause === "streak") {
					streakNudged = true;
					streakNoteOpen = true;
				} else thrashNudged = true;
				agent.steer({
					role: "user",
					content: thrashHostNote(
						cause,
						cause === "streak" ? readStreakEscalated : evictedRecalls,
						workerCanWrite,
						input.role !== undefined,
						workerCanPlan,
					),
					timestamp: Date.now(),
				});
				process.stderr.write(
					`[worker] thrash guard: ${cause === "recall" ? `${evictedRecalls} recalls of evicted observations` : cause === "streak" ? `${readStreakEscalated} read-only calls in a row` : "context past the thrash share with no change"}; told the worker to write now or report\n`,
				);
				if (input.telemetryContext)
					telemetryHub().emit(
						"middleware.fired",
						{
							firingId: thrashOutcome.fire(),
							hook: "after_tool",
							phase: "sync",
							ruleId: "worker.thrash",
							effects: ["inject_reminder"],
							severity: "warn",
							evidence:
								cause === "recall"
									? "count:evicted-recall@worker"
									: cause === "streak"
										? "count:read-class-calls@worker"
										: "share:context-window@worker",
							...(cause === "recall" ? { tool: ToolNames.Context } : {}),
						},
						input.telemetryContext,
					);
			}
			// The streak's second step is judged at the tool end that raised it, never carried to a later call.
			readStreakEscalated = 0;
		}
		// Synthesis-locked run: the round ships no tool surface, so a model that
		// calls a tool anyway lands its chat template's tool-call syntax in the
		// reply as plain text. Sanitize the finished message in place before it
		// hits stdout; pi stores this same object in agent state, so the NDJSON
		// event, the dispatch consumer's answer reconstruction, and any later
		// provider round all see the same text.
		// A markup-only locked reply re-prompted this round; the result-contract
		// check below stands aside so the round costs the one re-prompt, not one
		// of the contract's bounded repair slots (on ornith both were queued for
		// the same message and the run then ran out of repairs on a later
		// grounding violation).
		let repromptedThisMessage = false;
		if (
			phase.sealedBy === null &&
			phase.lastRound === null &&
			phase.toolsLocked &&
			!helperToolAvailable &&
			event.type === "message_end"
		) {
			const stripped = sanitizeLockedSynthesisMessage(event.message);
			// A model that calls a tool anyway hands its markup back as text and
			// the sanitizer leaves only the fallback notice: the training habit
			// survives the strip (Qwen3.8 did it in 1 of 5 stripped runs). One
			// re-prompt, delivered as a tool exchange like the result-contract
			// repair, asks for the required result format; a second markup-only reply
			// keeps the notice.
			if (stripped && lockedSynthesisReprompts < 1 && isLockedSynthesisFallbackOnly(event.message)) {
				lockedSynthesisReprompts += 1;
				repromptedThisMessage = true;
				process.stderr.write(
					"[worker] synthesis lock: reply was tool-call markup only; re-prompting once for the required final format\n",
				);
				const directive = lockedSynthesisRepromptMessages(
					lockedSynthesisReprompts,
					{ provider: model.provider, api: model.api, model: model.id },
					input.resultContract ? resultContractShape(input.resultContract) : undefined,
				).find((message) => message.role === "toolResult");
				if (directive?.role === "toolResult") {
					agent.followUp({ role: "user", content: directive.content, timestamp: Date.now() } as AgentMessage);
				}
			}
		}
		// Bounded terminal-contract repair, on whichever message ends the run.
		// A worker that finishes inside its budget never trips the synthesis
		// lock, so gating this on the lock would skip repair on exactly the
		// well-behaved runs it exists to save. The orchestrator validates the
		// same contract against the sealed receipt; this is the only point at
		// which the model can still act on the validator's reason.
		// The report after the refusal limit gets no repair round; dispatch judges it as it stands.
		const contract = phase.lastRound === null ? input.resultContract : undefined;
		if (
			helperSchema !== null &&
			!mutationResult &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			const text = assistantMessageText(event.message);
			let submitted: unknown;
			let reason: string | null;
			let refused = false;
			try {
				submitted = JSON.parse(text ?? "");
				reason = acceptHelperResult(submitted);
				refused = reason !== null;
			} catch {
				reason = "The internal result must be a JSON object conforming to the declared contract.";
			}
			if (refused && reason !== null) reportRejectedHelperResult(submitted, reason);
			if (reason !== null) repairHelperResult(reason);
		}
		if (
			(helperSchema === null || mutationResult) &&
			acceptedHelperResult === null &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			// A file-scoped coder sometimes ends its first reply with no tool call and a
			// report that it has no edit tool or cannot find the file (p8/S1, p9/C3),
			// then does the same work when asked again. The orchestrator fails every
			// zero-call edit run as obligation_unmet, so one repair round costs nothing
			// the run had left. A second empty reply passes through to that outcome.
			const zeroToolViolation =
				toolExecutionsStarted === 0 &&
				!zeroToolRepairQueued &&
				contract.kind === "mutation-report" &&
				input.readOnly !== true &&
				workerBudget.mode === "advisory" &&
				!phase.toolsLocked &&
				activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write)
					? `no tool was called, so none of the assignment was done. The admitted tools are ${activeWorkerTools.join(", ")}, and they include ${activeWorkerTools.filter((tool) => tool === ToolNames.Edit || tool === ToolNames.Write).join(" and ")}. Inspect the workspace and do the assignment with them. If a tool refuses a call, report that refusal as the limitation.`
					: null;
			// A second no-work reply belongs to obligation_unmet, even when its
			// report is malformed. The p8/S1 recovery must not spend shape repairs.
			const contractViolation =
				zeroToolRepairQueued && toolExecutionsStarted === 0
					? null
					: (zeroToolViolation ??
						terminalContractViolation(contract, event.message, contractCwd, groundingRanges(), runEffects.snapshot()) ??
						(mutationResult ? null : unobservedReportReason()));
			// A well-formed gate verdict that cites none of its packet is asked once, with the ids that exist (M10). The
			// grader still seals a second uncited verdict exhausted, so this round never stands in for that rule.
			const citationViolation =
				contractViolation === null &&
				!citationRepairQueued &&
				!(zeroToolRepairQueued && toolExecutionsStarted === 0) &&
				resultContractRepairsQueued < RESULT_CONTRACT_REPAIR_LIMIT
					? gateCitationViolation(contract, assistantMessageText(event.message))
					: null;
			if (citationViolation !== null) citationRepairQueued = true;
			const violation = contractViolation ?? citationViolation;
			const formatFailure =
				mutationResult &&
				violation !== null &&
				zeroToolViolation === null &&
				validateResultContract({
					contract,
					output: assistantMessageText(event.message),
					cwd: contractCwd,
					networkAllowed: true,
					filesystem: nodeResultContractFilesystem(),
				}).conformance === "fail";
			if (helperSchema !== null && zeroToolRepairQueued && toolExecutionsStarted === 0) {
				// An unsealed helper would otherwise hide the parent's no-work classification behind a generic failed exit.
				// Without a helper the worker exits clean and the parent's grader seals obligation_unmet from the empty tool activity.
				phase.sealOver("obligation change-or-declared unmet: worker executed no tools, so it did none of its assignment");
				emit({
					type: "clio_coder_run_outcome",
					payload: { outcomeCode: "obligation_unmet", detail: phase.sealedBy ?? "" },
				});
			} else if (violation === null && helperSchema !== null) {
				const parsed = parseJsonObjectPayload(assistantMessageText(event.message) ?? "");
				if (parsed.ok) {
					const reason = acceptHelperResult(parsed.value);
					if (reason !== null) reportRejectedHelperResult(parsed.value, reason);
					if (reason !== null && !(zeroToolRepairQueued && toolExecutionsStarted === 0)) repairHelperResult(reason);
				}
			} else if (violation !== null && formatFailure) {
				repairHelperResult(violation);
			} else if (violation !== null) {
				if (zeroToolViolation !== null || resultContractRepairsStarted < RESULT_CONTRACT_REPAIR_LIMIT) {
					if (zeroToolViolation !== null) zeroToolRepairQueued = true;
					else resultContractRepairsQueued += 1;
					// M-31: missing evidence is repaired by reading, so it never takes the final-only route below.
					const readFirst = zeroToolViolation === null && evidenceRepairFor(violation, !phase.toolsLocked);
					if (readFirst) evidenceRepairActive = true;
					// A finished answer in prose needs no more work, only its form. Where
					// the runtime can bind that form, the repair round goes final-only so
					// the schema can ride it; tools there would keep it unconstrained, and
					// the revision allowance stays unspent.
					const constrainedRepair =
						!readFirst &&
						contractResponseFormat !== undefined &&
						zeroToolViolation === null &&
						finishedReplyWithoutJsonResult(event.message);
					if (
						zeroToolViolation === null &&
						!constrainedRepair &&
						!resultContractRevisionActive &&
						workerBudget.revision !== undefined
					) {
						resultContractRevisionActive = loopGuardRegistration.extendWorkerToolCallPhase(workerBudget.revision);
						if (resultContractRevisionActive) {
							phase.unlockTools();
							middlewareToolChoice.reset();
							stopAfterToolResultCallId = null;
						}
					}
					if (constrainedRepair) phase.lockTools("result");
					const revisionToolsAvailable =
						readFirst || ((workerBudget.mode === "advisory" || resultContractRevisionActive) && !phase.toolsLocked);
					// Legacy enforced budgets need preauthorized growth to retain repair tools.
					if (!revisionToolsAvailable) phase.lockTools("result");
					// Active revision retains the paired tool exchange. Final-only
					// repair starts a fresh user turn to break local tool-call fixation. Templates
					// that key history rendering off the last `user` message re-render
					// every earlier assistant turn when one is appended mid-run, which
					// invalidates the whole prompt cache: Nemotron reprocessed 11,352
					// tokens for this directive as `user` against 407 for the same
					// bytes as a tool result (#55). The synthetic assistant call gives
					// the result a real tool_call_id for strict endpoints (#62).
					const repairInput = {
						contract,
						reason: readFirst ? evidenceRepairInstruction(violation, "emit the required result again") : violation,
						attempt: zeroToolViolation !== null ? 1 : resultContractRepairsQueued,
						anchors: observedReadAnchors(),
						toolsAvailable: revisionToolsAvailable,
					};
					const repair = revisionToolsAvailable
						? resultContractRepairMessages(repairInput, { provider: model.provider, api: model.api, model: model.id })
						: [resultContractRepairUserMessage(repairInput)];
					for (const message of repair) agent.followUp(message as unknown as AgentMessage);
				} else if (phase.sealedBy === null) {
					phase.seal(`result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${violation}`);
					emit({
						type: "clio_coder_run_outcome",
						payload: { outcomeCode: "result_contract_exhausted", detail: phase.sealedBy ?? "" },
					});
				}
			}
		}
		emit(event);
		if (
			stopAfterToolResultCallId !== null &&
			event.type === "message_end" &&
			event.message.role === "toolResult" &&
			(stopAfterToolResultCallId === STOP_AFTER_ANY_TOOL_RESULT || event.message.toolCallId === stopAfterToolResultCallId)
		) {
			stopAfterToolResultCallId = null;
			workerBoundAborted = true;
			abortWorkerForBound?.();
		}
	});

	// Non-stall guarantee (Symphony §10.5): a dispatched worker has no
	// operator by default, so a permission-requiring tool call must never park
	// forever. "deny" resolves the parked call as a structured denial and the
	// run continues; "fail" denies it and aborts the run, which then exits with
	// the dedicated permission-required code so the orchestrator can resolve
	// the outcome as failed/permission_required without racing the event
	// stream; "escalate" parks the call, hands the decision up to the operator
	// or, under a main-authority permit, to the main agent's grant broker over
	// the event/stdin channels, and applies the configured deny/fail fallback
	// on timeout so the run still cannot hang forever.
	// An escalation nobody can answer only waits out its timeout and then
	// applies the fallback. When the dispatching process says it has no
	// responder, the worker applies that fallback at once (F9).
	const unattendedEscalation = input.onPermission === "escalate" && input.escalation?.responder === "none";
	const onPermission = unattendedEscalation
		? (input.escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK)
		: (input.onPermission ?? "deny");
	const escalationConfig: WorkerEscalationConfig | null =
		onPermission === "escalate"
			? {
					timeoutMs: input.escalation?.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
					fallback: input.escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK,
					...(input.escalation?.backstopMs !== undefined ? { backstopMs: input.escalation.backstopMs } : {}),
				}
			: null;
	// Present only when the permit routes asks to the main agent with main
	// authority (Phase D): every decision must then name this attempt, the
	// parked request and its argument digest.
	const grantBinding = escalationConfig !== null ? input.escalation?.grant : undefined;
	const operatorUnattended = input.escalation?.operatorResponder === "none";
	const mainRoutedPermit = input.permitAllowance?.asks === "main" && input.permitAllowance.approvalAuthority === "main";
	let permissionFailure = false;
	const executeRefusals: WorkerRefusal[] = [];

	// Exact, byte-stable denial reasons for the deny/fail postures. Escalate
	// timeouts and operator denials use their own wording below.
	// A refused command leads the sentence so it survives the model-facing
	// 300-character line cap (rejection-feedback.ts).
	const denyReason = (tool: string, actionClass: string, refused?: WorkerRefusal): string => {
		const head =
			refused === undefined
				? "permission denied by policy: "
				: `permission denied by policy: ${formatWorkerRefusal(refused)}; `;
		return unattendedEscalation
			? mainRoutedPermit
				? `${head}no operator or granting main agent can answer worker asks for this dispatch (fleet.permissions.mode=main, fallback=deny); ${tool} requires ${actionClass} confirmation`
				: `${head}no operator can answer worker escalations for this dispatch (fleet.permissions.mode=escalate, fallback=deny); ${tool} requires ${actionClass} confirmation`
			: `${head}dispatched workers run non-interactively (fleet.permissions.mode=deny); ${tool} requires ${actionClass} confirmation`;
	};
	const failReason = (tool: string, actionClass: string): string =>
		unattendedEscalation
			? `permission required for ${tool} (${actionClass}); no operator can answer worker escalations for this dispatch and fallback=fail ends this run`
			: `permission required for ${tool} (${actionClass}); fleet.permissions.mode=fail ends this run`;

	interface ActiveEscalation {
		requestId: string;
		tool: string;
		actionClass: ActionClass;
		/** Identity of the exact call and permission conditions for the denial memory. */
		callKey: string;
		/** Who may discharge this ask. Always `operator` outside a main-routed permit. */
		authority: ApprovalAuthority;
		/** Digest a bound decision must name. */
		argDigest: string;
		/**
		 * The refusal a host denial of this main-authority execute ask counts
		 * toward WORKER_REFUSAL_LIMIT, as a deny-posture refusal would: a
		 * granting host that keeps refusing is no route either.
		 */
		refusal?: WorkerRefusal;
		timer: ReturnType<typeof setTimeout>;
		/** Monotonic time the ask was opened, which bounds every hold. */
		openedAt: number;
		/** Monotonic time the timer fires. */
		timerAt: number;
	}
	let activeEscalation: ActiveEscalation | null = null;
	// Denied escalations, keyed by the exact call and permission conditions. A
	// worker that re-issues the identical call after it was denied gets the
	// same answer without a new card: a live coder re-asked one bash approval
	// eight times after its edits were done (#79). Approvals are never
	// remembered: each new call, identical or not, needs its own decision, so
	// one grant executes at most one call (F8).
	const deniedEscalations = new Map<string, { requestId: string; source: "operator" | "timeout" | "main" }>();
	// Requests a delivered approval already consumed. If admission still parks
	// such a call, the call is denied rather than escalated a second time.
	const consumedRequestIds = new Set<string>();
	const clearActiveEscalation = (): void => {
		if (activeEscalation) {
			clearTimeout(activeEscalation.timer);
			activeEscalation = null;
		}
	};
	/**
	 * Count a host-refused main-authority execute ask. At the limit the run
	 * ends as permission_required naming every refused command; returns that
	 * final reason, or null while the worker may take another route.
	 */
	const countHostRefusal = (refusal: WorkerRefusal | undefined): string | null => {
		if (refusal === undefined) return null;
		executeRefusals.push(refusal);
		return executeRefusals.length >= refusalLimit ? workerRefusalLimitReason(executeRefusals) : null;
	};
	/**
	 * The run still exits permission_required, but finished work keeps its report: the next model round may only
	 * reply (beforeToolCall refuses every tool), and finishTurn ends the run after it. A helper-result worker reports
	 * only through its result tool, so that round is its terminal handoff, with the tool exposed and named (x2-3).
	 */
	const endAtRefusalLimit = (reason: string): void => {
		permissionFailure = true;
		phase.endAfterRound(workerModelRound + 1);
		if (helperForcedChoiceAvailable) phase.forceResult("refusals");
		const directive = workerRefusalReportDirective(helperForcedChoiceAvailable ? INTERNAL_HELPER_RESULT_TOOL : null);
		registry.cancelParkedCalls(`${reason}\n${directive}`);
		process.stderr.write(`[worker] ${reason}\n`);
	};
	const emitGrantExecution = (active: ActiveEscalation, event: GrantExecutionEvent): void => {
		emit({
			type: "clio_coder_permission_grant_execution",
			payload: {
				requestId: active.requestId,
				tool: active.tool,
				phase: event.phase,
				...(event.phase === "end" ? { outcome: event.outcome } : {}),
				...(event.phase === "not_executed" ? { detail: event.reason } : {}),
			},
		} as ClioWorkerEvent);
	};

	// One escalation is outstanding at a time. A call that parks while a prior
	// escalation awaits a decision is re-notified after the active one resolves
	// (registry.resumeParkedCalls re-fires onPermissionRequired for the next
	// parked call), so it never gets lost and the requestId->parked-call
	// mapping stays unambiguous.
	const resolveEscalation = (
		requestId: string,
		decision: "approve" | "deny",
		source: "operator" | "timeout" | "main",
		hostReason?: string,
	): boolean => {
		const active = activeEscalation;
		if (!active || active.requestId !== requestId) return false;
		clearActiveEscalation();
		const authority = grantBinding !== undefined ? { authority: active.authority } : {};
		if (decision === "approve") {
			consumedRequestIds.add(requestId);
			const issuer: ApprovalAuthority = source === "main" ? "main" : "operator";
			emit({
				type: "clio_coder_permission_resolved",
				payload: {
					tool: active.tool,
					actionClass: active.actionClass,
					mode: "escalate",
					source,
					requestId,
					decision: "approved",
					reason:
						issuer === "main"
							? `main agent granted ${active.tool} (${active.actionClass}) once`
							: `operator approved permission escalation for ${active.tool} (${active.actionClass})`,
					...authority,
				},
			} as ClioWorkerEvent);
			void registry.resumeParkedCalls({
				actionClass: active.actionClass,
				requestId,
				requestedBy: issuer === "main" ? "grant:main" : `escalation:${source}`,
				issuer,
				onExecution: (event) => emitGrantExecution(active, event),
			});
			return true;
		}
		deniedEscalations.set(active.callKey, { requestId, source });
		// A denial resolves to the effective posture: a timeout with fallback
		// "fail" ends the run like posture fail; every other denial mirrors
		// posture deny, so the structured tool denial the model sees (including
		// the "permission denied" reason) is identical to the deny posture.
		const effectiveFail = source === "timeout" && escalationConfig?.fallback === "fail";
		const mode: "deny" | "fail" = effectiveFail ? "fail" : "deny";
		const decider = source === "main" ? "main agent" : "operator";
		const denialContext = source === "timeout" ? "nobody answered in time" : `${decider} denied`;
		const deniedReason = effectiveFail
			? `permission required for ${active.tool} (${active.actionClass}); ${denialContext}, and the fleet's fail fallback ends this run`
			: hostReason !== undefined
				? `permission denied: ${hostReason}; ${active.tool} requires ${active.actionClass} confirmation`
				: `permission denied by ${source === "timeout" ? "escalation timeout fallback" : decider}: ${active.tool} requires ${active.actionClass} confirmation`;
		const limitReason = source === "main" && !effectiveFail ? countHostRefusal(active.refusal) : null;
		const reason = limitReason ?? deniedReason;
		emit({
			type: "clio_coder_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode,
				source,
				requestId,
				decision: "denied",
				reason,
				...authority,
			},
		} as ClioWorkerEvent);
		if (effectiveFail) {
			permissionFailure = true;
			registry.cancelParkedCalls(reason);
			agent.abort();
			return true;
		}
		if (limitReason !== null) {
			endAtRefusalLimit(limitReason);
			return true;
		}
		if (source === "timeout") registry.cancelParkedCalls(reason);
		else registry.cancelParkedCall(requestId, reason);
		return true;
	};

	/** A decision that does not name this attempt's parked call denies it without consuming anything. */
	const denyUnboundDecision = (active: ActiveEscalation, mismatch: string): void => {
		clearActiveEscalation();
		const reason = `permission denied: ${mismatch}, so the parked ${active.tool} call was not executed`;
		emit({
			type: "clio_coder_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode: "deny",
				source: "binding",
				requestId: active.requestId,
				decision: "denied",
				reason,
				authority: active.authority,
			},
		} as ClioWorkerEvent);
		registry.cancelParkedCall(active.requestId, reason);
	};

	const resolveDecision = (
		requestId: string,
		decision: "approve" | "deny",
		binding: WorkerDecisionBinding | undefined,
		cause: "timeout" | undefined,
	): boolean => {
		const active = activeEscalation;
		if (!active || active.requestId !== requestId) return false;
		// The parent's window ran out: the same denial this worker's own timer gives,
		// so fallback fail still ends the run.
		if (cause === "timeout" && decision === "deny") return resolveEscalation(requestId, "deny", "timeout");
		if (grantBinding === undefined) return resolveEscalation(requestId, decision, "operator");
		const mismatch =
			binding === undefined
				? "the decision carries no grant binding"
				: binding.attemptToken !== grantBinding.attemptToken || binding.attempt !== grantBinding.attempt
					? "the decision names another attempt"
					: binding.argDigest !== active.argDigest
						? "the decision names different arguments than the parked call"
						: decision === "approve" && binding.issuer === "main" && active.authority !== "main"
							? "the main agent cannot grant an operator-authority ask"
							: null;
		if (mismatch !== null || binding === undefined) {
			denyUnboundDecision(active, mismatch ?? "the decision carries no grant binding");
			return true;
		}
		return resolveEscalation(requestId, decision, binding.issuer === "main" ? "main" : "operator", binding.reason);
	};

	const denyActiveEscalationOnAbort = (reason: string): void => {
		const active = activeEscalation;
		if (!active) return;
		emit({
			type: "clio_coder_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode: "escalate",
				source: "operator",
				requestId: active.requestId,
				decision: "denied",
				reason,
				...(grantBinding !== undefined ? { authority: active.authority } : {}),
			},
		} as ClioWorkerEvent);
		clearActiveEscalation();
	};

	const unsubscribePermission = registry.onPermissionRequired((call, decision, meta) => {
		const actionClass = decision.classification.actionClass;
		const recordPermissionDecision = (disposition: "denied" | "permission_requested", rule?: string): void => {
			safety.decisions.recordToolCall?.({
				tool: call.tool,
				classification: decision.classification,
				decision: disposition,
				...(decision.policy !== undefined ? { policy: decision.policy } : {}),
				...(disposition === "permission_requested" ? { requestId: meta.requestId } : {}),
				...(rule !== undefined ? { ruleId: rule, reasonCode: rule, policySource: "fleet-permissions" } : {}),
				...confirmationRuleOf(decision),
			});
		};
		if (escalationConfig) {
			const callKey = workerPermissionCacheKey(call, decision, meta.axis);
			if (consumedRequestIds.has(meta.requestId)) {
				recordPermissionDecision("denied", "approval:consumed");
				// The approval was delivered and consumed; admission still refused the
				// call, so it is denied here instead of asking a second time.
				const reason = `permission denied: the approval for ${call.tool} did not admit the call under the worker's permit, and it was not executed`;
				emit({
					type: "clio_coder_permission_resolved",
					payload: {
						tool: call.tool,
						actionClass,
						mode: "deny",
						source: "binding",
						requestId: meta.requestId,
						decision: "denied",
						reason,
					},
				} as ClioWorkerEvent);
				registry.cancelParkedCall(meta.requestId, reason);
				return;
			}
			const remembered = deniedEscalations.get(callKey);
			if (remembered !== undefined) {
				recordPermissionDecision("denied", "approval:remembered-denial");
				const decider =
					remembered.source === "timeout"
						? "escalation timeout fallback"
						: remembered.source === "main"
							? "main agent"
							: "operator";
				const limitReason =
					remembered.source === "main" && actionClass === "execute"
						? countHostRefusal(describeWorkerRefusal(call, decision))
						: null;
				const reason =
					limitReason ??
					`permission denied by ${decider}: an identical ${call.tool} call under the same permission conditions was already denied earlier in this run (request ${remembered.requestId}); the answer stands, so do not repeat this call`;
				emit({
					type: "clio_coder_permission_resolved",
					payload: {
						tool: call.tool,
						actionClass,
						mode: "escalate",
						source: "remembered",
						requestId: meta.requestId,
						decision: "denied",
						reason,
					},
				} as ClioWorkerEvent);
				if (limitReason !== null) endAtRefusalLimit(limitReason);
				else registry.cancelParkedCall(meta.requestId, reason);
				return;
			}
			if (activeEscalation !== null) return;
			const requestId = meta.requestId;
			const authority: ApprovalAuthority = grantBinding === undefined ? "operator" : meta.approvalAuthority;
			if (isTaskGateCall(call.tool, call.args)) {
				recordPermissionDecision("denied", "approval:task-gate");
				// A decider would see a check id, not the argv the task wrote.
				const reason = `permission denied by policy: ${call.tool} task gate needs ${actionClass} confirmation and a task gate never asks; report it unverified with this reason`;
				emit({
					type: "clio_coder_permission_resolved",
					payload: { tool: call.tool, actionClass, mode: "deny", source: "policy", requestId, reason, authority },
				} as ClioWorkerEvent);
				registry.cancelParkedCall(requestId, reason);
				return;
			}
			if (grantBinding !== undefined && authority === "operator" && operatorUnattended) {
				recordPermissionDecision("denied", "approval:operator-unavailable");
				// Only a person clears an operator rail, and nobody can answer here.
				const reason = `permission denied by policy: ${call.tool} raised an operator-authority ask and no operator can answer worker asks for this dispatch; ${call.tool} requires ${actionClass} confirmation${outsideWorkspaceHint(call.args, contractCwd)}`;
				emit({
					type: "clio_coder_permission_resolved",
					payload: { tool: call.tool, actionClass, mode: "deny", source: "policy", requestId, reason, authority },
				} as ClioWorkerEvent);
				registry.cancelParkedCall(requestId, reason);
				return;
			}
			const effect = grantEffectDescriptor(call.tool, call.args);
			const argDigest = grantEffectDigest(effect);
			// The timer must hold the event loop: its firing is what denies an
			// escalation the orchestrator never resolves. clearActiveEscalation
			// clears it on every resolution path. A parent that owns the window
			// answers first, so under one this is only the backstop.
			const openedAt = performance.now();
			const timerMs = escalationConfig.backstopMs ?? escalationConfig.timeoutMs;
			const timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), timerMs);
			activeEscalation = {
				requestId,
				tool: call.tool,
				actionClass,
				callKey,
				authority,
				argDigest,
				...(grantBinding !== undefined && authority === "main" && actionClass === "execute"
					? { refusal: describeWorkerRefusal(call, decision) }
					: {}),
				timer,
				openedAt,
				timerAt: openedAt + timerMs,
			};
			// The decider sees this exact call through a sanitized allowlisted
			// preview of its object. Unlisted fields cross only as type-and-size
			// summaries on this display event; the effect descriptor a grant is
			// evaluated against rides the control lane below.
			const target = describeCallTarget(call.tool, call.args, undefined, WORKER_CALL_TARGET_MAX_CHARS);
			// Composed here because only the worker holds the whole command: `target`
			// is one flattened, cut line. Display text only, never read by a decision.
			const consequence = describeBashCallConsequences(call.tool, call.args, { home: homedir });
			const summary = `${call.tool} requires ${actionClass} confirmation`;
			emit({
				type: "clio_coder_permission_escalated",
				payload: {
					requestId,
					tool: call.tool,
					summary,
					...(target.length > 0 ? { target } : {}),
					...(consequence.length > 0 ? { consequence } : {}),
					axis: meta.axis,
					decision: {
						actionClass,
						reasons: decision.classification.reasons,
						...(decision.policy?.reasonCode ? { reasonCode: decision.policy.reasonCode } : {}),
						...(decision.policy?.ruleId ? { ruleId: decision.policy.ruleId } : {}),
						...(decision.policy?.policySource ? { policySource: decision.policy.policySource } : {}),
					},
					timeoutMs: escalationConfig.timeoutMs,
					...(grantBinding !== undefined ? { authority, argDigest } : {}),
				},
			} as ClioWorkerEvent);
			if (grantBinding !== undefined) {
				const frame: WorkerGrantRequestFrame = {
					requestId,
					attemptToken: grantBinding.attemptToken,
					attempt: grantBinding.attempt,
					tool: call.tool,
					actionClass,
					authority,
					argDigest,
					effect,
					summary,
					...(target.length > 0 ? { target } : {}),
					reasons: decision.classification.reasons.slice(0, 8),
					axis: meta.axis,
					timeoutMs: escalationConfig.timeoutMs,
					...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
				};
				// A descriptor too large for the control frame crosses as its digest
				// alone; the host then refuses a main grant and only the operator decides.
				const fits = Buffer.byteLength(JSON.stringify(frame), "utf8") <= GRANT_REQUEST_FRAME_BUDGET_BYTES;
				// The display sentences ride along only when they leave the frame inside
				// the budget, so card text can never be what drops a grant's effect.
				const within = (candidate: WorkerGrantRequestFrame): boolean =>
					Buffer.byteLength(JSON.stringify(candidate), "utf8") <= GRANT_REQUEST_FRAME_BUDGET_BYTES;
				// An MCP tool's class and description are what the main session's judge
				// reads the call by; they ride before the card text, under the same rule.
				const mcpTool = workerMcpToolFeatures(call.tool, registry.get(call.tool as ToolName));
				const withMcpTool = mcpTool !== undefined && within({ ...frame, mcpTool }) ? { ...frame, mcpTool } : frame;
				const withConsequence = consequence.length > 0 ? { ...withMcpTool, consequence } : withMcpTool;
				input.emitGrantRequest?.(
					fits ? (within(withConsequence) ? withConsequence : withMcpTool) : { ...frame, effect: null },
				);
			}
			recordPermissionDecision("permission_requested");
			return;
		}
		// The policy's own reasons name the remedy ("one command per bash call",
		// "only through the typed git tool"). Without them a worker saw only
		// "bash requires execute confirmation" and retried respelled variants.
		const policyDetail = [
			...new Set(
				[
					...(decision.policy?.reasons ?? []),
					...(decision.kind === "allow" ? [] : decision.rejection.detail.split("\n").slice(1)),
					...decision.classification.reasons,
				]
					.map((entry) => entry.replace(/^-\s+/u, "").trim())
					.filter((entry) => entry.length > 0 && !entry.startsWith("rule:")),
			),
		]
			.slice(0, 3)
			.join(" ");
		// A refused command reaches the model as a tool result and the turn goes
		// on, so it can take another route (P1 mode B ended at its first refused
		// verify). Changing the command still cannot create an absent execute
		// approval route, so the third refusal ends the work: one last reply may
		// report, then the run exits permission_required.
		const refusal = onPermission !== "fail" && actionClass === "execute" ? describeWorkerRefusal(call, decision) : null;
		if (refusal !== null) executeRefusals.push(refusal);
		// The refusal names the command and its rule: "outside the no-prompt set"
		// alone left the model and the receipt guessing which call was refused.
		const deniedHead = denyReason(call.tool, actionClass, refusal ?? undefined);
		const deniedReason =
			onPermission === "fail"
				? failReason(call.tool, actionClass)
				: policyDetail.length > 0
					? `${deniedHead}. ${policyDetail}`
					: deniedHead;
		const refusalLimitReached = executeRefusals.length >= refusalLimit;
		const reason = refusalLimitReached ? workerRefusalLimitReason(executeRefusals) : deniedReason;
		recordPermissionDecision("denied", `fleet.permissions.mode:${onPermission}`);
		emit({
			type: "clio_coder_permission_resolved",
			payload: {
				tool: call.tool,
				actionClass,
				mode: onPermission,
				source: "policy",
				requestId: meta.requestId,
				reason,
			},
		} as ClioWorkerEvent);
		if (onPermission === "fail") {
			permissionFailure = true;
			registry.cancelParkedCalls(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			agent.abort();
			return;
		}
		if (refusalLimitReached) endAtRefusalLimit(reason);
		else registry.cancelParkedCalls(reason);
	});

	const workerTelemetry = input.telemetryContext
		? createWorkerCallTelemetry(
				input.telemetryContext,
				{
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					api: model.api,
					requestedModel: model.id,
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
				resolveEffectivePricing(input.target, input.runtime, input.wireModelId),
				emit,
			)
		: undefined;
	// The run's identity scopes its tool and middleware records, so the host accepts them as this run's (#434).
	const runScoped = <T>(work: () => T): T =>
		input.telemetryContext ? withTelemetryContext(input.telemetryContext, work) : work();
	const promise = runScoped(async (): Promise<WorkerRunResult> => {
		try {
			emit({ type: "clio_coder_repair_rounds_started", payload: { started: 0 } });
			await agent.prompt(promptMessagesForWorker(input));
			await agent.waitForIdle();
			unsubscribe();
			if (phase.sealedBy !== null) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
			}
			if (permissionFailure) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			}
			const messages = agent.state.messages.slice(inheritedCount);
			// The provider error is reported before the helper check: a helper run
			// that died on a 400 used to exit 1 with empty stderr, which dispatch
			// read as a worker runtime fault and resent twice.
			const errorMessage = getTerminalAgentError(messages);
			if (errorMessage !== null) {
				if (lastProviderHttpStatus !== null && lastProviderHttpStatus >= 400) {
					process.stderr.write(`${WORKER_PROVIDER_HTTP_STATUS_MARKER}${lastProviderHttpStatus}\n`);
				}
				if (errorMessage.length > 0) {
					process.stderr.write(`[worker] agent ended with stopReason=error: ${errorMessage}\n`);
				}
				return { messages, exitCode: 1 };
			}
			const hasTerminalArtifact =
				input.resultContract?.kind === "architect-plan" &&
				validateResultContract({
					contract: input.resultContract,
					output: null,
					cwd: contractCwd,
					networkAllowed: true,
					filesystem: nodeResultContractFilesystem(),
				}).conformance === "pass";
			// #425: an idle loop after a tool result or aborted/empty response never delivered a final answer.
			// A locked synthesis reply the sanitizer reduced to its fallback notice
			// (after the one re-prompt) is text, but not an answer.
			const fallbackOnly = isLockedSynthesisFallbackOnly(messages.at(-1));
			if (
				acceptedHelperResult === null &&
				!hasTerminalArtifact &&
				(fallbackOnly || !isTerminalAssistantMessage(messages.at(-1)) || !assistantMessageText(messages.at(-1)))
			) {
				const lastAssistant = [...messages].reverse().find(isAssistantMessage);
				const stopped = lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error";
				const cause = stopped ? (workerStopCause ?? abortReasonCause(lastAssistant) ?? "unrecorded") : undefined;
				const why = cause ? `, cause=${cause}${lastAssistant?.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}` : "";
				const detail = fallbackOnly
					? "worker synthesis reply held only tool-call markup after the tool-call lockout, so no final answer was delivered"
					: `worker loop ended without a final assistant output (last role=${messages.at(-1)?.role ?? "none"}, stopReason=${lastAssistant?.stopReason ?? "none"}${why})`;
				emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "worker_final_output_missing", detail } });
				process.stderr.write(`[worker] ${detail}\n`);
				return { messages, exitCode: 1 };
			}
			if (helperSchema !== null && acceptedHelperResult === null) {
				return { messages, exitCode: 1 };
			}
			return { messages, exitCode: 0 };
		} catch (err) {
			unsubscribe();
			if (phase.sealedBy !== null) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
			}
			if (permissionFailure) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			}
			const msg = err instanceof Error ? err.message : String(err);
			emit({ type: "agent_end", messages: agent.state.messages.slice(inheritedCount) });
			process.stderr.write(`[worker] agent error: ${msg}\n`);
			return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
		} finally {
			clearTimeout(synthesisTimer);
			clearTimeout(wallTimer);
			clearActiveEscalation();
			unsubscribePermission();
			thrashOutcome.end(agent.state.messages.slice(inheritedCount));
			// Every server this run launched closes with it; teardown reports go to
			// stderr inside the source, never to the NDJSON lane.
			try {
				await workerMcp?.close();
			} finally {
				workerTelemetry?.close({
					stopReason: input.signal?.aborted ? "aborted" : "error",
					failure:
						(callTracking as ReturnType<typeof trackCallFetch> | null)?.failure(
							"worker ended without a terminal response",
							input.signal?.aborted,
						) ?? classifyCallFailure("worker ended before request invocation", { invoked: false }),
				});
			}
		}
	});

	return {
		promise,
		abort: (cause) => {
			// Under escalate a parked call would otherwise keep waitForIdle from
			// returning, so cancel it before aborting. cancelParkedCalls is a
			// no-op when nothing is parked, so deny/fail abort stays unchanged.
			if (escalationConfig) {
				const reason =
					cause === "owner_channel_closed"
						? "permission request expired: the session that owns this worker exited or disconnected; re-run the work from a live session"
						: "run aborted while a permission escalation was pending";
				denyActiveEscalationOnAbort(reason);
				registry.cancelParkedCalls(reason);
			}
			workerStopCause ??= cause === "internal" ? "internal" : "parent_cancel";
			agent.abort();
		},
		steer: (text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return false;
			// A worker reports no turn_start, so its operator's steer is where the read streak starts over.
			readStreakRegistration?.resetStreak();
			agent.steer(taskMessage(trimmed));
			return true;
		},
		resolvePermission: (
			requestId: string,
			decision: "approve" | "deny",
			binding?: WorkerDecisionBinding,
			cause?: "timeout",
		) => resolveDecision(requestId, decision, binding, cause),
		holdPermission: (requestId: string, holdMs: number) => {
			const active = activeEscalation;
			// Without a backstop the worker's own timer is the window, and no parent may stretch it.
			if (active === null || active.requestId !== requestId || escalationConfig?.backstopMs === undefined) return false;
			const at = performance.now();
			const timerAt = permissionHoldBackstopAt({ openedAt: active.openedAt, now: at, holdMs, currentAt: active.timerAt });
			if (timerAt === active.timerAt) return true;
			clearTimeout(active.timer);
			active.timerAt = timerAt;
			active.timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), timerAt - at);
			return true;
		},
	};
}
