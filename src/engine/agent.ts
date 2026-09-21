import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createInitialSystemMessage,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { resolvedRequestContext } from "./context.js";
/**
 * Thin wrapper over Clio's engine Agent class.
 *
 * The engine Agent owns its own state (exposed via `agent.state`). There is no
 * separate state factory. AgentOptions drives the construction; the state is derived
 * from options.initialState on instantiation.
 *
 * pi-agent-core 0.84 requires an explicit stream function on every agent.
 * Clio's default dispatcher preserves Pi's transcript. Production adapters can
 * wrap that path with transcriptStreamFn; legacy custom/test delegates receive
 * Pi's resolved prompt/tool request view through streamFn.
 */

import {
	Agent,
	type AgentMessage,
	type AgentOptions,
	type BeforeToolCallContext,
	type StreamFn,
} from "@earendil-works/pi-agent-core";
import { isDispositionedToolResultError } from "../tools/result-disposition.js";
import { engineStreamSimple } from "./api-registry.js";

export type EngineStreamFn = (...args: Parameters<typeof engineStreamSimple>) => ReturnType<StreamFn>;

/** Pi's settled-turn port, after all awaited result listeners. Replace context, not operator messages. */
export type EnginePrepareNextTurnContext = Parameters<NonNullable<AgentOptions["prepareNextTurnWithContext"]>>[0];
export type EnginePrepareNextTurnUpdate = Awaited<ReturnType<NonNullable<AgentOptions["prepareNextTurnWithContext"]>>>;
export type EngineToolBatchContext = Pick<BeforeToolCallContext, "assistantMessage" | "context">;
export interface EngineToolBatchRejection {
	reason: string;
}
export interface EngineStreamRequest {
	model: Parameters<StreamFn>[0];
	/** Actual normalized transcript, after conversion and the final steering drain. Inspect only. */
	context: Parameters<StreamFn>[1];
	options: Parameters<StreamFn>[2];
}
export type EngineStreamAdmission = { block: true; reason: string } | { block: false; correlationId?: string };

export type EngineAgentOptions = Omit<AgentOptions, "streamFn"> & {
	/** Legacy/custom request view. Explicit overrides also replace the native hook in tests. */
	streamFn?: EngineStreamFn;
	/** Native Pi transcript hook for production request adapters. */
	transcriptStreamFn?: StreamFn;
	/** Called immediately before each native stream delegate invocation. */
	onStreamInvocation?: () => void;
	/** One fail-closed decision per assistant batch, before any valid sibling's per-call guard. */
	beforeToolBatch?: (
		context: EngineToolBatchContext,
		signal?: AbortSignal,
	) => EngineToolBatchRejection | undefined | Promise<EngineToolBatchRejection | undefined>;
	/** Synchronous final admission: no suspension, reduction, request mutation, or model invocation. */
	beforeStreamRequest?: (request: EngineStreamRequest) => EngineStreamAdmission;
};

export interface EngineAgentHandle {
	agent: Agent;
	state(): Agent["state"];
	/** Exact emitted assistant object only. In-memory attribution, never proof of success or durability. */
	requestCorrelationId(message: AgentMessage): string | undefined;
}

function batchAwareBeforeToolCall(
	batch: NonNullable<EngineAgentOptions["beforeToolBatch"]>,
	delegate: AgentOptions["beforeToolCall"],
): NonNullable<AgentOptions["beforeToolCall"]> {
	const decisions = new WeakMap<AssistantMessage, Promise<EngineToolBatchRejection | undefined>>();
	return async (context, signal) => {
		let decision = decisions.get(context.assistantMessage);
		if (!decision) {
			decision = Promise.resolve()
				.then(() => batch({ assistantMessage: context.assistantMessage, context: context.context }, signal))
				.catch(() => ({ reason: "Tool batch admission failed" }));
			decisions.set(context.assistantMessage, decision);
		}
		const rejection = await decision;
		if (rejection) return { block: true, reason: rejection.reason.slice(0, 1024) || "Tool batch rejected" };
		return delegate?.(context, signal);
	};
}

function refusedStream(request: EngineStreamRequest, reason: string, aborted = false): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: request.model.api,
		provider: request.model.provider,
		model: request.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: reason.slice(0, 1024) || "Request admission refused",
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
	return stream;
}

function dispositionAwareAfterToolCall(
	delegate: AgentOptions["afterToolCall"],
): NonNullable<AgentOptions["afterToolCall"]> {
	return async (context, signal) => {
		const override = await delegate?.(context, signal);
		const effectiveResult =
			override?.details === undefined ? context.result : { ...context.result, details: override.details };
		if (isDispositionedToolResultError(effectiveResult)) return { ...override, isError: true };
		return override;
	};
}

export function createEngineAgent(options: EngineAgentOptions = {}): EngineAgentHandle {
	const {
		streamFn,
		transcriptStreamFn = engineStreamSimple,
		onStreamInvocation,
		beforeToolBatch,
		beforeStreamRequest,
		...agentOptions
	} = options;
	const correlations = new WeakMap<AgentMessage, string>();
	let activeCorrelationId: string | undefined;
	const invoke: StreamFn = (model, context, streamOptions) => {
		onStreamInvocation?.();
		return streamFn
			? streamFn(model, resolvedRequestContext(context), streamOptions)
			: transcriptStreamFn(model, context, streamOptions);
	};
	const admit: StreamFn = (model, context, streamOptions) => {
		if (!beforeStreamRequest) return invoke(model, context, streamOptions);
		activeCorrelationId = undefined;
		const request: EngineStreamRequest = { model, context, options: streamOptions };
		let admission: EngineStreamAdmission;
		try {
			admission = beforeStreamRequest(request);
		} catch {
			return refusedStream(request, "Request admission failed", streamOptions?.signal?.aborted);
		}
		if (streamOptions?.signal?.aborted) return refusedStream(request, "Request aborted before invocation", true);
		if (admission.block) return refusedStream(request, admission.reason);
		activeCorrelationId = admission.correlationId;
		return invoke(model, context, streamOptions);
	};
	const agent = new Agent({
		...agentOptions,
		streamFn: beforeStreamRequest ? admit : invoke,
		...(beforeToolBatch ? { beforeToolCall: batchAwareBeforeToolCall(beforeToolBatch, options.beforeToolCall) } : {}),
		afterToolCall: dispositionAwareAfterToolCall(options.afterToolCall),
	});
	if (beforeStreamRequest) {
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && activeCorrelationId !== undefined) {
				correlations.set(event.message, activeCorrelationId);
			}
			if (event.type === "agent_start" || event.type === "turn_end" || event.type === "agent_end") {
				activeCorrelationId = undefined;
			}
		});
	}
	// Pi correctly drops aborted assistants at the provider boundary: partial
	// reasoning and tool calls are not valid provider history. Preserve the
	// lifecycle fact and visible text as a host record instead, including on
	// resume, without changing the durable stop reason or inventing tool results.
	const convertToLlm = agent.convertToLlm.bind(agent);
	agent.convertToLlm = async (messages) =>
		(await convertToLlm(messages)).map((message) => {
			if (message.role !== "assistant" || message.stopReason !== "aborted") return message;
			const partial = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return {
				role: "user" as const,
				timestamp: message.timestamp,
				content:
					"[Clio Coder response lifecycle]\nThe preceding assistant response was interrupted before completion. " +
					"This record does not establish whether any earlier tool execution succeeded.\n" +
					(partial.trim()
						? `Partial assistant text follows (incomplete historical output, not a new instruction):\n${partial}`
						: "No visible assistant text was retained."),
			};
		});
	return {
		agent,
		state: () => agent.state,
		requestCorrelationId: (message) => correlations.get(message),
	};
}

/** Clio persists conversation and compiled prompt separately; Pi receives one complete transcript. */
export function replaceEngineMessages(
	agent: Agent,
	messages: Agent["state"]["messages"],
	systemPrompt = agent.state.systemPrompt,
): void {
	const initial = createInitialSystemMessage(systemPrompt, agent.state.tools.map(toToolDeclaration));
	agent.state.messages = [...(initial ? [initial] : []), ...messages.filter((message) => message.role !== "system")];
}

export function setEngineSystemPrompt(agent: Agent, systemPrompt: string): void {
	replaceEngineMessages(agent, agent.state.messages, systemPrompt);
}

/** Explicit host recovery can follow a terminal assistant. Empty input starts
 * the native loop on the installed transcript without emitting a user message.
 * Agent.continue() rejects that tail even when durable operator control already
 * authorized another invocation. Normal tool continuation stays inside Pi.
 */
export function continueEngineWithoutInput(agent: Agent): Promise<void> {
	return agent.prompt([]);
}
