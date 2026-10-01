import { homedir } from "node:os";
import type { WorkerContextSeed } from "../domains/context/worker/contract.js";
import { createWorkerContextGuard, WorkerContextExhaustedError } from "../domains/context/worker/pressure.js";
import { createWorkerObservationStore } from "../domains/context/worker/recall.js";
import { seededWorkerMessages } from "../worker/context-seed.js";
import { engineStreamSimple } from "./api-registry.js";
import { recommendedOutputTokens, resolvePressureOutputReserve } from "./apis/output-budget.js";
import { resolvedRequestContext } from "./context.js";
import { retryStreamOnceOnOverflow } from "./overflow-retry-stream.js";
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
import { runtimeSpeaksResponseSchemaDialect } from "../core/response-schema.js";
import { workerSandboxConfinesWrites, workerSandboxReadableRoots } from "../core/sandbox/worker-process.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { agentSkillToolPolicy } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import {
	internalHelperResultSchema,
	type ObservedReadRanges,
	type ObservedRunEffects,
	parseWorkerResultContract,
	RESULT_CONTRACT_REPAIR_LIMIT,
	type ResultContract,
	resultContractRepairMessages,
	resultContractRepairUserMessage,
	resultContractShape,
	type StructuredHelperResult,
	validateResultContract,
	validateStructuredHelperResult,
} from "../domains/agents/result-contract.js";
import { nodeResultContractFilesystem } from "../domains/agents/result-contract-filesystem.js";
import type { AgentProduct } from "../domains/agents/spec.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import { createMiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import { shouldRequestStalledTurnContinuation } from "../domains/middleware/stalled-turn.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import type {
	CapabilityFlags,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import { applyModelCapabilityPatch, resolveModelRuntimeCapabilitiesForModel } from "../domains/providers/index.js";
import { resolveProviderKnowledgeBaseRoots } from "../domains/providers/knowledge-base-path.js";
import { createProfileKnowledgeBase } from "../domains/providers/profile-knowledge.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseHit,
} from "../domains/providers/types/knowledge-base.js";
import type { ActionClass, ClassifierCall } from "../domains/safety/action-classifier.js";
import type { ApprovalAuthority } from "../domains/safety/admission.js";
import { describeCallTarget } from "../domains/safety/call-target.js";
import type { FlowRestrictionSet } from "../domains/safety/information-flow.js";
import {
	EMPTY_INFORMATION_FLOW_POLICY,
	evaluateInformationFlow,
	mergeFlowRestrictions,
	resolveModelDestination,
} from "../domains/safety/information-flow.js";
import { describeBashCallConsequences } from "../domains/safety/command-consequence.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import { grantEffectDescriptor, grantEffectDigest } from "../domains/safety/grant-effect.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import { createRunEffectsRecorder, recordToolExecutionEffects } from "../domains/safety/run-effects.js";
import type { WorkerGitAllowance, WorkerPermitAllowance } from "../domains/safety/worker-permit.js";
import { resolveAgentTools, type ToolTelemetry } from "../tools/agent-tools.js";
import { createWorkerGitContext } from "../tools/git-exec.js";
import type { ToolProfileName } from "../tools/profiles.js";
import type { GrantExecutionEvent, RegistryDeps } from "../tools/registry.js";
import {
	CHAIN_OUTPUT_TRUNCATED_MARKER,
	effectiveToolCall,
	type GatewayChainReceipt,
	gatewayChainReceipts,
} from "../tools/surface.js";
import type { TaskWorktree } from "../tools/task-worktree.js";
import { type AgentLedgerPort, canonicalJson, type WorkerGrantRequestFrame } from "../worker/protocol.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	WORKER_EXIT_PERMISSION_REQUIRED,
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
import { startExternalCliWorkerRun } from "./external-cli/connectors.js";
import {
	createLoopGuardRegistration,
	isLockedSynthesisFallbackOnly,
	isLoopGuardSynthesisBackstopReason,
	lockedSynthesisFallbackText,
	lockedSynthesisRepromptMessages,
	lockedSynthesisSystemPrompt,
	resolveDeliveryTools,
	sanitizeLockedSynthesisMessage,
	workerLoopBlockBudget,
} from "./loop-guard.js";
import { patchWorkerRequestPayload, supportsNamedToolChoice } from "./provider-payload.js";
import type { AgentEvent, AgentMessage, EngineModel } from "./types.js";
import type { ClioWorkerEvent } from "./worker-events.js";
import { createWorkerSafety, createWorkerToolRegistry, INTERNAL_HELPER_RESULT_TOOL } from "./worker-tools.js";

/** Room left for the frame envelope under the 16 KiB control-lane bound, counted in the UTF-8 bytes the host limit counts. */
const GRANT_REQUEST_FRAME_BUDGET_BYTES = 14 * 1024;

/** Exact call and enforced permission conditions; never reuse an answer across asking axes. */
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
	thinkingLevel?: ThinkingLevel;
	/** JSON Schema enforced by the native llama.cpp request payload. */
	responseSchema?: Record<string, unknown>;
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
	/** Internal external-connector posture. Native workers ignore it and always use default. */
	autonomy?: import("../domains/safety/autonomy.js").AutonomyLevel;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Enforced at the shared worker safety seam (createWorkerSafety) so both the
	 * native registry and the Claude SDK hook path block out-of-root writes.
	 */
	writeRoots?: ReadonlyArray<string>;
	/**
	 * Information-flow restrictions the inherited context carries. Every model
	 * request of this run is judged against them and against what the run's
	 * own reads add, at the same seam the main agent uses.
	 */
	flowRestrictions?: FlowRestrictionSet;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	abort(): void;
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
	resolvePermission?(requestId: string, decision: "approve" | "deny", binding?: WorkerDecisionBinding): boolean;
}

export type WorkerEventEmit = (event: AgentEvent | ClioWorkerEvent) => void;

function isAssistantMessage(
	message: AgentMessage | undefined,
): message is AgentMessage & { role: "assistant"; stopReason?: string; errorMessage?: string } {
	if (typeof message !== "object" || message === null) return false;
	return "role" in message && message.role === "assistant";
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
	return message.stopReason !== "toolUse" && message.stopReason !== "error";
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

class NullKnowledgeBase implements KnowledgeBase {
	lookup(_modelId: string): KnowledgeBaseHit | null {
		return null;
	}
	entries() {
		return [];
	}
}

let kbSingleton: KnowledgeBase | null = null;

function getKnowledgeBase(): KnowledgeBase {
	if (kbSingleton) return kbSingleton;
	let legacy: KnowledgeBase;
	try {
		const roots = resolveProviderKnowledgeBaseRoots(import.meta.url);
		legacy = roots.length > 0 ? new FileKnowledgeBase(roots) : new NullKnowledgeBase();
	} catch {
		legacy = new NullKnowledgeBase();
	}
	// Stdout is the NDJSON lane, so a profile file that fails to load is left silent here;
	// the orchestrator reports it once and the worker resolves from the live server instead.
	kbSingleton = createProfileKnowledgeBase(legacy);
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

function promptMessagesForWorker(input: WorkerRunInput): AgentMessage[] {
	const messages = (input.dynamicPromptMessages ?? []).map(promptMessage);
	if (input.taskGit?.taskWorktree !== undefined) {
		messages.push(
			taskMessage(
				"The host commits this task worktree after you finish. Even if the task says 'and commit', make the requested edits and report; do not commit or load the ship skill. Honor the task's validation instructions.",
			),
		);
	}
	messages.push(
		taskMessage(
			input.contextSeed
				? `# Your worker assignment\nYou are already the dispatched ${input.agentId} worker. The preceding conversation is inherited background; its requests to dispatch a worker were addressed to the parent. Carry out the assignment below, preserving safety and operator scope constraints. Do not dispatch yourself again.\n\n${input.task}`
				: input.task,
		),
	);
	return messages;
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

function assertResponseSchemaRuntime(input: WorkerRunInput): void {
	if (input.responseSchema === undefined) return;
	if (
		runtimeSpeaksResponseSchemaDialect(input.runtime) &&
		input.modelCapabilities?.structuredOutputs === "json-schema"
	) {
		return;
	}
	throw new Error(
		`responseSchema requires a native llamacpp runtime with resolved JSON-schema support; received '${input.runtime.id}'`,
	);
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
	const helperSchema =
		input.helperResult === true && input.resultContract ? internalHelperResultSchema(input.resultContract) : null;
	if (input.helperResult === true && (helperSchema === null || input.runtime.kind !== "http")) {
		throw new Error("helperResult requires a supported internal JSON contract and native HTTP worker");
	}
	if (input.runtime.id === "claude-sdk") {
		return startClaudeSdkWorkerRun(input, emit);
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
	const model = applyModelCapabilityPatch(
		input.target.runtime === "faux" && fauxModel ? fauxModel : synthesized,
		input.modelCapabilities,
	);

	// Per-run safety contract: one loop-detector state per worker subprocess.
	// The loop guard rides on the registry's middleware contract as a
	// before_tool registration (engine/loop-guard.ts), so admission and
	// repetition detection share one seam; there is no agent-loop hook anymore.
	const safety = createWorkerSafety({
		cwd: process.cwd(),
		...(input.writeRoots !== undefined ? { writeRoots: input.writeRoots } : {}),
		...(input.writeRoots !== undefined && workerSandboxConfinesWrites() ? { writeRootsOsConfined: true } : {}),
		readExemptRoots: workerSandboxReadableRoots(),
		...(input.protectedArtifactState !== undefined
			? { protectedArtifactState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// Flipped by the loop guard's lockout callback; read by onPayload below to
	// force the remaining model rounds text-only by removing the tool surface
	// (tool_choice none on Anthropic; see patchToolSurfaceLockedPayload).
	let synthesisToolLock = false;
	let lockedSynthesisReprompts = 0;
	let workerBoundFailure: string | null = null;
	let workerBoundAborted = false;
	let abortWorkerForBound: (() => void) | null = null;
	// For synthesis:false, the loop guard records the final admitted call while
	// rejecting later siblings immediately. The runtime stops only after pi has
	// emitted that call's tool-result message, so a slow tool is never aborted
	// merely because its before_tool admission reached the agent boundary.
	// Unset (null) never matches. A call admitted without a provider id arms
	// the explicit wildcard, which cannot collide with any real result id.
	const STOP_AFTER_ANY_TOOL_RESULT = Symbol("stop-after-any-tool-result");
	let stopAfterToolResultCallId: string | typeof STOP_AFTER_ANY_TOOL_RESULT | null = null;
	const workerBudget = resolveWorkerRuntimeBudget(input);
	const readReserve = input.allowedTools.includes(ToolNames.Read) ? workerBudget.readReserve : 0;
	// The reserve ends discovery, not the run's own product. An agent that was
	// granted mutation tools delivers by writing, so those stay admitted in the
	// reserve window; a read-only agent has none and the window stays read-only.
	const deliveryTools = resolveDeliveryTools(input.allowedTools, input.product);
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// Tool calls emitted by one provider response share this correlation. The
	// loop guard counts synthesis-lock noncompliance by model round, preventing
	// one wide parallel batch from consuming the entire denial backstop.
	let workerModelRound = 0;
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
		toolCallSoftReadReserve: readReserve,
		...(deliveryTools.length > 0 ? { deliveryTools } : {}),
		turnSynthesisLockout: workerBudget.synthesis,
		// Once locked, the next model round is forced text-only at the
		// request level. The lockout directive alone relies on model compliance.
		onSynthesisLockout: () => {
			if (workerBudget.synthesis) synthesisToolLock = true;
		},
		...(!workerBudget.synthesis
			? {
					onSoftLimitFinalCallAdmitted: (toolCallId: string | undefined) => {
						if (workerBoundFailure === null) {
							workerBoundFailure = `worker agent budget reached (${workerBudget.toolCalls}); synthesis is disabled`;
						}
						// Native agent tool calls carry a stable provider id. The wildcard
						// keeps even an invariant violation on the post-result path.
						stopAfterToolResultCallId = toolCallId ?? STOP_AFTER_ANY_TOOL_RESULT;
					},
				}
			: {}),
		// Requiring read is correct only when reading is the whole reserve.
		...(readReserve > 0 && deliveryTools.length === 0
			? {
					onSoftReadReserve: () => {
						middlewareToolChoice.apply([{ kind: "require_tool", toolName: ToolNames.Read }]);
					},
				}
			: {}),
	});
	const observations = createWorkerObservationStore();
	// Run-scoped ledger: the inherited set plus what this run's reads add. It
	// lives in memory only; the parent's session ledger already holds the
	// inherited part, and a restriction this run discovers reaches the parent
	// only through the dispatch result label (see the receipt gap in the report).
	let runFlow: FlowRestrictionSet | null = input.flowRestrictions ?? null;
	const workerFlow: NonNullable<RegistryDeps["flow"]> = {
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
		// The protected-artifacts guard starts from the parent-session snapshot
		// and has no persistence sink. It can still absorb worker-local
		// protect_path effects from snapshot rules for the rest of this run.
		[
			loopGuardRegistration,
			createProtectedArtifactsRegistration({
				...(input.protectedArtifactState !== undefined
					? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
					: {}),
			}),
		],
		input.readOnly,
		(effects) => middlewareToolChoice.apply(effects),
		input.agentLedger,
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
	);
	const contractCwd = input.cwd ?? process.cwd();
	let resultContractRepairsQueued = 0;
	let toolExecutionsStarted = 0;
	let zeroToolRepairQueued = false;
	let resultContractRevisionActive = false;
	let acceptedHelperResult: StructuredHelperResult | null = null;
	let helperTerminalPhase = false;
	let helperTurnFailure: string | null = null;
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
	// so a mutation report is judged against the run instead of believed.
	const runEffects = createRunEffectsRecorder(contractCwd);
	const acceptHelperResult = (data: unknown): string | null => {
		if (!input.resultContract) return "missing helper result contract";
		const checked = validateStructuredHelperResult({
			contract: input.resultContract,
			data,
			cwd: contractCwd,
			observedReadRanges: groundingRanges(),
			observedRunEffects: runEffects.snapshot(),
			networkAllowed: true,
			filesystem: nodeResultContractFilesystem(),
		});
		if (checked.structured === null) return checked.validation.reason ?? "invalid helper result";
		acceptedHelperResult = checked.structured;
		emit({ type: "clio_coder_helper_result", payload: checked.structured });
		return null;
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
			} else if (child.capability === ToolNames.Grep) {
				recordObservedGrep(child.result.details, visibleText);
			}
		}
	};

	/** Spans quoted back to the model, as `path:start-end`. */
	const observedReadAnchors = (): string[] =>
		[...observedReadRanges.entries()].flatMap(([key, spans]) =>
			spans.map(([start, end]) => `${path.relative(contractCwd, key) || key}:${start}-${end}`),
		);
	/**
	 * A refusal whose reason is a run bound. Direct calls reach this through
	 * their blocked finish; a chain child the bound refused reaches it through
	 * the chain's receipt, because the aggregate settles as an ordinary error
	 * and its own finish cannot carry the child's verdict.
	 */
	const observeBoundReason = (reason: string): void => {
		// Lifetime-cap lockout: record the bound (the run must not seal as an
		// ordinary success) but do not abort. The loop guard has flipped the
		// synthesis tool lock, so the next model round runs text-only and the
		// synthesized answer still reaches message_end and the receipt.
		if (isWorkerToolCallCapSynthesisReason(reason)) {
			emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "worker_tool_call_cap_exhausted" } });
			if (workerBoundFailure === null) {
				workerBoundFailure = reason;
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
			if (workerBoundFailure === null) workerBoundFailure = reason;
			process.stderr.write(`[worker] ${reason}\n`);
			abortWorkerForBound?.();
		}
	};
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "clio_coder_tool_start", payload: event });
		},
		onFinish(event) {
			if (event.toolCallId !== undefined) runEffects.checkOutcome(event.toolCallId, event.outcome);
			emit({ type: "clio_coder_tool_finish", payload: event });
			if (event.outcome !== "blocked" || typeof event.reason !== "string") return;
			observeBoundReason(event.reason);
		},
	};
	const tools = resolveAgentTools({
		registry,
		...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
		telemetry,
		allowedTools: activeWorkerTools,
		agentId: input.agentId,
		task: input.task,
		includeInteractiveTools: false,
		invokeOptions: () => ({
			...(input.turnConstraints ? { turnConstraints: input.turnConstraints } : {}),
			correlationId: `worker-model-round-${workerModelRound}`,
			toolResultMaxBytes: workerSettings.context.toolResultMaxBytes,
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
	if (helperToolAvailable) {
		tools.push({
			name: INTERNAL_HELPER_RESULT_TOOL,
			label: "Submit helper result",
			description:
				"Submit the final internal result as this tool's arguments. Call alone, after gathering evidence. A validated submission finishes the run; no prose response follows.",
			parameters: Type.Unsafe<Record<string, unknown>>(helperSchema),
			async execute(_id, args) {
				if (acceptedHelperResult !== null || workerBoundFailure !== null) {
					return {
						content: [{ type: "text", text: "The terminal result is already sealed." }],
						details: { kind: "error" },
						isError: true,
						terminate: true,
					};
				}
				helperTerminalPhase = true;
				synthesisToolLock = true;
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
	const contextGuard = createWorkerContextGuard(observations.archive);
	const options: EngineAgentOptions = {
		// The run's restrictions are judged against the target as configured for
		// this run before each request, the same verdict the parent would reach.
		beforeStreamRequest: () => {
			if (runFlow === null) return { block: false };
			const verdict = evaluateInformationFlow({
				restrictions: runFlow,
				destination: resolveModelDestination({
					targetId: input.target.id,
					runtimeId: input.runtime.id,
					url: input.target.url ?? null,
					model: input.wireModelId,
				}),
				policy: safety.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY,
			});
			return verdict.kind === "permitted" ? { block: false } : { block: true, reason: verdict.reason };
		},
		beforeToolCall: async ({ assistantMessage, toolCall }) => {
			if (helperSchema === null) return undefined;
			if (acceptedHelperResult !== null || workerBoundFailure !== null)
				return { block: true, reason: "The helper result is sealed.", terminate: true };
			const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL) && calls.length !== 1) {
				helperTurnFailure =
					"Submit exactly one terminal handoff, alone; mixed or duplicate handoff batches are rejected without executing work.";
				return { block: true, reason: helperTurnFailure };
			}
			if ((helperTerminalPhase || synthesisToolLock) && toolCall.name !== INTERNAL_HELPER_RESULT_TOOL) {
				helperTurnFailure = "Work tools are disabled. Submit only the internal terminal result.";
				return { block: true, reason: helperTurnFailure };
			}
			return undefined;
		},
		// Pi decides the turn boundary here, before `turn_end` is emitted, so a
		// terminal-handoff repair that exhausts its budget must run here too.
		// Run from a `turn_end` subscriber, the exhausted bound arrived after the
		// decision and cost one extra provider request.
		finishTurn: ({ toolResults }) => {
			if (
				helperSchema !== null &&
				acceptedHelperResult === null &&
				toolResults.length > 0 &&
				(helperTerminalPhase || synthesisToolLock)
			) {
				const error = toolResults.find((result) => result.isError);
				const reason =
					helperTurnFailure ??
					error?.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n") ??
					"The terminal handoff was not accepted.";
				repairHelperResult(reason);
			}
			return helperSchema !== null && (acceptedHelperResult !== null || workerBoundFailure !== null)
				? { action: "end" }
				: undefined;
		},
		streamFn: (currentModel, transcript, streamOptions) => {
			const currentContext = resolvedRequestContext(transcript);
			const helperPrompt =
				helperToolAvailable && (!(synthesisToolLock || helperTerminalPhase) || helperForcedChoiceAvailable)
					? `${currentContext.systemPrompt ?? ""}\n\n# Internal helper protocol\nReturn the result by calling ${INTERNAL_HELPER_RESULT_TOOL} alone with the result object as arguments. Successful submission ends the run; no narrative report is needed.${synthesisToolLock || helperTerminalPhase ? " Work tools are disabled. Earlier tool-use instructions apply only to the completed work phase; only the terminal handoff remains available. Do not invent missing evidence." : ""}`
					: currentContext.systemPrompt;
			const systemPrompt =
				helperToolAvailable && (!(synthesisToolLock || helperTerminalPhase) || helperForcedChoiceAvailable)
					? helperPrompt
					: synthesisToolLock
						? lockedSynthesisSystemPrompt(
								currentContext.systemPrompt ?? "",
								input.resultContract ? resultContractShape(input.resultContract) : undefined,
							)
						: currentContext.systemPrompt;
			const window = input.runtimeResolution?.capabilities.contextWindow ?? currentModel.contextWindow;
			const pressure = {
				messages: currentContext.messages,
				systemPrompt: systemPrompt ?? "",
				tools: currentContext.tools ?? [],
				contextWindow: window,
				threshold: workerSettings.context.compaction.threshold,
				autoEvict: workerSettings.context.compaction.auto && workerSettings.context.workingSet.enabled,
				outputReserve: resolvePressureOutputReserve(
					currentModel.maxTokens,
					{ api: currentModel.api, contextWindow: window },
					recommendedOutputTokens(currentModel, window),
				),
			};
			let messages: AgentMessage[];
			try {
				messages = contextGuard(pressure);
			} catch (error) {
				if (error instanceof WorkerContextExhaustedError) {
					workerBoundFailure = error.message;
					emit({ type: "clio_coder_run_outcome", payload: { outcomeCode: "worker_context_exhausted" } });
				}
				throw error;
			}
			const request = (projected: AgentMessage[]) =>
				engineStreamSimple(
					currentModel,
					{
						...currentContext,
						...(systemPrompt !== undefined ? { systemPrompt } : {}),
						messages: projected as typeof currentContext.messages,
					},
					streamOptions,
				);
			const first = request(messages);
			// The server is the authority on its own limit. An unreported window, a
			// window that changed since it was resolved, or a server tokenizer that
			// counts above Clio's estimate all surface as a server overflow. It earns
			// one reversible eviction and one retry; a second overflow is final.
			return retryStreamOnceOnOverflow(first, () => {
				const projected = contextGuard.recover(pressure);
				return projected ? request(projected) : null;
			});
		},
		initialState: {
			systemPrompt: input.systemPrompt,
			model,
			thinkingLevel: effectiveThinkingLevel,
			tools,
			messages: inheritedMessages,
		},
		onPayload: async (payload, currentModel) => {
			const middlewareChoice = middlewareToolChoice.current();
			return patchWorkerRequestPayload(payload, currentModel, {
				runtimeId: input.runtime.id,
				thinkingLevel: effectiveThinkingLevel,
				...(input.responseSchema !== undefined ? { responseSchema: input.responseSchema } : {}),
				toolSurfaceLocked: synthesisToolLock,
				...(helperToolAvailable && (synthesisToolLock || helperTerminalPhase) && supportsNamedToolChoice(currentModel.api)
					? { terminalToolName: INTERNAL_HELPER_RESULT_TOOL }
					: {}),
				toolChoiceNone: middlewareChoice.kind === "none",
				...(middlewareChoice.kind === "required" ? { toolChoiceName: middlewareChoice.toolName } : {}),
			});
		},
		getApiKey: async () => input.apiKey,
	};
	if (input.sessionId) options.sessionId = input.sessionId;

	const { agent } = createEngineAgent(options);
	// Pi adds a leading prompt/tool declaration; exclude the entire inherited baseline.
	const inheritedCount = agent.state.messages.length;
	// The result-contract repair queues a call/result pair that must land in
	// one drain, or the provider sees a lone assistant tool call.
	agent.followUpMode = "all";
	abortWorkerForBound = () => agent.abort();
	const repairHelperResult = (reason: string): void => {
		if (!input.resultContract || acceptedHelperResult !== null || workerBoundFailure !== null) return;
		helperTerminalPhase = true;
		synthesisToolLock = true;
		if (resultContractRepairsQueued >= RESULT_CONTRACT_REPAIR_LIMIT) {
			workerBoundFailure = `result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${reason}`;
			emit({
				type: "clio_coder_run_outcome",
				payload: { outcomeCode: "result_contract_exhausted", detail: workerBoundFailure },
			});
			return;
		}
		resultContractRepairsQueued += 1;
		const instruction = helperForcedChoiceAvailable
			? `${reason} Work tools remain disabled. Repair the result by calling ${INTERNAL_HELPER_RESULT_TOOL} exactly once, alone, with the complete result object. Do not emit prose.`
			: reason;
		for (const message of resultContractRepairMessages(
			{
				contract: input.resultContract,
				reason: instruction,
				attempt: resultContractRepairsQueued,
				anchors: observedReadAnchors(),
			},
			{ provider: model.provider, api: model.api, model: model.id },
		)) {
			const repairMessage =
				helperForcedChoiceAvailable && message.role === "toolResult"
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
			agent.followUp(repairMessage as unknown as AgentMessage);
		}
	};
	const unsubscribe = agent.subscribe(async (event) => {
		if (event.type === "turn_start") {
			workerModelRound += 1;
			helperTurnFailure = null;
		}
		// Detect the whole terminal batch before any call is prepared/executed.
		// beforeToolCall rejects every sibling, regardless of ordering or parallelism.
		if (helperSchema !== null && event.type === "message_end" && isAssistantMessage(event.message)) {
			const calls = event.message.content.filter((block) => block.type === "toolCall");
			if (calls.some((call) => call.name === INTERNAL_HELPER_RESULT_TOOL)) {
				helperTerminalPhase = true;
				synthesisToolLock = true;
				if (calls.length !== 1)
					helperTurnFailure = "Submit exactly one terminal handoff, alone; mixed or duplicate batches cannot execute work.";
			}
		}
		if (event.type === "tool_execution_start") {
			toolExecutionsStarted += 1;
			middlewareToolChoice.toolStarted(event.toolName);
		}
		// Read spans this run actually observed. They ground the terminal result
		// (a cited line has to fall inside one) and they are handed back verbatim
		// in a repair round, so re-emitting findings never invites invention.
		// Effects and grounding come from the capability operations that
		// settled: a gateway op=call as the capability it ran, a chain as each
		// admitted child, once each. Provider replay keeps the wire records.
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			recordToolExecutionEffects(runEffects, event);
		}
		if (event.type === "tool_execution_start") {
			const call = effectiveToolCall(event.toolName, event.args);
			if (call.toolName === ToolNames.Read) {
				const request = readCitationRequest(call.args);
				if (request !== null) pendingReadCitations.set(event.toolCallId, request);
			} else if (call.toolName === ToolNames.Grep) {
				pendingGrepCalls.add(event.toolCallId);
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
		if (synthesisToolLock && !helperToolAvailable && event.type === "message_end") {
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
		const contract = input.resultContract;
		if (
			helperSchema !== null &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			const text = assistantMessageText(event.message);
			let reason: string | null;
			try {
				reason = acceptHelperResult(JSON.parse(text ?? ""));
			} catch {
				reason = "The internal result must be a JSON object conforming to the declared contract.";
			}
			if (reason !== null) repairHelperResult(reason);
		}
		if (
			helperSchema === null &&
			contract &&
			!repromptedThisMessage &&
			event.type === "message_end" &&
			isTerminalAssistantMessage(event.message)
		) {
			// A file-scoped coder sometimes ends its first reply with no tool call and a
			// report that it has no edit tool or cannot find the file (p8/S1, p9/C3),
			// then does the same work when asked again. The orchestrator fails every
			// zero-call edit run as worker_no_work, so one repair round costs nothing
			// the run had left. A second empty reply passes through to that outcome.
			const zeroToolViolation =
				toolExecutionsStarted === 0 &&
				!zeroToolRepairQueued &&
				contract.kind === "mutation-report" &&
				input.readOnly !== true &&
				workerBudget.mode === "advisory" &&
				!synthesisToolLock &&
				activeWorkerTools.some((tool) => tool === ToolNames.Edit || tool === ToolNames.Write)
					? `no tool was called, so none of the assignment was done. The admitted tools are ${activeWorkerTools.join(", ")}, and they include ${activeWorkerTools.filter((tool) => tool === ToolNames.Edit || tool === ToolNames.Write).join(" and ")}. Inspect the workspace and do the assignment with them. If a tool refuses a call, report that refusal as the limitation.`
					: null;
			// A second no-work reply belongs to worker_no_work, even when its
			// report is malformed. The p8/S1 recovery must not spend shape repairs.
			const violation =
				zeroToolRepairQueued && toolExecutionsStarted === 0
					? null
					: (zeroToolViolation ??
						terminalContractViolation(contract, event.message, contractCwd, groundingRanges(), runEffects.snapshot()));
			if (violation !== null) {
				if (zeroToolViolation !== null || resultContractRepairsQueued < RESULT_CONTRACT_REPAIR_LIMIT) {
					if (zeroToolViolation !== null) zeroToolRepairQueued = true;
					else resultContractRepairsQueued += 1;
					if (zeroToolViolation === null && !resultContractRevisionActive && workerBudget.revision !== undefined) {
						resultContractRevisionActive = loopGuardRegistration.extendWorkerToolCallPhase(workerBudget.revision);
						if (resultContractRevisionActive) {
							synthesisToolLock = false;
							middlewareToolChoice.reset();
							stopAfterToolResultCallId = null;
						}
					}
					const revisionToolsAvailable =
						(workerBudget.mode === "advisory" || resultContractRevisionActive) && !synthesisToolLock;
					// Legacy enforced budgets need preauthorized growth to retain repair tools.
					if (!revisionToolsAvailable) synthesisToolLock = true;
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
						reason: violation,
						attempt: zeroToolViolation !== null ? 1 : resultContractRepairsQueued,
						anchors: observedReadAnchors(),
						toolsAvailable: revisionToolsAvailable,
					};
					const repair = revisionToolsAvailable
						? resultContractRepairMessages(repairInput, { provider: model.provider, api: model.api, model: model.id })
						: [resultContractRepairUserMessage(repairInput)];
					for (const message of repair) agent.followUp(message as unknown as AgentMessage);
				} else if (workerBoundFailure === null) {
					workerBoundFailure = `result contract failed after ${RESULT_CONTRACT_REPAIR_LIMIT} bounded repair rounds: ${violation}`;
					emit({
						type: "clio_coder_run_outcome",
						payload: { outcomeCode: "result_contract_exhausted", detail: workerBoundFailure },
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
				}
			: null;
	// Present only when the permit routes asks to the main agent with main
	// authority (Phase D): every decision must then name this attempt, the
	// parked request and its argument digest.
	const grantBinding = escalationConfig !== null ? input.escalation?.grant : undefined;
	const operatorUnattended = input.escalation?.operatorResponder === "none";
	const mainRoutedPermit = input.permitAllowance?.asks === "main" && input.permitAllowance.approvalAuthority === "main";
	let permissionFailure = false;

	// Exact, byte-stable denial reasons for the deny/fail postures. Escalate
	// timeouts and operator denials use their own wording below.
	const denyReason = (tool: string, actionClass: string): string =>
		unattendedEscalation
			? mainRoutedPermit
				? `permission denied by policy: no operator or granting main agent can answer worker asks for this dispatch (fleet.permissions.mode=main, fallback=deny); ${tool} requires ${actionClass} confirmation`
				: `permission denied by policy: no operator can answer worker escalations for this dispatch (fleet.permissions.mode=escalate, fallback=deny); ${tool} requires ${actionClass} confirmation`
			: `permission denied by policy: dispatched workers run non-interactively (fleet.permissions.mode=deny); ${tool} requires ${actionClass} confirmation`;
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
		timer: ReturnType<typeof setTimeout>;
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
		const denialContext =
			source === "timeout"
				? `escalation timed out with no ${grantBinding !== undefined ? "" : "operator "}decision`
				: `${decider} denied`;
		const reason = effectiveFail
			? `permission required for ${active.tool} (${active.actionClass}); ${denialContext} and workers fallback=fail ends this run`
			: hostReason !== undefined
				? `permission denied: ${hostReason}; ${active.tool} requires ${active.actionClass} confirmation`
				: `permission denied by ${source === "timeout" ? "escalation timeout fallback" : decider}: ${active.tool} requires ${active.actionClass} confirmation`;
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
	): boolean => {
		const active = activeEscalation;
		if (!active || active.requestId !== requestId) return false;
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
		if (escalationConfig) {
			const callKey = workerPermissionCacheKey(call, decision, meta.axis);
			if (consumedRequestIds.has(meta.requestId)) {
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
				const decider =
					remembered.source === "timeout"
						? "escalation timeout fallback"
						: remembered.source === "main"
							? "main agent"
							: "operator";
				const reason = `permission denied by ${decider}: an identical ${call.tool} call under the same permission conditions was already denied earlier in this run (request ${remembered.requestId}); the answer stands, so do not repeat this call`;
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
				registry.cancelParkedCall(meta.requestId, reason);
				return;
			}
			if (activeEscalation !== null) return;
			const requestId = meta.requestId;
			const authority: ApprovalAuthority = grantBinding === undefined ? "operator" : meta.approvalAuthority;
			if (grantBinding !== undefined && authority === "operator" && operatorUnattended) {
				// Only a person clears an operator rail, and nobody can answer here.
				const reason = `permission denied by policy: ${call.tool} raised an operator-authority ask and no operator can answer worker asks for this dispatch; ${call.tool} requires ${actionClass} confirmation`;
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
			// clears it on every resolution path.
			const timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), escalationConfig.timeoutMs);
			activeEscalation = { requestId, tool: call.tool, actionClass, callKey, authority, argDigest, timer };
			// The decider sees this exact call through a sanitized allowlisted
			// preview of its object. Unlisted fields cross only as type-and-size
			// summaries on this display event; the effect descriptor a grant is
			// evaluated against rides the control lane below.
			const target = describeCallTarget(call.tool, call.args);
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
				const withConsequence = consequence.length > 0 ? { ...frame, consequence } : frame;
				const carriesConsequence =
					Buffer.byteLength(JSON.stringify(withConsequence), "utf8") <= GRANT_REQUEST_FRAME_BUDGET_BYTES;
				input.emitGrantRequest?.(fits ? (carriesConsequence ? withConsequence : frame) : { ...frame, effect: null });
			}
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
		const reason =
			onPermission === "fail"
				? failReason(call.tool, actionClass)
				: policyDetail.length > 0
					? `${denyReason(call.tool, actionClass)}. ${policyDetail}`
					: denyReason(call.tool, actionClass);
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
		// CLB-5: changing the command cannot create an absent execute approval route.
		if (onPermission === "fail" || actionClass === "execute") {
			permissionFailure = true;
			registry.cancelParkedCalls(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			agent.abort();
			return;
		}
		registry.cancelParkedCalls(reason);
	});

	const promise = (async (): Promise<WorkerRunResult> => {
		try {
			await agent.prompt(promptMessagesForWorker(input));
			await agent.waitForIdle();
			unsubscribe();
			if (workerBoundFailure !== null) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: 1 };
			}
			if (permissionFailure) {
				return { messages: agent.state.messages.slice(inheritedCount), exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			}
			const messages = agent.state.messages.slice(inheritedCount);
			if (helperSchema !== null && acceptedHelperResult === null) {
				return { messages, exitCode: 1 };
			}
			const errorMessage = getTerminalAgentError(messages);
			if (errorMessage !== null) {
				if (errorMessage.length > 0) {
					process.stderr.write(`[worker] agent ended with stopReason=error: ${errorMessage}\n`);
				}
				return { messages, exitCode: 1 };
			}
			return { messages, exitCode: 0 };
		} catch (err) {
			unsubscribe();
			if (workerBoundFailure !== null) {
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
			clearActiveEscalation();
			unsubscribePermission();
		}
	})();

	return {
		promise,
		abort: () => {
			// Under escalate a parked call would otherwise keep waitForIdle from
			// returning, so cancel it before aborting. cancelParkedCalls is a
			// no-op when nothing is parked, so deny/fail abort stays unchanged.
			if (escalationConfig) {
				const reason = "run aborted while a permission escalation was pending";
				denyActiveEscalationOnAbort(reason);
				registry.cancelParkedCalls(reason);
			}
			agent.abort();
		},
		steer: (text: string) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return false;
			agent.steer(taskMessage(trimmed));
			return true;
		},
		resolvePermission: (requestId: string, decision: "approve" | "deny", binding?: WorkerDecisionBinding) =>
			resolveDecision(requestId, decision, binding),
	};
}
