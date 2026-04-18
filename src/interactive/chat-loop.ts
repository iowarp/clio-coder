import { type ClioSettings, settingsPath } from "../core/config.js";
import type { EndpointSpec, LocalProvidersSettings } from "../core/defaults.js";
import type { ToolName } from "../core/tool-names.js";
import type { ModesContract } from "../domains/modes/contract.js";
import { isLocalEngineId } from "../domains/providers/catalog.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import { AutoCompactionTrigger, shouldCompact } from "../domains/session/compaction/auto.js";
import type { CompactResult } from "../domains/session/compaction/compact.js";
import { calculateContextTokens } from "../domains/session/compaction/tokens.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { createEngineAgent } from "../engine/agent.js";
import {
	resolveLocalModelId,
	getModel as resolveModel,
	registerLocalProviders as seedLocalProviders,
} from "../engine/ai.js";
import type { AgentEvent, AgentMessage, Model } from "../engine/types.js";
import { resolveAgentTools } from "../engine/worker-tools.js";
import { renderCompactionSummaryLine } from "./renderers/compaction-summary.js";

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
	/**
	 * Return the current session's entries for token estimation. The chat-loop
	 * calls this on every submit so the auto-compaction threshold sees the
	 * latest transcript. Returns an empty array when there is no current
	 * session or when the session contract is absent.
	 */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/**
	 * Run the compaction flow end-to-end (read entries, resolve model,
	 * summarize, persist a compactionSummary entry) and return the result,
	 * or null when the flow is a no-op (no entries, no cut crossed, no model
	 * configured). Chat-loop invokes this from two sites:
	 *   1. Before every agent.prompt when the threshold is crossed or
	 *      CLIO_FORCE_COMPACT=1 is set.
	 *   2. After catching a ContextOverflowError, as the first half of the
	 *      one-shot compact-and-retry recovery path.
	 * Both sites share an AutoCompactionTrigger so two fires in the same tick
	 * coalesce onto one summarization call.
	 */
	autoCompact?: (instructions?: string) => Promise<CompactResult | null>;
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

/**
 * Bridge message injected into the agent's in-memory `state.messages` after
 * a compaction run. Prior turns are dropped; the single synthetic user
 * message frames the summary as "prior context" and instructs the LLM to
 * continue from there. pi-agent-core appends the real user text next so the
 * final prompt sent to the model is [bridge, newUserText].
 */
function buildCompactionBridgeMessage(summary: string): AgentMessage {
	const text = [
		"<prior-context-summary>",
		summary,
		"</prior-context-summary>",
		"",
		"The above summary replaces earlier conversation to save tokens. Continue from here.",
	].join("\n");
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

export function createChatLoop(deps: CreateChatLoopDeps): ChatLoop {
	const listeners = new Set<(event: ChatLoopEvent) => void>();
	const getModel = deps.getModel ?? resolveModel;
	const registerLocalProviders = deps.registerLocalProviders ?? seedLocalProviders;
	const createAgent = deps.createAgent ?? createEngineAgent;
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();
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

	/**
	 * Evaluate the auto-compaction trigger against the current session and,
	 * when it fires, swap `agent.state.messages` for a single bridge message
	 * carrying the summary. Returns true when compaction ran AND produced a
	 * non-empty summary; false otherwise (no deps wired, threshold not
	 * crossed, no-op compaction, etc.). Throws are caller-contained.
	 *
	 * `force = true` bypasses the threshold check. Used for:
	 *   - CLIO_FORCE_COMPACT=1 (deterministic drills / e2e tests).
	 *   - The overflow-recovery retry path after a ContextOverflowError.
	 */
	const runAutoCompact = async (agentRuntime: AgentRuntime, force: boolean, instructions?: string): Promise<boolean> => {
		if (!deps.autoCompact || !deps.readSessionEntries) return false;
		const settings = deps.getSettings();
		const cfg = settings.compaction;
		const autoEnabled = cfg?.auto !== false;
		if (!force && !autoEnabled) return false;

		if (!force) {
			const modelState = agentRuntime.agent.state.model as { contextWindow?: number } | undefined;
			const contextWindow = typeof modelState?.contextWindow === "number" ? modelState.contextWindow : 0;
			const threshold = typeof cfg?.threshold === "number" ? cfg.threshold : 0.8;
			const entries = deps.readSessionEntries();
			const tokens = calculateContextTokens(entries);
			if (!shouldCompact(tokens, threshold, contextWindow)) return false;
		}

		const result = await compactionTrigger.fire(() => (deps.autoCompact ?? (async () => null))(instructions));
		if (!result || result.summary.length === 0) return false;

		agentRuntime.agent.state.messages = [buildCompactionBridgeMessage(result.summary)];

		emitNotice(
			renderCompactionSummaryLine({
				messagesSummarized: result.messagesSummarized,
				summaryChars: result.summary.length,
				tokensBefore: result.tokensBefore,
				isSplitTurn: result.isSplitTurn,
			}),
		);
		return true;
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

			// Pre-submit auto-compaction trigger. CLIO_FORCE_COMPACT=1 bypasses
			// the threshold so /compact integration tests and live drills can
			// force a run without driving real token usage. Compaction failures
			// here are non-fatal: the user's turn still goes through, possibly
			// oversized — the overflow-recovery path will catch that.
			const forceNow = process.env.CLIO_FORCE_COMPACT === "1";
			try {
				await runAutoCompact(agentRuntime, forceNow);
			} catch (err) {
				emitNotice(`[clio] auto-compaction skipped: ${err instanceof Error ? err.message : String(err)}`);
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
				// One-shot compact-and-retry on context overflow. See
				// src/domains/providers/errors.ts for the detection heuristic;
				// anything that does not match falls through as a plain notice.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					emitNotice(err instanceof Error ? err.message : String(err));
					return;
				}
				let compacted = false;
				try {
					compacted = await runAutoCompact(agentRuntime, true);
				} catch (compactErr) {
					emitNotice(
						`[clio] compact-on-overflow failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
					);
				}
				if (!compacted) {
					emitNotice(`[clio] context overflow: ${overflow.message}`);
					return;
				}
				try {
					await agentRuntime.agent.prompt(text);
				} catch (retryErr) {
					emitNotice(
						`[clio] context overflow persisted after compaction: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					);
				}
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
