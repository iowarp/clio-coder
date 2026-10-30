import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	createInitialSystemMessage,
	getSystemMessageText,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { createHostPolicyMessage, isHostPolicyMessage } from "../core/host-policy-message.js";
import { ProviderCompactionError, providerCheckpointFromMessage } from "../core/provider-checkpoint-handle.js";
import { acceptsImageInput } from "../domains/providers/image-input.js";
import { compactOpenAI, providerCheckpointCompatibility } from "./apis/openai-compaction.js";
import { normalizeContext, resolvedRequestContext } from "./context.js";
import { omitImageBlocks } from "./image-context.js";
import type { CodexConfiguration, ProviderCheckpointHandle } from "./types.js";

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

import type { AgentMessage, AgentOptions, BeforeToolCallContext, StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";

export {
	bindCodexUserTurn as setEngineCodexUserTurn,
	codexUserTurn as engineCodexUserTurn,
} from "./apis/codex-configuration.js";

import { engineMainStreamSimple, engineStreamSimple } from "./api-registry.js";
import type { PinnedPromptPrefix } from "./apis/anthropic-system-split.js";
import { filterAssistantProseStream } from "./assistant-prose-stream.js";
import { clioClientIdentity } from "./client-identity.js";
import { guardToolArgumentStream } from "./tool-argument-stream.js";

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
	/** Final admission before invoking the model; an interactive budget gate may wait for the operator. */
	beforeStreamRequest?: (request: EngineStreamRequest) => EngineStreamAdmission | Promise<EngineStreamAdmission>;
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

const codexConfigurations = new WeakMap<Agent, CodexConfiguration>();
const providerCompactionPolicies = new WeakMap<Agent, () => boolean>();
const providerReplayFallbacks = new WeakMap<Agent, (reason: string) => Promise<void>>();

/** A rejected replay is resolved through the owning turn path before one fresh invocation (#423). */
export function setEngineProviderReplayFallback(agent: Agent, resolve: (reason: string) => Promise<void>): void {
	providerReplayFallbacks.set(agent, resolve);
}

function portableReplayReason(error: string): string | null {
	if (error.includes("native-setting-or-route-disabled")) return "setting-off";
	if (error.includes("provider checkpoint requires portable replay")) return "non-codex-route";
	return (
		error.match(
			/native-replay-(?:checkpoint-unreadable|provider-or-model-changed|account-changed-or-unknown|non-codex-route)/u,
		)?.[0] ?? null
	);
}
const providerCheckpointObservers = new WeakMap<
	Agent,
	(handle: ProviderCheckpointHandle, inputTokens: number) => void
>();

export function setEngineProviderCheckpointObserver(
	agent: Agent,
	observer: (handle: ProviderCheckpointHandle, inputTokens: number) => void,
): void {
	providerCheckpointObservers.set(agent, observer);
}

/** Read the live setting at payload time, including config reloads during preparation (#423). */
export function setEngineProviderCompactionPolicy(agent: Agent, enabled: () => boolean): void {
	providerCompactionPolicies.set(agent, enabled);
}

/** Snapshot public Pi transforms and the live transcript without running the agent loop (#423). */
export async function compactEngineCodex(
	agent: Agent,
	options: { signal?: AbortSignal; sessionId?: string; onUsage?: Parameters<typeof compactOpenAI>[0]["onUsage"] },
) {
	let messages = structuredClone(agent.state.messages);
	if (agent.transformContext) messages = await agent.transformContext(messages, options.signal);
	const converted = await agent.convertToLlm(messages);
	// Cutting an in-flight tool batch would orphan its eventual results (#423).
	const pending = new Set<string>();
	for (const message of converted) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
		} else if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	if (pending.size > 0) throw new ProviderCompactionError("native-pending-tools");
	const apiKey = await agent.getApiKey?.(agent.state.model.provider);
	options.signal?.throwIfAborted();
	const configuration = codexConfigurations.get(agent);
	return compactOpenAI({
		stream: engineMainStreamSimple,
		model: agent.state.model,
		context: { messages: converted },
		options: {
			clioProviderCompaction: () => providerCompactionPolicies.get(agent)?.() === true,
			clioProviderCheckpointObserved: (handle, tokens) => providerCheckpointObservers.get(agent)?.(handle, tokens),
			...(agent.onProviderStreamEvent ? { onProviderStreamEvent: agent.onProviderStreamEvent } : {}),
			...(apiKey === undefined ? {} : { apiKey }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(configuration ? { codexConfiguration: configuration } : {}),
			...(agent.state.thinkingLevel === "off" ? {} : { reasoning: agent.state.thinkingLevel }),
			...((options.sessionId ?? agent.sessionId) === undefined ? {} : { sessionId: options.sessionId ?? agent.sessionId }),
			...(agent.transport === undefined ? {} : { transport: agent.transport }),
			...(agent.onPayload === undefined ? {} : { onPayload: agent.onPayload }),
			...(agent.onResponse === undefined ? {} : { onResponse: agent.onResponse }),
		},
		...(options.onUsage ? { onUsage: options.onUsage } : {}),
	});
}

/** Session-control owns durable effort history; the engine only serializes it (#423). */
export function setEngineCodexConfiguration(agent: Agent, configuration: CodexConfiguration | undefined): void {
	if (configuration) codexConfigurations.set(agent, configuration);
	else codexConfigurations.delete(agent);
}

export function engineCodexConfiguration(agent: Agent): CodexConfiguration | undefined {
	return codexConfigurations.get(agent);
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
	const invoke: StreamFn = async (model, context, streamOptions) => {
		onStreamInvocation?.();
		streamOptions = {
			...streamOptions,
			clioProviderCheckpointObserved: (handle: ProviderCheckpointHandle, tokens: number) =>
				providerCheckpointObservers.get(agent)?.(handle, tokens),
			clioProviderCompaction: () => providerCompactionPolicies.get(agent)?.() === true,
		} as typeof streamOptions;
		const configuration = codexConfigurations.get(agent);
		if (configuration) streamOptions = { ...streamOptions, codexConfiguration: configuration } as typeof streamOptions;
		const delegate = (guarded: typeof streamOptions) =>
			streamFn ? streamFn(model, resolvedRequestContext(context), guarded) : transcriptStreamFn(model, context, guarded);
		const open = async () =>
			filterAssistantProseStream(
				await (streamFn || transcriptStreamFn !== engineStreamSimple
					? guardToolArgumentStream(model, context, streamOptions, delegate)
					: delegate(streamOptions)),
				model,
			);
		const marker = normalizeContext(context)
			.messages.map(providerCheckpointFromMessage)
			.find((handle) => handle !== undefined);
		const resolve = providerReplayFallbacks.get(agent);
		if (!marker || !resolve) return open();
		const rebuild = async (reason: string): Promise<void> => {
			await resolve(reason);
			streamOptions?.signal?.throwIfAborted();
			let messages = structuredClone(agent.state.messages);
			if (agent.transformContext) messages = await agent.transformContext(messages, streamOptions?.signal);
			context = normalizeContext({ messages: await agent.convertToLlm(messages) });
			const { codexConfiguration: _old, ...portableOptions } = (streamOptions ?? {}) as NonNullable<
				typeof streamOptions
			> & { codexConfiguration?: CodexConfiguration };
			const fresh = codexConfigurations.get(agent);
			streamOptions = { ...portableOptions, ...(fresh ? { codexConfiguration: fresh } : {}) } as typeof streamOptions;
		};
		const preflight =
			providerCompactionPolicies.get(agent)?.() === true
				? providerCheckpointCompatibility(marker, model, streamOptions?.apiKey)
				: "setting-off";
		if (preflight !== null) await rebuild(preflight);
		const output = createAssistantMessageEventStream();
		void (async () => {
			let retried = preflight !== null;
			try {
				for (;;) {
					let retryReason: string | null = null;
					let start:
						| Extract<Awaited<ReturnType<typeof open>> extends AsyncIterable<infer E> ? E : never, { type: "start" }>
						| undefined;
					try {
						const source = await open();
						for await (const event of source) {
							if (event.type === "start") {
								start = event;
								continue;
							}
							if (!retried && event.type === "error") retryReason = portableReplayReason(event.error.errorMessage ?? "");
							if (retryReason !== null) break;
							if (start) {
								output.push(start);
								start = undefined;
							}
							output.push(event);
						}
					} catch (error) {
						retryReason = !retried ? portableReplayReason(error instanceof Error ? error.message : String(error)) : null;
						if (retryReason === null) throw error;
					}
					if (retryReason === null) break;
					retried = true;
					await rebuild(retryReason);
				}
				output.end();
			} catch (error) {
				const failure = await refusedStream(
					{ model, context, options: streamOptions },
					error instanceof Error ? error.message : String(error),
					streamOptions?.signal?.aborted,
				);
				for await (const event of failure) output.push(event);
				output.end();
			}
		})();
		return output;
	};
	const admit: StreamFn = (model, context, streamOptions) => {
		if (!beforeStreamRequest) return invoke(model, context, streamOptions);
		activeCorrelationId = undefined;
		const request: EngineStreamRequest = { model, context, options: streamOptions };
		const complete = (admission: EngineStreamAdmission): ReturnType<StreamFn> => {
			if (streamOptions?.signal?.aborted) return refusedStream(request, "Request aborted before invocation", true);
			if (admission.block) return refusedStream(request, admission.reason);
			activeCorrelationId = admission.correlationId;
			return invoke(model, context, streamOptions);
		};
		try {
			const admission = beforeStreamRequest(request);
			return admission instanceof Promise
				? admission.then(complete, () => refusedStream(request, "Request admission failed", streamOptions?.signal?.aborted))
				: complete(admission);
		} catch {
			return refusedStream(request, "Request admission failed", streamOptions?.signal?.aborted);
		}
	};
	const agent = new Agent({
		// Pi 1.4's Agent attributes requests to pi unless the host names its own identity.
		identity: clioClientIdentity(),
		...agentOptions,
		streamFn: beforeStreamRequest ? admit : invoke,
		...(beforeToolBatch ? { beforeToolCall: batchAwareBeforeToolCall(beforeToolBatch, options.beforeToolCall) } : {}),
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
	agent.convertToLlm = async (messages) => {
		const converted = (await convertToLlm(messages)).map((message) => {
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
		return acceptsImageInput({ modelInput: agent.state.model.input }) ? converted : omitImageBlocks(converted);
	};
	return {
		agent,
		state: () => agent.state,
		requestCorrelationId: (message) => correlations.get(message),
	};
}

/** Clio persists conversation and compiled prompt separately; Pi receives one complete transcript. */
export function engineInitialSystemPrompt(agent: Agent): string {
	const initial = agent.state.messages[0];
	// Pi's state.systemPrompt folds later policies into its text. Reusing that
	// projection as the baseline would duplicate updates and rewrite the prefix (#423).
	return initial?.role === "system"
		? isHostPolicyMessage(initial)
			? ""
			: getSystemMessageText(initial)
		: agent.state.systemPrompt;
}

export function replaceEngineMessages(
	agent: Agent,
	messages: Agent["state"]["messages"],
	systemPrompt = engineInitialSystemPrompt(agent),
): void {
	const initial = createInitialSystemMessage(systemPrompt, agent.state.tools.map(toToolDeclaration));
	agent.state.messages = [
		...(initial ? [initial] : []),
		...messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
	];
}

export function appendEnginePolicyMessage(agent: Agent, id: string, content: string, timestamp: number): void {
	if (
		agent.state.messages.some(
			(message) =>
				isHostPolicyMessage(message) &&
				(message as AgentMessage & { clio_coder_policy: { id: string } }).clio_coder_policy.id === id,
		)
	)
		return;
	agent.state.messages = [...agent.state.messages, createHostPolicyMessage(id, content, timestamp)];
}

const pinnedPrefixes = new WeakMap<Agent, PinnedPromptPrefix>();

export function enginePinnedPrefix(agent: Agent): PinnedPromptPrefix | undefined {
	return pinnedPrefixes.get(agent);
}

export function setEngineSystemPrompt(agent: Agent, systemPrompt: string, pinnedPrefix?: PinnedPromptPrefix): void {
	if (pinnedPrefix) pinnedPrefixes.set(agent, pinnedPrefix);
	else pinnedPrefixes.delete(agent);
	if (engineInitialSystemPrompt(agent) !== systemPrompt)
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
