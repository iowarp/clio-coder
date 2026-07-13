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

import { validateSettingsFile } from "../core/config.js";
import {
	configureGuardrails,
	isWorkerToolCallCapExceededReason,
	isWorkerToolCallCapSynthesisReason,
} from "../core/guardrails.js";
import { agentSkillToolPolicy } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import { createMiddlewareToolChoiceControl } from "../domains/middleware/index.js";
import { shouldRequestStalledTurnContinuation } from "../domains/middleware/stalled-turn.js";
import type {
	CapabilityFlags,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import { applyModelCapabilityPatch, resolveModelRuntimeCapabilitiesForModel } from "../domains/providers/index.js";
import { resolveProviderKnowledgeBaseRoots } from "../domains/providers/knowledge-base-path.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseHit,
} from "../domains/providers/types/knowledge-base.js";
import type { ActionClass } from "../domains/safety/action-classifier.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { describeCallTarget } from "../domains/safety/call-target.js";
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import type { ToolProfileName } from "../tools/profiles.js";
import { parseScoutSplitRecommendation } from "../tools/scout-split-recommendation.js";
import { hasVerifiedScoutGrounding, quarantineUnverifiedScoutBullets } from "../tools/worker-evidence.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	WORKER_EXIT_PERMISSION_REQUIRED,
	type WorkerBudget,
	type WorkerEscalationConfig,
	type WorkerPromptMessage,
	type WorkerProtectedArtifactState,
} from "../worker/spec-contract.js";
import { registerFauxFromEnv } from "./ai.js";
import { startAntigravityWorkerRun } from "./antigravity/subprocess-runtime.js";
import { registerClioApiProviders, setGlobalDefaultMaxOutputTokens } from "./apis/index.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { startClaudeCodeWorkerRun } from "./claude/subprocess-runtime.js";
import {
	createLoopGuardRegistration,
	isLoopGuardSynthesisBackstopReason,
	readWorkerToolCallCap,
	sanitizeLockedSynthesisMessage,
} from "./loop-guard.js";
import { patchWorkerRequestPayload } from "./provider-payload.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import type { ClioWorkerEvent } from "./worker-events.js";
import { createWorkerSafety, createWorkerToolRegistry, resolveAgentTools, type ToolTelemetry } from "./worker-tools.js";

/** Scout exploration attempts before a guaranteed text-only synthesis phase. */
export const SCOUT_SYNTHESIS_CORRECTION_LIMIT = 2;
export const SCOUT_SYNTHESIS_CORRECTION_MESSAGE =
	"Your previous response was not a final Scout handoff: it announced more tool work or omitted live path:line citations. Tool use is over. Return compact final findings now from evidence already gathered, cite every source claim as path:line, and put uncertainties under `Unresolved gaps:`. If the task truly cannot fit, return the bounded `SPLIT RECOMMENDATION:` protocol instead. Do not describe future actions.";
const SCOUT_SYNTHESIS_FINAL_CORRECTION_MESSAGE =
	"FINAL HANDOFF REQUIRED IN THIS RESPONSE. Start with `Findings:` and write the cited findings themselves; every bullet must contain a path:line citation from evidence already gathered. End with `Unresolved gaps:`. Do not say that you will read, compile, prepare, or produce the answer later. If no valid cited report is possible, output only a valid bounded `SPLIT RECOMMENDATION:` block.";
const SCOUT_CITATION_ANCHOR_LIMIT = 12;

export interface WorkerRunInput {
	sessionId?: string;
	systemPrompt: string;
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
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
	/** Dispatch-resolved agent phase policy and independent hard attempt cap. */
	budget?: WorkerBudget;
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
	skillPaths?: ReadonlyArray<string>;
	/** Recipe-bound skill names; context(scope=skills) admits exactly these for the run. */
	agentSkills?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/** Non-stall posture for permission-requiring tool calls; default "deny". */
	onPermission?: "deny" | "fail" | "escalate";
	/** Escalation bounds, honored only when onPermission="escalate". */
	escalation?: WorkerEscalationConfig;
	/**
	 * Session autonomy level captured at dispatch admission (sd-01 §2.5).
	 * Workers inherit the orchestrator's level; absent means the default.
	 */
	autonomy?: AutonomyLevel;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Enforced at the shared worker safety seam (createWorkerSafety) so both the
	 * native registry and the Claude SDK hook path block out-of-root writes.
	 */
	writeRoots?: ReadonlyArray<string>;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	abort(): void;
	/**
	 * Queue an operator steer on the agent's steering queue. pi-agent-core
	 * drains the queue after every tool batch and injects the text as a user
	 * message before the next assistant response. Fire-and-forget: a steer
	 * that races run completion is dropped with the run.
	 */
	steer(text: string): void;
	/**
	 * Apply an operator decision to a parked escalation. Present only on native
	 * pi-agent workers (the runtimes with a registry park loop); external
	 * runners omit it. Returns false when the requestId is unknown or already
	 * resolved (duplicate), so callers can drop the line without crashing.
	 */
	resolvePermission?(requestId: string, decision: "approve" | "deny"): boolean;
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

function replaceAssistantMessageText(message: AgentMessage | undefined, text: string): void {
	if (!isAssistantMessage(message) || !Array.isArray(message.content)) return;
	let replaced = false;
	for (const block of message.content as Array<{ type?: unknown; text?: unknown }>) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		block.text = replaced ? "" : text;
		replaced = true;
	}
}

function scoutSynthesisNeedsCorrection(
	message: AgentMessage | undefined,
	successfulLiveReadCitations: ReadonlyArray<string>,
): boolean {
	if (!isAssistantMessage(message)) return false;
	const text = assistantMessageText(message);
	if (text === null || text.length === 0) return true;
	if (parseScoutSplitRecommendation(text) !== null) return false;
	const stopReason = message.stopReason;
	const announcesMoreWork = shouldRequestStalledTurnContinuation({
		hook: "turn_end",
		text,
		metadata: {
			turnToolCalls: 0,
			...(typeof stopReason === "string" ? { stopReason } : {}),
		},
	});
	return announcesMoreWork || !hasVerifiedScoutGrounding(text, successfulLiveReadCitations);
}

function scoutSynthesisCorrectionMessage(attempt: number, citations: ReadonlyArray<string>): string {
	const directive = attempt === 1 ? SCOUT_SYNTHESIS_CORRECTION_MESSAGE : SCOUT_SYNTHESIS_FINAL_CORRECTION_MESSAGE;
	if (citations.length === 0) return directive;
	return `${directive}\n\nVerified live-read anchors (copy the relevant exact path:line forms into your findings):\n${citations
		.slice(-SCOUT_CITATION_ANCHOR_LIMIT)
		.map((citation) => `- ${citation}`)
		.join("\n")}`;
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
	try {
		const roots = resolveProviderKnowledgeBaseRoots(import.meta.url);
		kbSingleton = roots.length > 0 ? new FileKnowledgeBase(roots) : new NullKnowledgeBase();
	} catch {
		kbSingleton = new NullKnowledgeBase();
	}
	return kbSingleton;
}

function clampThinkingLevelForModel(model: Model<never>, requested: ThinkingLevel | undefined): ThinkingLevel {
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
	messages.push(taskMessage(input.task));
	return messages;
}

function workerProviderSupportsTools(input: WorkerRunInput): boolean {
	const runtimeDecision = input.runtimeResolution?.capabilities.tools;
	if (runtimeDecision !== undefined) return runtimeDecision === true;
	if (typeof input.modelCapabilities?.tools === "boolean") return input.modelCapabilities.tools;
	return input.runtime.defaultCapabilities.tools === true;
}

function assertResponseSchemaRuntime(input: WorkerRunInput): void {
	if (input.responseSchema === undefined) return;
	if (
		input.runtime.id === "llamacpp" &&
		input.runtime.kind === "http" &&
		input.runtime.apiFamily === "openai-completions" &&
		input.modelCapabilities?.structuredOutputs === "json-schema"
	) {
		return;
	}
	throw new Error(
		`responseSchema requires a native llamacpp runtime with resolved JSON-schema support; received '${input.runtime.id}'`,
	);
}

/**
 * Resolve the effective runtime budget for an admitted worker spec.
 *
 * Current v2 specs always take the first branch. An accepted legacy v1 spec
 * intentionally arrives without `budget`; preserve its historical runtime
 * policy by deriving the agent boundary from the operator-owned worker cap
 * and reserving up to five final slots for canonical reads.
 */
export function resolveWorkerRuntimeBudget(input: Pick<WorkerRunInput, "allowedTools" | "budget">): WorkerBudget {
	if (input.budget !== undefined) return input.budget;
	const hardCap = readWorkerToolCallCap();
	return {
		toolCalls: hardCap,
		readReserve: input.allowedTools.includes(ToolNames.Read) ? Math.min(5, Math.max(0, hardCap - 1)) : 0,
		synthesis: true,
		hardCap,
	};
}

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
	assertResponseSchemaRuntime(input);
	if (input.runtime.id === "claude-sdk") {
		return startClaudeSdkWorkerRun(input, emit);
	}
	if (input.runtime.id === "claude-code") {
		return startClaudeCodeWorkerRun(input, emit);
	}
	if (input.runtime.id === "antigravity-code") {
		return startAntigravityWorkerRun(input, emit);
	}

	// pi-ai is process-local. The orchestrator registers Clio API providers in
	// providers/extension.ts, but the worker subprocess starts a fresh process,
	// so it must register them here before any agent.prompt() touches a local
	// runtime (lmstudio-native, ollama-native).
	registerClioApiProviders();
	// The worker is a fresh process; mirror the orchestrator's global output
	// budget so dispatched runs honor settings.defaults.maxTokens too. Use the
	// non-throwing read: a worker must not abort over a settings issue the parent
	// already surfaced.
	const workerSettings = validateSettingsFile().settings;
	setGlobalDefaultMaxOutputTokens(workerSettings.defaults.maxTokens);
	// Same mirroring for guardrail policy: the worker's loop-guard cap and tool
	// byte caps resolve settings-first, so the fresh process needs the section
	// installed before any registry or tool construction reads it.
	configureGuardrails(workerSettings.guardrails);
	const fauxModel = registerFauxFromEnv();
	// Workers are bounded runs against an admission-verified recipe surface.
	// They have no operator to widen a missing tool, so the active surface is
	// exactly the admitted set.
	const agentSkillPolicy =
		input.allowedTools.includes(ToolNames.Context) && input.noSkills !== true
			? agentSkillToolPolicy(input.agentSkills ?? [])
			: undefined;
	const activeWorkerTools = workerProviderSupportsTools(input) ? input.allowedTools : [];

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId);
	const synthesized = input.runtime.synthesizeModel(input.target, input.wireModelId, kbHit);
	const model = applyModelCapabilityPatch(
		input.target.runtime === "faux" && fauxModel ? fauxModel : (synthesized as unknown as Model<never>),
		input.modelCapabilities,
	);

	// Per-run safety contract: one loop-detector state per worker subprocess.
	// The loop guard rides on the registry's middleware contract as a
	// before_tool registration (engine/loop-guard.ts), so admission and
	// repetition detection share one seam; there is no agent-loop hook anymore.
	const safety = createWorkerSafety({
		cwd: process.cwd(),
		...(input.writeRoots !== undefined ? { writeRoots: input.writeRoots } : {}),
		...(input.protectedArtifactState !== undefined
			? { protectedArtifactState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	// Flipped by the loop guard's lockout callback; read by onPayload below to
	// force the remaining model rounds text-only via tool_choice none.
	let synthesisToolLock = false;
	let workerBoundFailure: string | null = null;
	let workerBoundAborted = false;
	let abortWorkerForBound: (() => void) | null = null;
	// For synthesis:false, the loop guard records the final admitted call while
	// rejecting later siblings immediately. The runtime stops only after pi has
	// emitted that call's tool-result message, so a slow tool is never aborted
	// merely because its before_tool admission reached the agent boundary.
	let stopAfterToolResultCallId: string | null = null;
	const workerBudget = resolveWorkerRuntimeBudget(input);
	const readReserve = input.allowedTools.includes(ToolNames.Read) ? workerBudget.readReserve : 0;
	const middlewareToolChoice = createMiddlewareToolChoiceControl();
	// Tool calls emitted by one provider response share this correlation. The
	// loop guard counts synthesis-lock noncompliance by model round, preventing
	// one wide parallel batch from consuming the entire denial backstop.
	let workerModelRound = 0;
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
			createLoopGuardRegistration({
				safety,
				toolCallCap: workerBudget.hardCap,
				toolCallSoftLimit: workerBudget.toolCalls,
				toolCallSoftReadReserve: readReserve,
				turnSynthesisLockout: workerBudget.synthesis,
				// Once locked, the next model round is forced text-only at the
				// request level (tool_choice none in onPayload below): the lockout
				// directive alone relies on model compliance, and measured local
				// models kept calling tools until the backstop aborted the run.
				onSynthesisLockout: () => {
					if (workerBudget.synthesis) {
						synthesisToolLock = true;
					}
				},
				...(!workerBudget.synthesis
					? {
							onSoftLimitFinalCallAdmitted: (toolCallId: string | undefined) => {
								if (workerBoundFailure === null) {
									workerBoundFailure = `worker agent budget reached (${workerBudget.toolCalls}); synthesis is disabled`;
								}
								// Native agent tool calls carry a stable provider id. The empty
								// sentinel keeps even an invariant violation on the post-result
								// path instead of reintroducing a before_tool abort.
								stopAfterToolResultCallId = toolCallId ?? "";
							},
						}
					: {}),
				...(readReserve > 0
					? {
							onSoftReadReserve: () => {
								middlewareToolChoice.apply([{ kind: "require_tool", toolName: ToolNames.Read }]);
							},
						}
					: {}),
			}),
			createProtectedArtifactsRegistration({
				...(input.protectedArtifactState !== undefined
					? { initialState: { artifacts: [...input.protectedArtifactState.artifacts] } }
					: {}),
			}),
		],
		input.autonomy,
		(effects) => middlewareToolChoice.apply(effects),
	);
	let scoutSynthesisCorrectionsQueued = 0;
	const pendingScoutReadCitations = new Map<string, string>();
	const successfulScoutReadCitations: string[] = [];
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "clio_tool_start", payload: event });
		},
		onFinish(event) {
			emit({ type: "clio_tool_finish", payload: event });
			if (event.outcome !== "blocked" || typeof event.reason !== "string") return;
			// Lifetime-cap lockout: record the bound (the run must not seal as an
			// ordinary success) but do not abort. The loop guard has flipped the
			// synthesis tool lock, so the next model round runs text-only and the
			// synthesized answer still reaches message_end and the receipt.
			if (isWorkerToolCallCapSynthesisReason(event.reason)) {
				if (workerBoundFailure === null) {
					workerBoundFailure = event.reason;
					process.stderr.write(`[worker] ${event.reason}\n`);
				}
				return;
			}
			// Hard bounds: the legacy immediate cap abort (lockout not wired) and
			// the synthesis backstop for a model that keeps emitting tool calls
			// after the lock. Both end the run; the first recorded bound wins the
			// receipt diagnostic.
			if (isWorkerToolCallCapExceededReason(event.reason) || isLoopGuardSynthesisBackstopReason(event.reason)) {
				if (workerBoundAborted) return;
				workerBoundAborted = true;
				if (workerBoundFailure === null) workerBoundFailure = event.reason;
				process.stderr.write(`[worker] ${event.reason}\n`);
				abortWorkerForBound?.();
			}
		},
	};
	const tools = resolveAgentTools({
		registry,
		telemetry,
		allowedTools: activeWorkerTools,
		agentId: input.agentId,
		task: input.task,
		includeInteractiveTools: false,
		invokeOptions: () => ({
			correlationId: `worker-model-round-${workerModelRound}`,
			...(agentSkillPolicy ? { pendingSkillPolicy: agentSkillPolicy } : {}),
		}),
	});
	if (tools.length === 0 && activeWorkerTools.length > 0) {
		process.stderr.write(`[worker] warning: no tools resolved for allowed=[${activeWorkerTools.join(",")}]\n`);
	}
	const effectiveThinkingLevel = clampThinkingLevelForModel(
		model,
		input.runtimeResolution?.effectiveThinkingLevel ?? input.thinkingLevel,
	);

	const options: AgentOptions = {
		initialState: {
			systemPrompt: input.systemPrompt,
			model,
			thinkingLevel: effectiveThinkingLevel,
			tools,
			messages: [],
		},
		onPayload: async (payload, currentModel) => {
			const middlewareChoice = middlewareToolChoice.current();
			return patchWorkerRequestPayload(payload, currentModel as Model<never>, {
				runtimeId: input.runtime.id,
				thinkingLevel: effectiveThinkingLevel,
				...(input.responseSchema !== undefined ? { responseSchema: input.responseSchema } : {}),
				toolChoiceNone: synthesisToolLock || middlewareChoice.kind === "none",
				...(middlewareChoice.kind === "required" ? { toolChoiceName: middlewareChoice.toolName } : {}),
			});
		},
		getApiKey: async () => input.apiKey,
	};
	if (input.sessionId) options.sessionId = input.sessionId;

	const agent = new Agent(options);
	abortWorkerForBound = () => agent.abort();
	const unsubscribe = agent.subscribe(async (event) => {
		if (event.type === "turn_start") workerModelRound += 1;
		if (event.type === "tool_execution_start") middlewareToolChoice.toolStarted(event.toolName);
		if (input.agentId === "scout" && event.type === "tool_execution_start" && event.toolName === ToolNames.Read) {
			const args = event.args as Record<string, unknown>;
			const path = typeof args.path === "string" ? args.path.trim() : "";
			const offset =
				typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 1;
			if (path.length > 0 && args.tail === undefined) pendingScoutReadCitations.set(event.toolCallId, `${path}:${offset}`);
		}
		if (input.agentId === "scout" && event.type === "tool_execution_end" && event.toolName === ToolNames.Read) {
			const citation = pendingScoutReadCitations.get(event.toolCallId);
			pendingScoutReadCitations.delete(event.toolCallId);
			if (citation !== undefined && event.isError !== true && !successfulScoutReadCitations.includes(citation)) {
				successfulScoutReadCitations.push(citation);
			}
		}
		// Synthesis-locked run: a model that ignores tool_choice none emits its
		// chat template's tool-call syntax as plain text. Sanitize the finished
		// message in place before it hits stdout; pi stores this same object in
		// agent state, so the NDJSON event, the dispatch consumer's answer
		// reconstruction, and any later provider round all see the same text.
		if (synthesisToolLock && event.type === "message_end") {
			sanitizeLockedSynthesisMessage(event.message);
			if (input.agentId === "scout") {
				const text = assistantMessageText(event.message);
				if (text !== null && parseScoutSplitRecommendation(text) === null) {
					const grounded = quarantineUnverifiedScoutBullets(text, successfulScoutReadCitations);
					if (grounded !== text) replaceAssistantMessageText(event.message, grounded);
				}
			}
			if (input.agentId === "scout" && scoutSynthesisNeedsCorrection(event.message, successfulScoutReadCitations)) {
				if (scoutSynthesisCorrectionsQueued < SCOUT_SYNTHESIS_CORRECTION_LIMIT) {
					scoutSynthesisCorrectionsQueued += 1;
					agent.followUp(
						taskMessage(scoutSynthesisCorrectionMessage(scoutSynthesisCorrectionsQueued, successfulScoutReadCitations)),
					);
				} else if (workerBoundFailure === null) {
					workerBoundFailure =
						"Scout synthesis contract failed: two bounded corrective rounds still announced tool work or omitted verified live-read path:line citations";
					process.stderr.write(`[worker] ${workerBoundFailure}\n`);
				}
			}
		}
		emit(event);
		if (
			stopAfterToolResultCallId !== null &&
			event.type === "message_end" &&
			event.message.role === "toolResult" &&
			(stopAfterToolResultCallId.length === 0 || event.message.toolCallId === stopAfterToolResultCallId)
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
	// over the event/stdin channels, and applies the configured deny/fail
	// fallback on timeout so the run still cannot hang forever.
	const onPermission = input.onPermission ?? "deny";
	const escalationConfig: WorkerEscalationConfig | null =
		onPermission === "escalate"
			? {
					timeoutMs: input.escalation?.timeoutMs ?? DEFAULT_ESCALATION_TIMEOUT_MS,
					fallback: input.escalation?.fallback ?? DEFAULT_ESCALATION_FALLBACK,
				}
			: null;
	let permissionFailure = false;

	// Exact, byte-stable denial reasons for the deny/fail postures. Escalate
	// timeouts and operator denials use their own wording below.
	const denyReason = (tool: string, actionClass: string): string =>
		`permission denied by policy: dispatched workers run non-interactively (workers.onPermission=deny); ${tool} requires ${actionClass} confirmation`;
	const failReason = (tool: string, actionClass: string): string =>
		`permission required for ${tool} (${actionClass}); workers.onPermission=fail ends this run`;

	interface ActiveEscalation {
		requestId: string;
		tool: string;
		actionClass: ActionClass;
		timer: ReturnType<typeof setTimeout>;
	}
	let activeEscalation: ActiveEscalation | null = null;
	const clearActiveEscalation = (): void => {
		if (activeEscalation) {
			clearTimeout(activeEscalation.timer);
			activeEscalation = null;
		}
	};

	// One escalation is outstanding at a time. A call that parks while a prior
	// escalation awaits a decision is re-notified after the active one resolves
	// (registry.resumeParkedCalls re-fires onPermissionRequired for the next
	// parked call), so it never gets lost and the requestId->parked-call
	// mapping stays unambiguous.
	const resolveEscalation = (
		requestId: string,
		decision: "approve" | "deny",
		source: "operator" | "timeout",
	): boolean => {
		const active = activeEscalation;
		if (!active || active.requestId !== requestId) return false;
		clearActiveEscalation();
		if (decision === "approve") {
			emit({
				type: "clio_permission_resolved",
				payload: {
					tool: active.tool,
					actionClass: active.actionClass,
					mode: "escalate",
					source,
					requestId,
					decision: "approved",
					reason: `operator approved permission escalation for ${active.tool} (${active.actionClass})`,
				},
			} as ClioWorkerEvent);
			void registry.resumeParkedCalls({
				actionClass: active.actionClass,
				requestId,
				requestedBy: `escalation:${source}`,
			});
			return true;
		}
		// A denial resolves to the effective posture: a timeout with fallback
		// "fail" ends the run like posture fail; every other denial mirrors
		// posture deny, so the structured tool denial the model sees (including
		// the "permission denied" reason) is identical to the deny posture.
		const effectiveFail = source === "timeout" && escalationConfig?.fallback === "fail";
		const mode: "deny" | "fail" = effectiveFail ? "fail" : "deny";
		const denialContext = source === "timeout" ? "escalation timed out with no operator decision" : "operator denied";
		const reason = effectiveFail
			? `permission required for ${active.tool} (${active.actionClass}); ${denialContext} and workers fallback=fail ends this run`
			: `permission denied by ${source === "timeout" ? "escalation timeout fallback" : "operator"}: ${active.tool} requires ${active.actionClass} confirmation`;
		emit({
			type: "clio_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode,
				source,
				requestId,
				decision: "denied",
				reason,
			},
		} as ClioWorkerEvent);
		if (effectiveFail) {
			permissionFailure = true;
			registry.cancelParkedCalls(reason);
			agent.abort();
			return true;
		}
		if (source === "operator") registry.cancelParkedCall(requestId, reason);
		else registry.cancelParkedCalls(reason);
		return true;
	};

	const denyActiveEscalationOnAbort = (reason: string): void => {
		const active = activeEscalation;
		if (!active) return;
		emit({
			type: "clio_permission_resolved",
			payload: {
				tool: active.tool,
				actionClass: active.actionClass,
				mode: "escalate",
				source: "operator",
				requestId: active.requestId,
				decision: "denied",
				reason,
			},
		} as ClioWorkerEvent);
		clearActiveEscalation();
	};

	const unsubscribePermission = registry.onPermissionRequired((call, decision, meta) => {
		const actionClass = decision.classification.actionClass;
		if (escalationConfig) {
			if (activeEscalation !== null) return;
			const requestId = meta.requestId;
			// The timer must hold the event loop: its firing is what denies an
			// escalation the orchestrator never resolves. clearActiveEscalation
			// clears it on every resolution path.
			const timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), escalationConfig.timeoutMs);
			activeEscalation = { requestId, tool: call.tool, actionClass, timer };
			// The operator decides on this exact call, so the escalation carries a
			// sanitized preview of its object; the args stay inside the worker. The
			// cap bounds the NDJSON line, and the overlay truncates further.
			const target = describeCallTarget(call.args).slice(0, 200);
			emit({
				type: "clio_permission_escalated",
				payload: {
					requestId,
					tool: call.tool,
					summary: `${call.tool} requires ${actionClass} confirmation`,
					...(target.length > 0 ? { target } : {}),
					axis: meta.axis,
					decision: {
						actionClass,
						reasons: decision.classification.reasons,
						...(decision.policy?.reasonCode ? { reasonCode: decision.policy.reasonCode } : {}),
						...(decision.policy?.ruleId ? { ruleId: decision.policy.ruleId } : {}),
						...(decision.policy?.policySource ? { policySource: decision.policy.policySource } : {}),
					},
					timeoutMs: escalationConfig.timeoutMs,
				},
			} as ClioWorkerEvent);
			return;
		}
		const reason = onPermission === "fail" ? failReason(call.tool, actionClass) : denyReason(call.tool, actionClass);
		emit({
			type: "clio_permission_resolved",
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
				return { messages: agent.state.messages, exitCode: 1 };
			}
			if (permissionFailure) {
				return { messages: agent.state.messages, exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			}
			const messages = agent.state.messages;
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
				return { messages: agent.state.messages, exitCode: 1 };
			}
			if (permissionFailure) {
				return { messages: agent.state.messages, exitCode: WORKER_EXIT_PERMISSION_REQUIRED };
			}
			const msg = err instanceof Error ? err.message : String(err);
			emit({ type: "agent_end", messages: agent.state.messages });
			process.stderr.write(`[worker] agent error: ${msg}\n`);
			return { messages: agent.state.messages, exitCode: 1 };
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
			if (trimmed.length === 0) return;
			emit({ type: "clio_steer_received", payload: { chars: trimmed.length } });
			agent.steer(taskMessage(trimmed));
		},
		resolvePermission: (requestId: string, decision: "approve" | "deny") =>
			resolveEscalation(requestId, decision, "operator"),
	};
}
