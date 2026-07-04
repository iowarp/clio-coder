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
import { configureGuardrails } from "../core/guardrails.js";
import { agentSkillToolPolicy } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
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
import { createProtectedArtifactsRegistration } from "../domains/safety/protected-artifacts-registration.js";
import type { ToolProfileName } from "../tools/profiles.js";
import {
	DEFAULT_ESCALATION_FALLBACK,
	DEFAULT_ESCALATION_TIMEOUT_MS,
	WORKER_EXIT_PERMISSION_REQUIRED,
	type WorkerEscalationConfig,
	type WorkerPromptMessage,
} from "../worker/spec-contract.js";
import { registerFauxFromEnv } from "./ai.js";
import { startAntigravityWorkerRun } from "./antigravity/subprocess-runtime.js";
import { registerClioApiProviders, setGlobalDefaultMaxOutputTokens } from "./apis/index.js";
import { startClaudeSdkWorkerRun } from "./claude/sdk-runtime.js";
import { startClaudeCodeWorkerRun } from "./claude/subprocess-runtime.js";
import { createLoopGuardRegistration, readWorkerToolCallCap } from "./loop-guard.js";
import { patchProviderThinkingPayload } from "./provider-payload.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import type { ClioWorkerEvent } from "./worker-events.js";
import { createWorkerSafety, createWorkerToolRegistry, resolveAgentTools, type ToolTelemetry } from "./worker-tools.js";

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
	/** Orchestrator-resolved runtime decision carried on the WorkerSpec. */
	runtimeResolution?: RuntimeTargetSnapshot;
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
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

/**
 * Spin up a pi-agent-core Agent for the worker subprocess. Subscribes an event
 * sink that forwards every AgentEvent to `emit`. Starts one run via
 * `agent.prompt(task)`. Returns a handle with the final promise and an abort
 * function; the promise resolves when `agent.waitForIdle()` returns.
 */
export function startWorkerRun(input: WorkerRunInput, emit: WorkerEventEmit): WorkerRunHandle {
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
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createWorkerToolRegistry(
		input.middlewareSnapshot,
		safety,
		{
			...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
			...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
			...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
		},
		// Workers run unattended, so the loop guard carries the hard tool-call
		// cap in addition to repetition blocking. The protected-artifacts guard
		// starts empty (workers receive no orchestrator protection state) and
		// has no persistence sink; it exists so protect_path effects from
		// snapshot rules behave identically in workers.
		[
			createLoopGuardRegistration({ safety, toolCallCap: readWorkerToolCallCap() }),
			createProtectedArtifactsRegistration(),
		],
		input.autonomy,
	);
	const telemetry: ToolTelemetry = {
		onStart(event) {
			emit({ type: "clio_tool_start", payload: event });
		},
		onFinish(event) {
			emit({ type: "clio_tool_finish", payload: event });
		},
	};
	const tools = resolveAgentTools({
		registry,
		telemetry,
		allowedTools: activeWorkerTools,
		agentId: input.agentId,
		task: input.task,
		includeInteractiveTools: false,
		...(agentSkillPolicy ? { invokeOptions: () => ({ pendingSkillPolicy: agentSkillPolicy }) } : {}),
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
		onPayload: async (payload, currentModel) =>
			patchProviderThinkingPayload(payload, currentModel as Model<never>, effectiveThinkingLevel),
		getApiKey: async () => input.apiKey,
	};
	if (input.sessionId) options.sessionId = input.sessionId;

	const agent = new Agent(options);
	const unsubscribe = agent.subscribe(async (event) => {
		emit(event);
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
			const timer = setTimeout(() => resolveEscalation(requestId, "deny", "timeout"), escalationConfig.timeoutMs);
			timer.unref?.();
			activeEscalation = { requestId, tool: call.tool, actionClass, timer };
			emit({
				type: "clio_permission_escalated",
				payload: {
					requestId,
					tool: call.tool,
					summary: `${call.tool} requires ${actionClass} confirmation`,
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
