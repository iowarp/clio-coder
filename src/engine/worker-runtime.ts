/**
 * Worker-subprocess engine boundary.
 *
 * Owns the pi-agent-core Agent instance for a worker run and forwards every
 * AgentEvent to an emit callback (the worker entry serializes events to NDJSON
 * stdout). Post-W5 the surface takes a resolved EndpointDescriptor +
 * RuntimeDescriptor + wire model id, not a provider/model pair. Subprocess
 * runtimes (claude-code-cli, codex-cli, gemini-cli) do not touch pi-ai; they
 * delegate to subprocess-runtime.ts which spawns the CLI agent directly.
 */

import type { ToolName } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type {
	CapabilityFlags,
	EndpointDescriptor,
	RuntimeDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import { resolveModelRuntimeCapabilitiesForModel } from "../domains/providers/index.js";
import { resolveProvidersModelsDir } from "../domains/providers/knowledge-base-path.js";
import {
	FileKnowledgeBase,
	type KnowledgeBase,
	type KnowledgeBaseHit,
} from "../domains/providers/types/knowledge-base.js";
import type { WorkerPromptMessage } from "../worker/spec-contract.js";
import { registerFauxFromEnv } from "./ai.js";
import { registerClioApiProviders } from "./apis/index.js";
import { startClaudeCodeSdkWorkerRun } from "./claude-code-sdk-runtime.js";
import { patchReasoningSummaryPayload } from "./provider-payload.js";
import { startSubprocessWorkerRun } from "./subprocess-runtime.js";
import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type Model } from "./types.js";
import type { ClioWorkerEvent, ToolApprovalResponsePayload } from "./worker-events.js";
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
	task: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	/** Tool ids the worker is allowed to expose for this run. */
	allowedTools: ReadonlyArray<ToolName>;
	/** Mode matrix the worker runs under. Defaults to "default". */
	mode?: ModeName;
	/** Worker-safe declarative middleware metadata captured by the orchestrator. */
	middlewareSnapshot?: MiddlewareSnapshot;
	autoApprove?: "allow" | "deny";
	awaitApproval?: (requestId: string, timeoutMs?: number) => Promise<ToolApprovalResponsePayload>;
	signal?: AbortSignal;
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

function applyModelCapabilities(model: Model<never>, caps: Partial<CapabilityFlags> | undefined): Model<never> {
	if (!caps) return model;
	const mutable = model as { contextWindow?: number; maxTokens?: number; reasoning?: boolean };
	if (typeof caps.contextWindow === "number") mutable.contextWindow = caps.contextWindow;
	if (typeof caps.maxTokens === "number") mutable.maxTokens = caps.maxTokens;
	if (typeof caps.reasoning === "boolean") mutable.reasoning = caps.reasoning;
	return model;
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

function taskWithDynamicPromptContext(input: WorkerRunInput): string {
	const dynamic = input.dynamicPromptMessages ?? [];
	if (dynamic.length === 0) return input.task;
	// Subprocess CLIs expose one prompt string through argv/stdin, not an
	// ordered role/message transport. Keep the volatile context adjacent to the
	// task without pretending those runtimes can preserve provider message roles.
	return [...dynamic.map((fragment) => fragment.body), input.task].join("\n\n");
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

	if (input.runtime.kind === "subprocess") {
		const subprocessInput: Parameters<typeof startSubprocessWorkerRun>[0] = {
			systemPrompt: input.systemPrompt,
			task: taskWithDynamicPromptContext(input),
			endpoint: input.endpoint,
			runtime: input.runtime,
			wireModelId: input.wireModelId,
		};
		if (input.apiKey !== undefined) subprocessInput.apiKey = input.apiKey;
		if (input.signal !== undefined) subprocessInput.signal = input.signal;
		if (input.sessionId !== undefined) subprocessInput.sessionId = input.sessionId;
		if (input.mode !== undefined) subprocessInput.mode = input.mode;
		subprocessInput.allowedTools = input.allowedTools;
		return startSubprocessWorkerRun(subprocessInput, emit);
	}

	if (input.runtime.kind === "sdk" && input.runtime.id === "claude-code-sdk") {
		const sdkInput: Parameters<typeof startClaudeCodeSdkWorkerRun>[0] = {
			systemPrompt: input.systemPrompt,
			dynamicPromptMessages: input.dynamicPromptMessages ?? [],
			task: input.task,
			endpoint: input.endpoint,
			runtime: input.runtime,
			wireModelId: input.wireModelId,
		};
		if (input.sessionId !== undefined) {
			sdkInput.threadId = input.sessionId;
			sdkInput.resumeSessionId = input.sessionId;
		}
		if (input.mode !== undefined) sdkInput.mode = input.mode;
		if (input.thinkingLevel !== undefined) sdkInput.thinkingLevel = input.thinkingLevel;
		sdkInput.allowedTools = input.allowedTools;
		if (input.signal !== undefined) sdkInput.signal = input.signal;
		const sdkSafety = createWorkerSafety({ cwd: process.cwd() });
		sdkInput.safety = sdkSafety;
		if (input.autoApprove !== undefined) sdkInput.autoApprove = input.autoApprove;
		if (input.awaitApproval !== undefined) sdkInput.awaitApproval = input.awaitApproval;
		return startClaudeCodeSdkWorkerRun(sdkInput, emit);
	}

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId);
	const synthesized = input.runtime.synthesizeModel(input.endpoint, input.wireModelId, kbHit);
	const model = applyModelCapabilities(
		input.endpoint.runtime === "faux" && fauxModel ? fauxModel : (synthesized as unknown as Model<never>),
		input.modelCapabilities,
	);

	const mode: ModeName = input.mode ?? "default";
	// Build the per-run safety contract once so the registry's admission path
	// and the agent-loop guard share the same loop-detector state. Without this,
	// the registry would create its own state and the beforeToolCall hook would
	// be unable to observe repetition that already triggered admission.
	const safety = createWorkerSafety({ cwd: process.cwd() });
	const registry = createWorkerToolRegistry(mode, input.middlewareSnapshot, safety);
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
		mode,
		telemetry,
		allowedTools: input.allowedTools,
	});
	if (tools.length === 0 && input.allowedTools.length > 0) {
		process.stderr.write(
			`[worker] warning: no tools resolved for mode=${mode} allowed=[${input.allowedTools.join(",")}]\n`,
		);
	}
	const effectiveThinkingLevel = clampThinkingLevelForModel(model, input.thinkingLevel);

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
