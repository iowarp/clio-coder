/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved EndpointDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. Every runtime
 * is an HTTP/native/pi-ai-backed adapter driven through pi-agent-core.
 */

import { agentSkillToolPolicy } from "../core/skill-activation.js";
import { type ToolName, ToolNames } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type {
	CapabilityFlags,
	EndpointDescriptor,
	RuntimeDescriptor,
	RuntimeTargetSnapshot,
	ThinkingLevel,
} from "../domains/providers/index.js";
import { applyModelCapabilityPatch, resolveModelRuntimeCapabilitiesForModel } from "../domains/providers/index.js";
import { resolveProvidersModelsDir } from "../domains/providers/knowledge-base-path.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseHit,
} from "../domains/providers/types/knowledge-base.js";
import { resolveToolPalette } from "../tools/palette.js";
import type { WorkerPromptMessage } from "../worker/spec-contract.js";
import { registerFauxFromEnv } from "./ai.js";
import { registerClioApiProviders } from "./apis/index.js";
import { patchReasoningSummaryPayload } from "./provider-payload.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import type { ClioWorkerEvent } from "./worker-events.js";
import {
	createWorkerLoopGuard,
	createWorkerSafety,
	createWorkerToolRegistry,
	resolveAgentTools,
	type ToolTelemetry,
} from "./worker-tools.js";

export interface WorkerRunInput {
	sessionId?: string;
	systemPrompt: string;
	dynamicPromptMessages?: ReadonlyArray<WorkerPromptMessage>;
	agentId: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	/** Orchestrator-resolved runtime decision carried on the WorkerSpec. */
	runtimeResolution?: RuntimeTargetSnapshot;
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
	/** Worker-safe declarative middleware metadata captured by the orchestrator. */
	middlewareSnapshot?: MiddlewareSnapshot;
	signal?: AbortSignal;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	/** Recipe-bound skill names; read_skill admits exactly these for the run. */
	agentSkills?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
}

export interface WorkerRunResult {
	messages: AgentMessage[];
	exitCode: number;
}

export interface WorkerRunHandle {
	promise: Promise<WorkerRunResult>;
	abort(): void;
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
		const dir = resolveProvidersModelsDir(import.meta.url);
		kbSingleton = dir ? new FileKnowledgeBase(dir) : new NullKnowledgeBase();
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
	// pi-ai is process-local. The orchestrator registers Clio API providers in
	// providers/extension.ts, but the worker subprocess starts a fresh process,
	// so it must register them here before any agent.prompt() touches a local
	// runtime (lmstudio-native, ollama-native).
	registerClioApiProviders();
	const fauxModel = registerFauxFromEnv();
	const workerPalette = resolveToolPalette({
		providerSupportsTools: workerProviderSupportsTools(input),
		userText: input.task,
		availableTools: input.allowedTools,
		workerAllowedTools: input.allowedTools,
	});
	// Recipe-bound skills: the palette never activates read_skill on its own;
	// a declared agent skill list is the harness-level grant that does. The
	// matching per-run policy below restricts read_skill to exactly those names.
	const agentSkillPolicy =
		input.allowedTools.includes(ToolNames.ReadSkill) && input.noSkills !== true
			? agentSkillToolPolicy(input.agentSkills ?? [])
			: undefined;
	const activeWorkerTools =
		agentSkillPolicy && !workerPalette.activeTools.includes(ToolNames.ReadSkill)
			? [...workerPalette.activeTools, ToolNames.ReadSkill]
			: workerPalette.activeTools;

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId);
	const synthesized = input.runtime.synthesizeModel(input.endpoint, input.wireModelId, kbHit);
	const model = applyModelCapabilityPatch(
		input.endpoint.runtime === "faux" && fauxModel ? fauxModel : (synthesized as unknown as Model<never>),
		input.modelCapabilities,
	);

	// Build the per-run safety contract once so the registry's admission path
	// and the agent-loop guard share the same loop-detector state. Without this,
	// the registry would create its own state and the beforeToolCall hook would
	// be unable to observe repetition that already triggered admission.
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createWorkerToolRegistry(input.middlewareSnapshot, safety, {
		...(input.noSkills !== undefined ? { noSkills: input.noSkills } : {}),
		...(input.skillPaths !== undefined ? { skillPaths: [...input.skillPaths] } : {}),
		...(input.trustProjectCompatRoots !== undefined ? { trustProjectCompatRoots: input.trustProjectCompatRoots } : {}),
	});
	const loopGuard = createWorkerLoopGuard({ safety });
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
	if (tools.length === 0 && input.allowedTools.length > 0 && workerPalette.groups.length > 0) {
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
			patchReasoningSummaryPayload(payload, currentModel as Model<never>, effectiveThinkingLevel),
		getApiKey: async () => input.apiKey,
		// Worker-side safety net. Pi-agent-core invokes this hook with
		// validated args before each tool call. When the guard reports a block
		// the loop emits an error tool result containing `reason`, feeding the
		// model a description of the failure so it can pivot. Hard-blocking on
		// the iteration cap protects against degenerate sessions that flood the
		// audit log with hallucinated paths.
		beforeToolCall: async (context) => {
			const decision = loopGuard.check(context.toolCall.name, context.args);
			if (decision.block) {
				return decision.reason !== undefined ? { block: true, reason: decision.reason } : { block: true };
			}
			return undefined;
		},
	};
	if (input.sessionId) options.sessionId = input.sessionId;

	const agent = new Agent(options);
	const unsubscribe = agent.subscribe(async (event) => {
		emit(event);
	});

	const promise = (async (): Promise<WorkerRunResult> => {
		try {
			await agent.prompt(promptMessagesForWorker(input));
			await agent.waitForIdle();
			unsubscribe();
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
			const msg = err instanceof Error ? err.message : String(err);
			emit({ type: "agent_end", messages: agent.state.messages });
			process.stderr.write(`[worker] agent error: ${msg}\n`);
			return { messages: agent.state.messages, exitCode: 1 };
		}
	})();

	return {
		promise,
		abort: () => agent.abort(),
	};
}
