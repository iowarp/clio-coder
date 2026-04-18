import { type ClioSettings, settingsPath } from "../core/config.js";
import type { EndpointSpec, LocalProvidersSettings } from "../core/defaults.js";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import { isLocalEngineId } from "../domains/providers/catalog.js";
import type { SessionContract } from "../domains/session/contract.js";
import { createEngineAgent } from "../engine/agent.js";
import {
	resolveLocalModelId,
	getModel as resolveModel,
	registerLocalProviders as seedLocalProviders,
} from "../engine/ai.js";
import type { AgentEvent, AgentMessage, Model } from "../engine/types.js";
import { resolveAgentTools } from "../engine/worker-tools.js";

type AssistantDeltaEvent =
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partialText: string;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partialThinking: string;
	  };

export type ChatLoopEvent = AgentEvent | AssistantDeltaEvent;

export interface ChatLoop {
	submit(text: string): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: ChatLoopEvent) => void): () => void;
	getSessionId(): string | null;
	isStreaming(): boolean;
}

export interface CreateChatLoopDeps {
	getSettings: () => Readonly<ClioSettings>;
	modes: ModesContract;
	knownProviders: () => ReadonlySet<string>;
	session?: SessionContract;
	getModel?: (providerId: string, modelId: string) => Model<never>;
	registerLocalProviders?: (providers: Partial<LocalProvidersSettings>) => void;
	createAgent?: typeof createEngineAgent;
}

interface AgentRuntime {
	agent: ReturnType<typeof createEngineAgent>["agent"];
	providerId: string;
	modelId: string;
}

function notConfiguredNotice(): string {
	return `[clio] orchestrator not configured. Edit ${settingsPath()} (orchestrator.* block) to enable chat.`;
}

const LOCAL_API_KEY_FALLBACK = "clio-local-endpoint";

function envApiKeyName(providerId: string): string {
	return `${providerId.replaceAll("-", "_").toUpperCase()}_API_KEY`;
}

function extractText(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

function extractThinking(message: AgentMessage | undefined): string {
	if (
		!message ||
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant"
	) {
		return "";
	}
	const content = "content" in message && Array.isArray(message.content) ? message.content : [];
	return content
		.filter(
			(item): item is { type: "thinking"; thinking: string } =>
				item?.type === "thinking" && typeof item.thinking === "string",
		)
		.map((item) => item.thinking)
		.join("");
}

function noticeMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function orchestratorPrompt(): string {
	return [
		"You are clio, the orchestrator agent inside the Clio coding harness.",
		"Use available tools to read and edit the workspace, inspect commands, and coordinate worker subagents through the harness when needed.",
		"You are clio. Do not present yourself as Claude, GPT, or a generic chatbot.",
	].join(" ");
}

function visibleToolSnapshot(modes: ModesContract): ToolName[] {
	return Array.from(modes.visibleTools());
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const getModel = deps.getModel ?? resolveModel;
	const registerLocalProviders = deps.registerLocalProviders ?? seedLocalProviders;
	const createAgent = deps.createAgent ?? createEngineAgent;
	let runtime: AgentRuntime | null = null;
	let lastTurnId: string | null = null;
	let streaming = false;

	const emit = (event: ChatLoopEvent): void => {
		for (const listener of listeners) {
			listener(event);
		}
	};

	const appendAssistantTurn = (message: AgentMessage): void => {
		const text = extractText(message).trim();
		if (!deps.session || text.length === 0) return;
		const turn = deps.session.append({
			kind: "assistant",
			parentId: lastTurnId,
			payload: { text },
		});
		lastTurnId = turn.id;
	};

	const emitNotice = (text: string): void => {
		const message = noticeMessage(text);
		emit({ type: "message_end", message });
		emit({ type: "agent_end", messages: [message] });
	};

	const readTarget = (): {
		providerId: string;
		modelId: string;
		endpointName: string | undefined;
		endpointSpec: EndpointSpec | undefined;
	} | null => {
		const settings = deps.getSettings();
		const providerId = settings.orchestrator.provider?.trim();
		const rawModelId = settings.orchestrator.model?.trim();
		if (!providerId || !rawModelId) return null;

		const endpointName = settings.orchestrator.endpoint?.trim();
		let endpointSpec: EndpointSpec | undefined;
		if (isLocalEngineId(providerId)) {
			if (!endpointName) return null;
			endpointSpec = settings.providers[providerId]?.endpoints?.[endpointName];
			if (!endpointSpec) {
				throw new Error(`[clio] orchestrator endpoint=${endpointName} not found under providers.${providerId}.endpoints.`);
			}
			registerLocalProviders({
				[providerId]: { endpoints: { [endpointName]: endpointSpec } },
			} as Partial<LocalProvidersSettings>);
		}

		const modelId = resolveLocalModelId(providerId, rawModelId, endpointName ?? undefined);

		return { providerId, modelId, endpointName, endpointSpec };
	};

	const ensureRuntime = (): AgentRuntime | null => {
		const target = readTarget();
		if (!target) return null;
		if (!deps.knownProviders().has(target.providerId)) {
			throw new Error(
				`[clio] orchestrator provider=${target.providerId} unknown. Run \`clio providers\` to see configured engines.`,
			);
		}
		if (runtime && runtime.providerId === target.providerId && runtime.modelId === target.modelId) {
			return runtime;
		}

		const model = getModel(target.providerId, target.modelId);
		const tools = resolveAgentTools(visibleToolSnapshot(deps.modes), deps.modes.current());
		const thinkingLevel = deps.getSettings().orchestrator.thinkingLevel ?? "off";
		const handle = createAgent({
			initialState: {
				systemPrompt: orchestratorPrompt(),
				model,
				thinkingLevel,
				tools,
				messages: [],
			},
			getApiKey: async (provider) => {
				if (target.endpointSpec?.api_key && target.endpointSpec.api_key.length > 0) {
					return target.endpointSpec.api_key;
				}
				return process.env[envApiKeyName(provider)] ?? (target.endpointSpec ? LOCAL_API_KEY_FALLBACK : undefined);
			},
		});

		handle.agent.subscribe(async (event) => {
			emit(event);
			if (event.type === "message_update") {
				const assistantEvent = event.assistantMessageEvent as {
					type: string;
					contentIndex?: number;
					delta?: string;
					partial?: AgentMessage;
				};
				if (assistantEvent.type === "text_delta") {
					emit({
						type: "text_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialText: extractText(assistantEvent.partial),
					});
				}
				if (assistantEvent.type === "thinking_delta") {
					emit({
						type: "thinking_delta",
						contentIndex: assistantEvent.contentIndex ?? 0,
						delta: assistantEvent.delta ?? "",
						partialThinking: extractThinking(assistantEvent.partial),
					});
				}
			}
			if (event.type === "message_end") {
				appendAssistantTurn(event.message);
			}
		});

		runtime = {
			agent: handle.agent,
			providerId: target.providerId,
			modelId: target.modelId,
		};
		return runtime;
	};

	return {
		async submit(text: string): Promise<void> {
			if (streaming) {
				emitNotice("[clio] response already in progress. Press Esc to cancel the active run.");
				return;
			}

			let agentRuntime: AgentRuntime | null;
			try {
				agentRuntime = ensureRuntime();
			} catch (err) {
				emitNotice(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!agentRuntime) {
				emitNotice(notConfiguredNotice());
				return;
			}

			if (deps.session) {
				if (!deps.session.current()) {
					deps.session.create({
						cwd: process.cwd(),
						provider: agentRuntime.providerId,
						model: agentRuntime.modelId,
					});
				}
				const userTurn = deps.session.append({
					kind: "user",
					parentId: lastTurnId,
					payload: { text },
				});
				lastTurnId = userTurn.id;
				const sessionId = deps.session.current()?.id ?? null;
				if (sessionId) {
					agentRuntime.agent.sessionId = sessionId;
				}
			}

			agentRuntime.agent.state.tools = resolveAgentTools(visibleToolSnapshot(deps.modes), deps.modes.current());

			streaming = true;
			try {
				await agentRuntime.agent.prompt(text);
			} catch (err) {
				emitNotice(err instanceof Error ? err.message : String(err));
			} finally {
				streaming = false;
			}
		},
		cancel(): void {
			runtime?.agent.abort();
		},
		onEvent(handler: (event: ChatLoopEvent) => void): () => void {
			listeners.add(handler);
			return () => {
				listeners.delete(handler);
			};
		},
		getSessionId(): string | null {
			return deps.session?.current()?.id ?? null;
		},
		isStreaming(): boolean {
			return streaming;
		},
	};
}
