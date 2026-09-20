import { createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
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

import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { isDispositionedToolResultError } from "../tools/result-disposition.js";
import { engineStreamSimple } from "./api-registry.js";

export type EngineStreamFn = (...args: Parameters<typeof engineStreamSimple>) => ReturnType<StreamFn>;

export type EngineAgentOptions = Omit<AgentOptions, "streamFn"> & {
	/** Legacy/custom request view. Explicit overrides also replace the native hook in tests. */
	streamFn?: EngineStreamFn;
	/** Native Pi transcript hook for production request adapters. */
	transcriptStreamFn?: StreamFn;
	/** Called immediately before each native stream delegate invocation. */
	onStreamInvocation?: () => void;
};

export interface EngineAgentHandle {
	agent: Agent;
	state(): Agent["state"];
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
	const { streamFn, transcriptStreamFn = engineStreamSimple, onStreamInvocation, ...agentOptions } = options;
	const agent = new Agent({
		...agentOptions,
		streamFn: (model, context, streamOptions) => {
			onStreamInvocation?.();
			return streamFn
				? streamFn(model, resolvedRequestContext(context), streamOptions)
				: transcriptStreamFn(model, context, streamOptions);
		},
		afterToolCall: dispositionAwareAfterToolCall(options.afterToolCall),
	});
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
